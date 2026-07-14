import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BaseToolHandler } from '../../../handlers/core/BaseToolHandler.js';
import { OAuth2Client } from 'google-auth-library';
import { GaxiosError } from 'gaxios';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { BROKER_ACCOUNT_ID, BROKER_BEARER_ENV, createBrokerAccount } from '../../../auth/brokerBearer.js';

const providerState = vi.hoisted(() => ({
  calendar: vi.fn(),
  getCredentialsProjectId: vi.fn()
}));

vi.mock('googleapis', () => ({
  google: { calendar: providerState.calendar }
}));

vi.mock('../../../auth/utils.js', () => ({
  getCredentialsProjectId: providerState.getCredentialsProjectId
}));

// Concrete implementation for testing
class TestHandler extends BaseToolHandler<{ account?: string; testParam: string }> {
  async runTool(args: { account?: string; testParam: string }, accounts: Map<string, OAuth2Client>) {
    const client = this.getClientForAccount(args.account, accounts);
    return {
      content: [
        {
          type: 'text' as const,
          text: `Used account: ${args.account || 'default'}, client exists: ${!!client}`
        }
      ]
    };
  }

  getCalendarForTest(client: OAuth2Client) {
    return this.getCalendar(client);
  }

  handleGoogleApiErrorForTest(error: unknown): never {
    return this.handleGoogleApiError(error);
  }

  resolveCalendarIdForTest(client: OAuth2Client, nameOrId: string): Promise<string> {
    return this.resolveCalendarId(client, nameOrId);
  }

  resolveCalendarIdsForTest(client: OAuth2Client, namesOrIds: string[]): Promise<string[]> {
    return this.resolveCalendarIds(client, namesOrIds);
  }

  throwNoCalendarsFoundErrorForTest(
    requestedCalendars: string[],
    selectedAccounts: Map<string, OAuth2Client>
  ): Promise<never> {
    return this.throwNoCalendarsFoundError(requestedCalendars, selectedAccounts);
  }
}

describe('BaseToolHandler - Multi-Account Support', () => {
  let handler: TestHandler;
  let workClient: OAuth2Client;
  let personalClient: OAuth2Client;
  let accounts: Map<string, OAuth2Client>;

  beforeEach(() => {
    vi.clearAllMocks();
    providerState.calendar.mockReturnValue({});
    providerState.getCredentialsProjectId.mockReturnValue('interactive-quota-project');
    handler = new TestHandler();
    workClient = new OAuth2Client('client-id', 'client-secret', 'redirect-uri');
    personalClient = new OAuth2Client('client-id', 'client-secret', 'redirect-uri');

    workClient.setCredentials({ access_token: 'work-token' });
    personalClient.setCredentials({ access_token: 'personal-token' });

    accounts = new Map([
      ['work', workClient],
      ['personal', personalClient]
    ]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('getClientForAccount', () => {
    it('should return specified account client', () => {
      const client = handler.getClientForAccount('work', accounts);
      expect(client).toBe(workClient);
      expect(client.credentials.access_token).toBe('work-token');
    });

    it('should return different client for different account', () => {
      const client = handler.getClientForAccount('personal', accounts);
      expect(client).toBe(personalClient);
      expect(client.credentials.access_token).toBe('personal-token');
    });

    it('should return first account when no account specified and single account exists', () => {
      const singleAccount = new Map([['work', workClient]]);
      const client = handler.getClientForAccount(undefined, singleAccount);
      expect(client).toBe(workClient);
    });

    it('should throw error when no account specified and multiple accounts exist', () => {
      expect(() => handler.getClientForAccount(undefined, accounts))
        .toThrow(/must specify.*account.*parameter/i);
    });

    it('should throw error when no accounts available', () => {
      expect(() => handler.getClientForAccount(undefined, new Map()))
        .toThrow(/no authenticated accounts/i);
    });

    it('should throw error when specified account does not exist', () => {
      expect(() => handler.getClientForAccount('nonexistent', accounts))
        .toThrow(/account.*nonexistent.*not found/i);
    });

    it('should validate account ID format', () => {
      expect(() => handler.getClientForAccount('../../../etc/passwd', accounts))
        .toThrow(/invalid account id/i);
    });
  });

  describe('runTool with account parameter', () => {
    it('should execute with specified account', async () => {
      const result = await handler.runTool(
        { account: 'work', testParam: 'test' },
        accounts
      );

      expect(result.content[0].text).toContain('Used account: work');
      expect(result.content[0].text).toContain('client exists: true');
    });

    it('should execute with default account when single account exists', async () => {
      const singleAccount = new Map([['work', workClient]]);
      const result = await handler.runTool(
        { testParam: 'test' },
        singleAccount
      );

      expect(result.content[0].text).toContain('client exists: true');
    });

    it('should fail when no account specified with multiple accounts', async () => {
      await expect(
        handler.runTool({ testParam: 'test' }, accounts)
      ).rejects.toThrow(/must specify.*account/i);
    });
  });

  describe('Account isolation', () => {
    it('should use correct tokens for different accounts', () => {
      const workClient = handler.getClientForAccount('work', accounts);
      const personalClient = handler.getClientForAccount('personal', accounts);

      expect(workClient.credentials.access_token).toBe('work-token');
      expect(personalClient.credentials.access_token).toBe('personal-token');
      expect(workClient).not.toBe(personalClient);
    });

    it('does not read legacy OAuth credentials when constructing a broker calendar client', () => {
      const brokerClient = createBrokerAccount('broker-access-token').get(BROKER_ACCOUNT_ID)!;

      handler.getCalendarForTest(brokerClient);

      expect(providerState.getCredentialsProjectId).not.toHaveBeenCalled();
      expect(providerState.calendar.mock.calls[0][0]).not.toHaveProperty('quotaProjectId');
    });

    it('preserves quota project lookup for interactive OAuth clients', () => {
      handler.getCalendarForTest(workClient);

      expect(providerState.getCredentialsProjectId).toHaveBeenCalledTimes(1);
      expect(providerState.calendar).toHaveBeenCalledWith(expect.objectContaining({
        quotaProjectId: 'interactive-quota-project'
      }));
    });
  });

  describe('provider error sanitization', () => {
    const createProviderError = () => {
      const error = new GaxiosError(
        'gaxios-message-sentinel',
        {} as any,
        { status: 403 } as any
      );
      error.response!.data = {
        error: {
          message: 'provider-payload-sentinel',
          event: { summary: 'private-event-sentinel' }
        }
      };
      return error;
    };

    it('returns only a normalized MCP category and HTTP status in broker mode', () => {
      vi.stubEnv(BROKER_BEARER_ENV, 'broker-token');

      let caught: unknown;
      try {
        handler.handleGoogleApiErrorForTest(createProviderError());
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(McpError);
      expect((caught as McpError).code).toBe(ErrorCode.InvalidRequest);
      expect((caught as McpError).message).toContain('Google Calendar access was denied (HTTP 403).');
      expect(String(caught)).not.toContain('provider-payload-sentinel');
      expect(JSON.stringify(caught)).not.toContain('private-event-sentinel');
      expect(JSON.stringify(caught)).not.toContain('gaxios-message-sentinel');
    });

    it('does not return internal error text in broker mode', () => {
      vi.stubEnv(BROKER_BEARER_ENV, 'broker-token');

      expect(() => handler.handleGoogleApiErrorForTest(new Error('internal-error-sentinel')))
        .toThrow('Google Calendar request failed.');
      try {
        handler.handleGoogleApiErrorForTest(new Error('internal-error-sentinel'));
      } catch (error) {
        expect(String(error)).not.toContain('internal-error-sentinel');
      }
    });

    it('preserves upstream provider diagnostics outside broker mode', () => {
      vi.stubEnv(BROKER_BEARER_ENV, '');

      expect(() => handler.handleGoogleApiErrorForTest(createProviderError()))
        .toThrow('Access denied: provider-payload-sentinel');
    });
  });

  describe('calendar resolution error sanitization', () => {
    const providerCalendars = [
      {
        id: 'private-calendar-id-sentinel@example.com',
        summary: 'private-calendar-summary-sentinel',
        summaryOverride: 'private-calendar-override-sentinel'
      }
    ];
    const brokerMessage = "Requested calendar was not found. Use 'list-calendars' to see available calendars.";

    const mockCalendarList = () => {
      providerState.calendar.mockReturnValue({
        calendarList: {
          list: vi.fn().mockResolvedValue({ data: { items: providerCalendars } })
        }
      });
    };

    const expectSanitizedBrokerError = async (operation: Promise<unknown>) => {
      const error = await operation.catch(caught => caught);
      expect(error).toBeInstanceOf(McpError);
      expect((error as McpError).code).toBe(ErrorCode.InvalidRequest);
      expect((error as McpError).message).toContain(brokerMessage);
      expect(JSON.stringify(error)).not.toContain('private-calendar-id-sentinel');
      expect(JSON.stringify(error)).not.toContain('private-calendar-summary-sentinel');
      expect(JSON.stringify(error)).not.toContain('private-calendar-override-sentinel');
    };

    it('sanitizes single-calendar lookup failures in broker mode', async () => {
      vi.stubEnv(BROKER_BEARER_ENV, 'broker-token');
      mockCalendarList();

      await expectSanitizedBrokerError(
        handler.resolveCalendarIdForTest(workClient, 'missing-calendar')
      );
    });

    it('sanitizes multi-calendar lookup failures in broker mode', async () => {
      vi.stubEnv(BROKER_BEARER_ENV, 'broker-token');
      mockCalendarList();

      await expectSanitizedBrokerError(
        handler.resolveCalendarIdsForTest(workClient, ['missing-calendar'])
      );
    });

    it('sanitizes the no-calendar branch without loading provider metadata in broker mode', async () => {
      vi.stubEnv(BROKER_BEARER_ENV, 'broker-token');
      const getUnifiedCalendars = vi.fn().mockResolvedValue([
        {
          calendarId: providerCalendars[0].id,
          displayName: providerCalendars[0].summary,
          accounts: [],
          preferredAccount: 'work'
        }
      ]);
      (handler as any).calendarRegistry = { getUnifiedCalendars };

      await expectSanitizedBrokerError(
        handler.throwNoCalendarsFoundErrorForTest(['missing-calendar'], accounts)
      );
      expect(getUnifiedCalendars).not.toHaveBeenCalled();
    });

    it('preserves detailed single-calendar diagnostics outside broker mode', async () => {
      mockCalendarList();

      await expect(handler.resolveCalendarIdForTest(workClient, 'missing-calendar'))
        .rejects.toThrow('private-calendar-override-sentinel');
    });

    it('preserves detailed multi-calendar diagnostics outside broker mode', async () => {
      mockCalendarList();

      await expect(handler.resolveCalendarIdsForTest(workClient, ['missing-calendar']))
        .rejects.toThrow('private-calendar-id-sentinel@example.com');
    });

    it('preserves detailed no-calendar diagnostics outside broker mode', async () => {
      (handler as any).calendarRegistry = {
        getUnifiedCalendars: vi.fn().mockResolvedValue([
          {
            calendarId: providerCalendars[0].id,
            displayName: providerCalendars[0].summary,
            accounts: [],
            preferredAccount: 'work'
          }
        ])
      };

      await expect(handler.throwNoCalendarsFoundErrorForTest(['missing-calendar'], accounts))
        .rejects.toThrow('private-calendar-summary-sentinel');
    });
  });
});
