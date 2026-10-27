import { config, envHas, setConfigOverlay } from '../config.js';
import { db } from '../db/index.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import { badRequest } from '../lib/errors.js';
import { setRedactedSecrets } from '../lib/redact.js';

/**
 * Credentials entered by an administrator in Settings → API & Integrations.
 *
 * - Stored encrypted (AES-256-GCM, ENCRYPTION_KEY) in `integration_credentials`; never returned to the browser.
 * - Applied on top of the environment variables of the same name, so every integration that reads `config()`
 *   uses them with no other changes. A saved value wins over the environment.
 * - Secret fields are write-only from the admin screen: it can see whether one is set and where from, never the value.
 */
export type CredentialProvider = 'square' | 'shopify' | 'shopify2' | 'highlevel' | 'highlevel_hair' | 'email' | 'ai' | 'google' | 'instagram';

export interface CredentialField {
  key: string; // environment variable name
  label: string;
  secret: boolean;
  /** Fields in the same group are alternatives: one complete group is enough (e.g. token OR app id + secret). */
  group?: string;
  required?: boolean;
  placeholder?: string;
  help?: string;
  options?: string[];
  validate?: (v: string) => string | null;
}

const myshopify = (v: string) => (/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(v.replace(/^https?:\/\//, '').replace(/\/.*$/, '')) ? null : 'must be the store’s myshopify.com address, e.g. addendumhair.myshopify.com');
const noSpaces = (v: string) => (/\s/.test(v) ? 'must not contain spaces' : null);
// Only used to verify Square's signatures (the CRM never sends anything to it), but it must be this app's webhook path.
const squareWebhookUrl = (v: string) => (/^https:\/\/[^\s/]+\/api\/webhooks\/square$/i.test(v) ? null : 'must be https://<your CRM address>/api/webhooks/square, exactly as registered in Square');
// Only a store's Admin API token works here; other Shopify tokens (atkn_ CLI/app-management, shpss_ secrets) don't.
const shopifyAdminToken = (v: string) => (/^shp(at|ca|pa)_[A-Za-z0-9]+$/.test(v) ? null : 'must be an Admin API token starting with shpat_ — for a Dev Dashboard app, leave this empty and use the Client ID + secret');
const portNum = (v: string) => (/^\d{2,5}$/.test(v) ? null : 'must be a number such as 587');

export const CREDENTIAL_SPECS: Record<CredentialProvider, { label: string; fields: CredentialField[]; requirement: string }> = {
  square: {
    label: 'Square',
    requirement: 'An access token, or an application ID + secret (then press Connect with Square).',
    fields: [
      { key: 'SQUARE_NAME', label: 'Name in the CRM', secret: false, placeholder: 'Salon', help: 'How Square is shown in Inventory Sync (e.g. Salon). Leave empty for “Square”.' },
      { key: 'SQUARE_ENVIRONMENT', label: 'Environment', secret: false, options: ['production', 'sandbox'], help: 'Use production for real salon data.' },
      { key: 'SQUARE_ACCESS_TOKEN', label: 'Access token', secret: true, group: 'token', validate: noSpaces, help: 'Developer Console → your app → Credentials → Production access token. Simplest for a single salon.' },
      { key: 'SQUARE_APPLICATION_ID', label: 'Application ID', secret: false, group: 'oauth', validate: noSpaces, help: 'Developer Console → your app → Credentials. Public identifier, used for “Connect with Square”.' },
      { key: 'SQUARE_APPLICATION_SECRET', label: 'Application secret', secret: true, group: 'oauth', validate: noSpaces, help: 'Developer Console → your app → OAuth → Application secret.' },
      { key: 'SQUARE_WEBHOOK_URL', label: 'Webhook notification URL', secret: false, validate: squareWebhookUrl, placeholder: 'https://addendumsalon.info/api/webhooks/square', help: 'Must match the notification URL in Square Developer Console → Webhooks exactly (Square signs each update with it).' },
      { key: 'SQUARE_WEBHOOK_SIGNATURE_KEY', label: 'Webhook signature key', secret: true, validate: noSpaces, help: 'Developer Console → Webhooks → your subscription → Signature key. Optional: enables instant updates.' },
      { key: 'SQUARE_INVENTORY_LOCATION_ID', label: 'Inventory location ID', secret: false, validate: noSpaces, help: 'Only if Square has more than one location: the location whose stock is synced with Shopify.' },
    ],
  },
  shopify: {
    label: 'Shopify',
    requirement: 'The store’s myshopify.com address, plus either an Admin API access token or an app’s client ID + client secret.',
    fields: [
      { key: 'SHOPIFY_NAME', label: 'Name in the CRM', secret: false, placeholder: 'AH-PRO', help: 'How this store is shown in Inventory Sync. Leave empty for “Shopify”.' },
      { key: 'SHOPIFY_STORE_DOMAIN', label: 'Store address', secret: false, required: true, placeholder: 'addendumhair.myshopify.com', validate: myshopify, help: 'Shopify admin → Settings → Domains → the myshopify.com domain.' },
      { key: 'SHOPIFY_CLIENT_ID', label: 'Client ID', secret: false, group: 'app', validate: noSpaces, help: 'Shopify Dev Dashboard → your app → Settings. Public identifier.' },
      { key: 'SHOPIFY_CLIENT_SECRET', label: 'Client secret', secret: true, group: 'app', validate: noSpaces, help: 'Shopify Dev Dashboard → your app → Settings → Client secret.' },
      { key: 'SHOPIFY_ADMIN_TOKEN', label: 'Admin API access token (older apps only)', secret: true, group: 'token', validate: shopifyAdminToken, placeholder: 'shpat_…', help: 'Leave empty for apps from the Shopify Dev Dashboard (they use the Client ID + secret above). Only for an older custom app made in the store admin, whose token starts with shpat_. If filled in, it is used instead of the Client ID + secret.' },
      { key: 'SHOPIFY_LOCATION_ID', label: 'Inventory location ID', secret: false, validate: noSpaces, help: 'Only if the store has more than one active location.' },
    ],
  },
  shopify2: {
    label: 'Second Shopify store',
    requirement: 'Another store that sells from the same stock with the same SKUs: its myshopify.com address, plus an app’s client ID + client secret (or an Admin API token).',
    fields: [
      { key: 'SHOPIFY2_NAME', label: 'Store name', secret: false, required: true, placeholder: 'Addendum Hair Pro', help: 'How it’s shown in the CRM (Inventory Sync, Analytics).' },
      { key: 'SHOPIFY2_STORE_DOMAIN', label: 'Store address', secret: false, required: true, placeholder: 'addendumhairpro.myshopify.com', validate: myshopify, help: 'That store’s admin → Settings → Domains → the myshopify.com domain.' },
      { key: 'SHOPIFY2_CLIENT_ID', label: 'Client ID', secret: false, group: 'app', validate: noSpaces, help: 'Shopify Dev Dashboard → the app installed on this store → Settings. The same app as the first store works if it’s installed on both.' },
      { key: 'SHOPIFY2_CLIENT_SECRET', label: 'Client secret', secret: true, group: 'app', validate: noSpaces, help: 'Shopify Dev Dashboard → the app → Settings → Client secret.' },
      { key: 'SHOPIFY2_ADMIN_TOKEN', label: 'Admin API access token (older apps only)', secret: true, group: 'token', validate: shopifyAdminToken, placeholder: 'shpat_…', help: 'Leave empty for Dev Dashboard apps.' },
      { key: 'SHOPIFY2_LOCATION_ID', label: 'Inventory location ID', secret: false, validate: noSpaces, help: 'Only if this store has more than one active location.' },
    ],
  },
  highlevel: {
    label: 'GoHighLevel',
    requirement: 'A Private Integration token and the sub-account (location) ID.',
    fields: [
      { key: 'HIGHLEVEL_PRIVATE_TOKEN', label: 'Private Integration token', secret: true, required: true, validate: noSpaces, help: 'HighLevel sub-account → Settings → Private Integrations → Create. Scopes: contacts.readonly, contacts.write, users.readonly, locations.readonly.' },
      { key: 'HIGHLEVEL_LOCATION_ID', label: 'Location (sub-account) ID', secret: false, required: true, validate: noSpaces, help: 'HighLevel sub-account → Settings → Business Profile → Location ID.' },
    ],
  },
  highlevel_hair: {
    label: 'Addendum Hair HighLevel',
    requirement: 'Only if Addendum Hair has its own HighLevel sub-account: its Private Integration token and location ID. Without it, Addendum Hair clients are pulled from the GoHighLevel connection above (by tag).',
    fields: [
      { key: 'HIGHLEVEL_HAIR_PRIVATE_TOKEN', label: 'Private Integration token', secret: true, required: true, validate: noSpaces, help: 'Addendum Hair’s HighLevel sub-account → Settings → Private Integrations → Create. Scopes: contacts.readonly, locations.readonly.' },
      { key: 'HIGHLEVEL_HAIR_LOCATION_ID', label: 'Location (sub-account) ID', secret: false, required: true, validate: noSpaces, help: 'Addendum Hair’s sub-account → Settings → Business Profile → Location ID.' },
    ],
  },
  email: {
    label: 'Email (SMTP)',
    requirement: 'SMTP server, username and password.',
    fields: [
      { key: 'SMTP_HOST', label: 'SMTP server', secret: false, required: true, placeholder: 'smtp.office365.com', validate: noSpaces },
      { key: 'SMTP_PORT', label: 'Port', secret: false, placeholder: '587', validate: portNum },
      { key: 'SMTP_SECURE', label: 'Connection', secret: false, options: ['false', 'true'], help: 'false = STARTTLS on port 587 (most providers); true = SSL on port 465.' },
      { key: 'SMTP_USER', label: 'Username', secret: false, required: true, placeholder: 'info@addendumsalon.com' },
      { key: 'SMTP_PASS', label: 'Password / app password', secret: true, required: true, help: 'Microsoft 365 and Google need SMTP sending allowed for the mailbox (or an app password).' },
      { key: 'EMAIL_FROM', label: 'Send as', secret: false, placeholder: 'Addendum Salon <info@addendumsalon.com>' },
    ],
  },
  google: {
    label: 'Google (Gmail website inquiries)',
    requirement: 'A Google Cloud OAuth client (Web application). The mailbox itself is connected with Google’s sign-in under Settings → Website Inquiries — never with a password here.',
    fields: [
      { key: 'GOOGLE_CLIENT_ID', label: 'OAuth client ID', secret: false, required: true, validate: noSpaces, placeholder: '…apps.googleusercontent.com', help: 'Google Cloud console → APIs & Services → Credentials → Create OAuth client ID (Web application). Enable the Gmail API. Authorized redirect URI: https://<your CRM address>/api/integrations/gmail/callback' },
      { key: 'GOOGLE_CLIENT_SECRET', label: 'OAuth client secret', secret: true, required: true, validate: noSpaces },
    ],
  },
  instagram: {
    label: 'Instagram (Content calendar auto-posting)',
    requirement: 'For each account: an Instagram Business or Creator account linked to a Facebook Page, and a Meta app with instagram_content_publish. Only the accounts you fill in can auto-post; planning works without any.',
    fields: [1, 2, 3].flatMap((n) => [
      { key: `INSTAGRAM_${n}_ACCOUNT_ID`, label: `Account ${n}: Instagram account ID`, secret: false, validate: noSpaces, placeholder: '17841…', help: n === 1 ? 'The Instagram Business account ID (Meta Graph API Explorer → me/accounts → the Page → instagram_business_account). The account names are set in Content calendar → Accounts.' : undefined },
      { key: `INSTAGRAM_${n}_TOKEN`, label: `Account ${n}: access token`, secret: true, validate: noSpaces, help: n === 1 ? 'A long-lived Page access token with instagram_basic and instagram_content_publish (Page tokens made from a long-lived user token don’t expire).' : undefined },
    ]),
  },
  ai: {
    label: 'AI (Anthropic)',
    requirement: 'An Anthropic API key.',
    fields: [
      { key: 'ANTHROPIC_API_KEY', label: 'API key', secret: true, required: true, validate: noSpaces, placeholder: 'sk-ant-…', help: 'console.anthropic.com → API Keys.' },
      { key: 'AI_MODEL', label: 'Model', secret: false, validate: noSpaces, placeholder: 'claude-haiku-5-5' },
    ],
  },
};

export const PROVIDERS = Object.keys(CREDENTIAL_SPECS) as CredentialProvider[];
const isProvider = (p: string): p is CredentialProvider => (PROVIDERS as string[]).includes(p);
export function assertProvider(p: string): CredentialProvider {
  if (!isProvider(p)) throw badRequest('Unknown integration.');
  return p;
}

interface Row {
  provider: string;
  encrypted_values: string | null;
  saved_keys: string[];
  updated_at: Date;
  last_test_at: Date | null;
  last_test_ok: boolean | null;
  last_test_message: string | null;
  last_success_at: Date | null;
  disabled: boolean;
}

let unreadable = new Set<string>();
let disabledProviders = new Set<CredentialProvider>();
/** Switched off in Settings → API & Integrations: its credentials are kept but not used. */
export const isProviderDisabled = (p: CredentialProvider) => disabledProviders.has(p);

function decryptRow(r: Row): Record<string, string> {
  if (!r.encrypted_values) return {};
  try {
    return JSON.parse(decrypt(r.encrypted_values));
  } catch {
    unreadable.add(r.provider);
    console.error(`[credentials] saved ${r.provider} credentials can't be decrypted (was ENCRYPTION_KEY changed?) — re-enter them in Settings → API & Integrations`);
    return {};
  }
}

/** Loads every saved credential into the running config. Called at startup and after each change. */
export async function loadSavedCredentials() {
  unreadable = new Set();
  const rows = await db().query<Row>('SELECT * FROM integration_credentials');
  const all: Record<string, string> = {};
  const blockedKeys: string[] = [];
  disabledProviders = new Set();
  for (const r of rows) {
    if (r.disabled && isProvider(r.provider)) {
      disabledProviders.add(r.provider);
      blockedKeys.push(...CREDENTIAL_SPECS[r.provider].fields.map((f) => f.key));
      continue;
    }
    Object.assign(all, decryptRow(r));
  }
  setConfigOverlay(all, blockedKeys);
  setRedactedSecrets(secretValues(rows));
  onCredentialsChanged.forEach((fn) => fn());
}

/** Integration clients that cache a connection or token register here to be rebuilt when credentials change. */
export const onCredentialsChanged: (() => void)[] = [];

async function getRow(p: CredentialProvider) {
  return db().one<Row>('SELECT * FROM integration_credentials WHERE provider = $1', [p]);
}

/** Effective value of a key (saved value or environment), for server-side checks only. */
const effective = (key: string) => String((config() as unknown as Record<string, unknown>)[key] ?? '').trim();

export function missingRequirements(p: CredentialProvider): string[] {
  const spec = CREDENTIAL_SPECS[p];
  const missing: string[] = [];
  for (const f of spec.fields) if (f.required && !effective(f.key)) missing.push(f.label);
  const groups = [...new Set(spec.fields.filter((f) => f.group).map((f) => f.group!))];
  if (groups.length) {
    const complete = groups.some((g) => spec.fields.filter((f) => f.group === g).every((f) => effective(f.key)));
    if (!complete) missing.push(groups.map((g) => spec.fields.filter((f) => f.group === g).map((f) => f.label).join(' + ')).join(', or '));
  }
  return missing;
}

/** What the admin screen may see: per field whether it's set and where from. Secret values are never included. */
export async function credentialStatus(p: CredentialProvider) {
  const row = await getRow(p);
  const saved = row ? decryptRow(row) : {};
  const spec = CREDENTIAL_SPECS[p];
  const missing = missingRequirements(p);
  const changedSinceTest = !!(row?.last_test_at && row.updated_at > row.last_test_at);
  const status: 'connected' | 'not_configured' | 'error' | 'untested' | 'disabled' =
    row?.disabled ? 'disabled'
    : missing.length ? 'not_configured'
    : !row?.last_test_at || changedSinceTest ? 'untested'
    : row.last_test_ok ? 'connected' : 'error';
  return {
    provider: p,
    label: spec.label,
    requirement: spec.requirement,
    status,
    disabled: !!row?.disabled,
    missing,
    unreadable: unreadable.has(p),
    lastTestAt: row?.last_test_at?.toISOString() ?? null,
    lastTestOk: row?.last_test_ok ?? null,
    lastTestMessage: row?.last_test_message ?? null,
    lastSuccessAt: row?.last_success_at?.toISOString() ?? null,
    updatedAt: row?.encrypted_values ? row.updated_at.toISOString() : null,
    fields: spec.fields.map((f) => {
      const inSaved = saved[f.key] != null && saved[f.key] !== '';
      const source: 'saved' | 'environment' | 'none' = inSaved ? 'saved' : envHas(f.key) ? 'environment' : 'none';
      return {
        key: f.key, label: f.label, secret: f.secret, group: f.group ?? null, required: !!f.required,
        placeholder: f.placeholder ?? null, help: f.help ?? null, options: f.options ?? null,
        set: source !== 'none',
        source,
        // Public identifiers are shown so they can be checked; secrets never leave the server.
        value: f.secret ? null : source === 'none' ? null : effective(f.key),
      };
    }),
  };
}

/**
 * Saves changes. `values[key]`: a string sets it, null removes the saved value (the environment value, if any,
 * applies again), and a key that's left out is unchanged. Returns the names of changed keys (for the audit log).
 */
export async function saveCredentials(p: CredentialProvider, values: Record<string, string | null>, staffId: string) {
  const spec = CREDENTIAL_SPECS[p];
  const allowed = new Map(spec.fields.map((f) => [f.key, f]));
  const row = await getRow(p);
  const current = row ? decryptRow(row) : {};
  const changed: string[] = [];
  for (const [key, raw] of Object.entries(values)) {
    const f = allowed.get(key);
    if (!f) throw badRequest(`${key} isn't a setting for ${spec.label}.`);
    if (raw === null) {
      if (key in current) { delete current[key]; changed.push(key); }
      continue;
    }
    let v = String(raw).trim();
    if (!v) continue; // blank secret box = keep the saved value
    if (v.length > 4000) throw badRequest(`${f.label} is too long.`);
    if (key === 'SHOPIFY_STORE_DOMAIN') v = v.replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
    if (f.options && !f.options.includes(v)) throw badRequest(`${f.label} must be one of: ${f.options.join(', ')}.`);
    const err = f.validate?.(v);
    if (err) throw badRequest(`${f.label} ${err}.`);
    if (current[key] !== v) { current[key] = v; changed.push(key); }
  }
  if (!changed.length) return [];
  const keys = Object.keys(current);
  await db().query(
    `INSERT INTO integration_credentials(provider, encrypted_values, saved_keys, updated_by_staff_id, updated_at)
     VALUES ($1,$2,$3,$4, now())
     ON CONFLICT (provider) DO UPDATE SET encrypted_values = $2, saved_keys = $3, updated_by_staff_id = $4, updated_at = now()`,
    [p, keys.length ? encrypt(JSON.stringify(current)) : null, keys, staffId],
  );
  unreadable.delete(p);
  await loadSavedCredentials();
  return changed;
}

/** Removes every saved credential for an integration. Values in the server environment (if any) still apply. */
export async function removeCredentials(p: CredentialProvider) {
  await db().query(
    `UPDATE integration_credentials SET encrypted_values = NULL, saved_keys = '{}', updated_at = now(),
       last_test_at = NULL, last_test_ok = NULL, last_test_message = NULL WHERE provider = $1`,
    [p],
  );
  await loadSavedCredentials();
}

/** Switch an integration off (credentials kept, not used) or back on. */
export async function setProviderDisabled(p: CredentialProvider, disabled: boolean, staffId: string) {
  await db().query(
    `INSERT INTO integration_credentials(provider, disabled, updated_by_staff_id) VALUES ($1, $2, $3)
     ON CONFLICT (provider) DO UPDATE SET disabled = $2, updated_by_staff_id = $3`,
    [p, disabled, staffId],
  );
  await loadSavedCredentials();
}

/** The saved row exactly as it is (still encrypted), so a failed replacement can be put back untouched. */
export async function snapshotCredentials(p: CredentialProvider) {
  return getRow(p);
}

export async function restoreCredentials(p: CredentialProvider, before: Row | null) {
  if (!before) {
    await db().query('DELETE FROM integration_credentials WHERE provider = $1', [p]);
  } else {
    await db().query(
      `UPDATE integration_credentials SET encrypted_values = $2, saved_keys = $3, updated_at = $4, last_test_at = $5, last_test_ok = $6,
         last_test_message = $7, last_success_at = $8, disabled = $9 WHERE provider = $1`,
      [p, before.encrypted_values, before.saved_keys, before.updated_at, before.last_test_at, before.last_test_ok, before.last_test_message, before.last_success_at, before.disabled],
    );
  }
  unreadable.delete(p);
  await loadSavedCredentials();
}

/** Every secret currently in use (saved or from the environment), so logs can be scrubbed of them. */
function secretValues(rows: Row[]) {
  const out: string[] = [];
  for (const p of PROVIDERS) for (const f of CREDENTIAL_SPECS[p].fields) if (f.secret) { const v = effective(f.key); if (v) out.push(v); }
  for (const r of rows) for (const v of Object.values(decryptQuiet(r))) if (v) out.push(v);
  const c = config();
  for (const v of [c.ENCRYPTION_KEY, c.ENCRYPTION_KEY_PREVIOUS, c.OWNER_PASSWORD, c.OWNER_RECOVERY_PASSWORD, c.DATABASE_URL]) if (v) out.push(v);
  const dbPassword = c.DATABASE_URL?.match(/:\/\/[^:]+:([^@]+)@/)?.[1];
  if (dbPassword) out.push(dbPassword);
  return out;
}
function decryptQuiet(r: Row): Record<string, string> {
  if (!r.encrypted_values) return {};
  try { return JSON.parse(decrypt(r.encrypted_values)); } catch { return {}; }
}

export async function recordTest(p: CredentialProvider, ok: boolean, message: string) {
  await db().query(
    `INSERT INTO integration_credentials(provider, last_test_at, last_test_ok, last_test_message, last_success_at)
     VALUES ($1, now(), $2, $3, CASE WHEN $2 THEN now() END)
     ON CONFLICT (provider) DO UPDATE SET last_test_at = now(), last_test_ok = $2, last_test_message = $3,
       last_success_at = CASE WHEN $2 THEN now() ELSE integration_credentials.last_success_at END`,
    [p, ok, message],
  );
}
