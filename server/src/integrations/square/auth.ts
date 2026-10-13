import { config, squareBaseUrl } from '../../config.js';
import { randomToken } from '../../lib/crypto.js';
import { IntegrationError } from '../../lib/errors.js';
import { getCredentials, upsertIntegration } from '../../repos/integrations.js';
import { setKV, getKV } from '../../repos/settings.js';

/** Read-only scopes this app requests. It never writes to Square. */
export const SQUARE_SCOPES = [
  'APPOINTMENTS_READ',
  'INVENTORY_READ',
  'INVENTORY_WRITE',
  'APPOINTMENTS_ALL_READ',
  'CUSTOMERS_READ',
  'EMPLOYEES_READ',
  'ITEMS_READ',
  'MERCHANT_PROFILE_READ',
  'ORDERS_READ', // commission: sales, discounts and refunds
  'PAYMENTS_READ', // commission: tips and the team member who took each payment
];

interface SquareOAuthCreds {
  access_token: string;
  refresh_token?: string;
  expires_at?: string;
  merchant_id?: string;
}

export const squareRedirectUri = () => `${config().APP_URL.replace(/\/$/, '')}/api/integrations/square/callback`;

export async function buildAuthorizeUrl(): Promise<string> {
  const cfg = config();
  if (!cfg.SQUARE_APPLICATION_ID || !cfg.SQUARE_APPLICATION_SECRET) {
    throw new IntegrationError('square', 'Square app credentials are not configured on the server yet (SQUARE_APPLICATION_ID / SQUARE_APPLICATION_SECRET).', false);
  }
  const state = randomToken(24);
  await setKV('square.oauthState', { state, createdAt: Date.now() });
  const qs = new URLSearchParams({
    client_id: cfg.SQUARE_APPLICATION_ID,
    scope: SQUARE_SCOPES.join(' '),
    session: 'false',
    state,
    redirect_uri: squareRedirectUri(),
  });
  return `${squareBaseUrl(cfg)}/oauth2/authorize?${qs}`;
}

export async function handleCallback(code: string, state: string) {
  const saved = await getKV<{ state: string; createdAt: number }>('square.oauthState');
  if (!saved || saved.state !== state || Date.now() - saved.createdAt > 15 * 60_000) {
    throw new IntegrationError('square', 'The Square connection link expired. Please try connecting again.', false);
  }
  await setKV('square.oauthState', null);
  const tokens = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: squareRedirectUri() });
  await upsertIntegration('square', {
    status: 'connected',
    credentials: tokens,
    meta: { mode: 'oauth', merchantId: tokens.merchant_id, connectedAt: new Date().toISOString() },
  });
}

async function tokenRequest(body: Record<string, string>): Promise<SquareOAuthCreds> {
  const cfg = config();
  const res = await fetch(`${squareBaseUrl(cfg)}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Square-Version': cfg.SQUARE_API_VERSION },
    body: JSON.stringify({ client_id: cfg.SQUARE_APPLICATION_ID, client_secret: cfg.SQUARE_APPLICATION_SECRET, ...body }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new IntegrationError('square', 'Square connection expired. Please reconnect.', false, true, JSON.stringify(json.errors ?? res.status));
  }
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: json.expires_at,
    merchant_id: json.merchant_id,
  };
}

/**
 * Returns a valid access token: the server-side personal access token if configured,
 * otherwise the stored OAuth token (refreshed automatically when it's within 7 days of expiry).
 */
export async function getSquareAccessToken(): Promise<string> {
  const cfg = config();
  if (cfg.SQUARE_ACCESS_TOKEN) return cfg.SQUARE_ACCESS_TOKEN;
  const creds = await getCredentials<SquareOAuthCreds>('square');
  if (!creds?.access_token) throw new IntegrationError('square', 'Square is not connected.', false, true);
  const expires = creds.expires_at ? new Date(creds.expires_at).getTime() : Infinity;
  if (expires - Date.now() < 7 * 24 * 3600_000 && creds.refresh_token) {
    try {
      const fresh = await tokenRequest({ grant_type: 'refresh_token', refresh_token: creds.refresh_token });
      await upsertIntegration('square', { status: 'connected', credentials: { ...creds, ...fresh } });
      return fresh.access_token;
    } catch (e) {
      if (expires < Date.now()) {
        await upsertIntegration('square', { status: 'needs_reconnect' });
        throw e;
      }
    }
  }
  return creds.access_token;
}

export async function disconnectSquare() {
  const cfg = config();
  const creds = await getCredentials<SquareOAuthCreds>('square');
  if (creds?.access_token && cfg.SQUARE_APPLICATION_ID && cfg.SQUARE_APPLICATION_SECRET) {
    // Best effort revoke; local data is kept either way.
    await fetch(`${squareBaseUrl(cfg)}/oauth2/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Client ${cfg.SQUARE_APPLICATION_SECRET}`, 'Square-Version': cfg.SQUARE_API_VERSION },
      body: JSON.stringify({ client_id: cfg.SQUARE_APPLICATION_ID, access_token: creds.access_token }),
    }).catch(() => undefined);
  }
  await upsertIntegration('square', { status: 'disconnected', credentials: null });
}
