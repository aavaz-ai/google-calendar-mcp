import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OAuth2Client } from 'google-auth-library';

const state = vi.hoisted(() => ({
  calendar: vi.fn(),
  calendarList: vi.fn()
}));

vi.mock('@googleapis/calendar', () => ({
  calendar: state.calendar
}));

import {
  BROKER_ACCOUNT_ID,
  BROKER_BEARER_ENV,
  BROKER_PROBE_TIMEOUT_MS,
  createBrokerAccount,
  isBrokerBearerMode,
  isBrokerOAuthClient,
  probeBrokerCalendarAccess,
  readBrokerBearer
} from '../../../auth/brokerBearer.js';

describe('broker bearer authentication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.calendar.mockReturnValue({
      calendarList: { list: state.calendarList }
    });
    state.calendarList.mockResolvedValue({ data: { items: [] } });
  });

  it('returns no bearer only when the broker variable is absent', () => {
    expect(readBrokerBearer({})).toBeUndefined();
  });

  it('reads and trims a present broker bearer', () => {
    expect(readBrokerBearer({ [BROKER_BEARER_ENV]: '  access-token  ' })).toBe('access-token');
  });

  it.each(['', '   ', '\t\n'])('fails closed for a present blank broker bearer', (bearer) => {
    expect(() => readBrokerBearer({ [BROKER_BEARER_ENV]: bearer })).toThrow(
      `${BROKER_BEARER_ENV} is present but empty`
    );
  });

  it('treats only a present non-blank bearer as active broker mode', () => {
    expect(isBrokerBearerMode({})).toBe(false);
    expect(isBrokerBearerMode({ [BROKER_BEARER_ENV]: '   ' })).toBe(false);
    expect(isBrokerBearerMode({ [BROKER_BEARER_ENV]: 'access-token' })).toBe(true);
  });

  it('creates one in-memory account using only the supplied access token', () => {
    const accounts = createBrokerAccount('access-token');

    expect([...accounts.keys()]).toEqual([BROKER_ACCOUNT_ID]);
    expect(accounts.get(BROKER_ACCOUNT_ID)?.credentials).toEqual({ access_token: 'access-token' });
    expect(accounts.get(BROKER_ACCOUNT_ID)?.credentials.refresh_token).toBeUndefined();
  });

  it('marks only broker-created clients so provider setup can avoid legacy credential files', () => {
    const brokerClient = createBrokerAccount('access-token').get(BROKER_ACCOUNT_ID)!;

    expect(isBrokerOAuthClient(brokerClient)).toBe(true);
    expect(isBrokerOAuthClient(new OAuth2Client())).toBe(false);
  });

  it('probes calendar-list access with a bounded request before advertising tools', async () => {
    const oauth2Client = createBrokerAccount('access-token').get(BROKER_ACCOUNT_ID)!;

    await probeBrokerCalendarAccess(oauth2Client);

    expect(state.calendar).toHaveBeenCalledWith({
      version: 'v3',
      auth: oauth2Client,
      timeout: BROKER_PROBE_TIMEOUT_MS
    });
    expect(state.calendarList).toHaveBeenCalledWith({ maxResults: 1 });
  });

  it.each([401, 403])('reports only provider status %s when the access probe fails', async (status) => {
    state.calendarList.mockRejectedValue({
      message: 'provider-message-must-not-leak',
      response: { status, data: { token: 'must-not-leak' } }
    });
    const oauth2Client = createBrokerAccount('access-token').get(BROKER_ACCOUNT_ID)!;

    const error = await probeBrokerCalendarAccess(oauth2Client).catch((caught) => caught);

    expect(error).toEqual(expect.objectContaining({
      message: `Broker-supplied Google Calendar token failed the calendar-list access probe (HTTP ${status})`
    }));
    expect(String(error)).not.toContain('must-not-leak');
    expect(String(error)).not.toContain('provider-message-must-not-leak');
    expect(String(error)).not.toContain('access-token');
  });

  it('does not surface raw network errors without an HTTP status', async () => {
    state.calendarList.mockRejectedValue(
      new Error('network-detail-must-not-leak')
    );
    const oauth2Client = createBrokerAccount('access-token').get(BROKER_ACCOUNT_ID)!;

    const error = await probeBrokerCalendarAccess(oauth2Client).catch((caught) => caught);

    expect(String(error)).toContain(
      'Broker-supplied Google Calendar token failed the calendar-list access probe'
    );
    expect(String(error)).not.toContain('network-detail-must-not-leak');
  });
});
