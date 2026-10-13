import { db } from '../db/index.js';
import { decrypt, encrypt } from '../lib/crypto.js';

export type Provider = 'square' | 'highlevel' | 'sms';

export interface IntegrationRow {
  provider: Provider;
  status: string;
  meta: Record<string, any>;
  last_sync_at: Date | null;
  last_sync_status: string | null;
  last_sync_message: string | null;
  encrypted_credentials: string | null;
}

export async function getIntegration(provider: Provider): Promise<IntegrationRow | null> {
  return db().one<IntegrationRow>('SELECT * FROM integrations WHERE provider = $1', [provider]);
}

export async function upsertIntegration(
  provider: Provider,
  patch: { status?: string; meta?: Record<string, any>; credentials?: Record<string, any> | null },
) {
  const existing = await getIntegration(provider);
  const meta = { ...(existing?.meta ?? {}), ...(patch.meta ?? {}) };
  const creds =
    patch.credentials === undefined
      ? existing?.encrypted_credentials ?? null
      : patch.credentials === null
        ? null
        : encrypt(JSON.stringify(patch.credentials));
  await db().query(
    `INSERT INTO integrations(provider, status, meta, encrypted_credentials, updated_at)
     VALUES ($1, $2, $3::jsonb, $4, now())
     ON CONFLICT (provider) DO UPDATE SET status = EXCLUDED.status, meta = EXCLUDED.meta,
       encrypted_credentials = EXCLUDED.encrypted_credentials, updated_at = now()`,
    [provider, patch.status ?? existing?.status ?? 'disconnected', JSON.stringify(meta), creds],
  );
}

export async function getCredentials<T = Record<string, any>>(provider: Provider): Promise<T | null> {
  const row = await getIntegration(provider);
  if (!row?.encrypted_credentials) return null;
  try {
    return JSON.parse(decrypt(row.encrypted_credentials)) as T;
  } catch {
    console.error(`[integrations] could not decrypt ${provider} credentials (ENCRYPTION_KEY changed?)`);
    return null;
  }
}

export async function recordSync(provider: Provider, ok: boolean, message: string | null) {
  await db().query(
    `INSERT INTO integrations(provider, status, last_sync_at, last_sync_status, last_sync_message, last_error_at)
     VALUES ($1, 'connected', now(), $2, $3, CASE WHEN $2 = 'failed' THEN now() END)
     ON CONFLICT (provider) DO UPDATE SET
       last_sync_at = CASE WHEN $2 = 'ok' THEN now() ELSE integrations.last_sync_at END,
       last_sync_status = $2, last_sync_message = $3,
       last_error_at = CASE WHEN $2 = 'failed' THEN now() ELSE integrations.last_error_at END,
       updated_at = now()`,
    [provider, ok ? 'ok' : 'failed', message],
  );
}
