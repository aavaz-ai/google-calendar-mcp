import { OAuth2Client } from 'google-auth-library';
import { calendar as createCalendarClient } from '@googleapis/calendar';

export const BROKER_BEARER_ENV = 'GOOGLE_CALENDAR_OAUTH_BEARER';
export const BROKER_ACCOUNT_ID = 'default';
export const BROKER_PROBE_TIMEOUT_MS = 10_000;

const brokerOAuthClients = new WeakSet<OAuth2Client>();

export const BROKER_ENABLED_TOOLS = [
  'list-calendars',
  'list-events',
  'search-events',
  'get-event',
  'create-event',
  'update-event',
  'delete-event',
  'get-freebusy',
  'get-current-time',
  'respond-to-event'
] as const;

export function readBrokerBearer(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(env, BROKER_BEARER_ENV)) {
    return undefined;
  }

  const bearer = env[BROKER_BEARER_ENV]?.trim();
  if (!bearer) {
    throw new Error(`${BROKER_BEARER_ENV} is present but empty`);
  }

  return bearer;
}

export function isBrokerBearerMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return Object.prototype.hasOwnProperty.call(env, BROKER_BEARER_ENV) &&
    Boolean(env[BROKER_BEARER_ENV]?.trim());
}

export function createBrokerAccount(bearer: string): Map<string, OAuth2Client> {
  const oauth2Client = new OAuth2Client();
  oauth2Client.setCredentials({ access_token: bearer });
  brokerOAuthClients.add(oauth2Client);
  return new Map([[BROKER_ACCOUNT_ID, oauth2Client]]);
}

export function isBrokerOAuthClient(oauth2Client: OAuth2Client): boolean {
  return brokerOAuthClients.has(oauth2Client);
}

export async function probeBrokerCalendarAccess(oauth2Client: OAuth2Client): Promise<void> {
  try {
    const calendar = createCalendarClient({
      version: 'v3',
      auth: oauth2Client,
      timeout: BROKER_PROBE_TIMEOUT_MS
    });
    await calendar.calendarList.list({ maxResults: 1 });
  } catch (error) {
    const status =
      typeof error === 'object' && error !== null && 'response' in error
        ? (error.response as { status?: unknown } | undefined)?.status
        : undefined;
    const statusSuffix = typeof status === 'number' ? ` (HTTP ${status})` : '';
    throw new Error(`Broker-supplied Google Calendar token failed the calendar-list access probe${statusSuffix}`);
  }
}
