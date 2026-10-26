import nodemailer from 'nodemailer';
import { config } from '../config.js';
import { IntegrationError } from '../lib/errors.js';
import { getIntegration } from '../repos/integrations.js';
import { missingRequirements, recordTest, type CredentialProvider } from './credentials.js';
import { HighLevelApiService } from './highlevel/HighLevelApiService.js';
import { ShopifyApiService, SHOPIFY_SCOPES } from './shopify/ShopifyApiService.js';
import { getSquareAccessToken } from './square/auth.js';
import { SquareApiService } from './square/SquareApiService.js';

/** Square permissions the CRM uses. INVENTORY_WRITE is needed for Shopify → Square stock updates. */
export const SQUARE_REQUIRED_SCOPES = [
  'APPOINTMENTS_READ', 'APPOINTMENTS_ALL_READ', 'CUSTOMERS_READ', 'EMPLOYEES_READ', 'ITEMS_READ',
  'INVENTORY_READ', 'INVENTORY_WRITE', 'MERCHANT_PROFILE_READ', 'ORDERS_READ', 'PAYMENTS_READ',
];

export interface TestResult {
  ok: boolean;
  message: string;
  /** Things that work but need attention (e.g. a missing permission only one feature needs). */
  warnings: string[];
}

/**
 * Checks credentials against the real service API — always live, even in Demo Mode, and never reports
 * success without a real response. Error messages are written for staff and never include a secret.
 */
/** Tests only: stand in for the real services (no network, no real credentials). */
let override: ((p: CredentialProvider) => Promise<TestResult>) | null = null;
export const setConnectionTestOverride = (fn: typeof override) => { override = fn; };

export async function testConnection(p: CredentialProvider): Promise<TestResult> {
  if (override) {
    const r = await override(p);
    await recordTest(p, r.ok, [r.message, ...r.warnings].join(' '));
    return r;
  }
  const missing = missingRequirements(p);
  let result: TestResult;
  if (missing.length) {
    result = { ok: false, message: `Not configured yet. Missing: ${missing.join('; ')}.`, warnings: [] };
  } else {
    try {
      result = await run(p);
    } catch (e) {
      result = { ok: false, message: friendly(e), warnings: [] };
    }
  }
  await recordTest(p, result.ok, [result.message, ...result.warnings].join(' '));
  return result;
}

function friendly(e: unknown) {
  if (e instanceof IntegrationError) return e.userMessage;
  const m = String((e as any)?.code ?? '');
  if (m === 'EAUTH') return 'The email server rejected the username or password.';
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(m)) return 'That server address could not be found.';
  if (['ECONNREFUSED', 'ETIMEDOUT', 'ESOCKET', 'ECONNECTION'].includes(m)) return 'Could not connect to that server and port.';
  return 'The service could not be reached. Check the details and try again.';
}

async function run(p: CredentialProvider): Promise<TestResult> {
  const c = config();
  const warnings: string[] = [];
  switch (p) {
    case 'square': {
      if (!c.SQUARE_ACCESS_TOKEN) {
        const row = await getIntegration('square');
        if (!row?.encrypted_credentials || row.status === 'disconnected') {
          return { ok: false, message: 'App credentials are saved. Now press “Connect with Square” to authorize the salon’s Square account.', warnings };
        }
      }
      const sq = new SquareApiService(getSquareAccessToken);
      const name = await sq.merchantName();
      const { scopes } = await sq.tokenScopes();
      if (scopes) {
        const lacking = SQUARE_REQUIRED_SCOPES.filter((s) => !scopes.includes(s));
        if (!scopes.includes('ITEMS_WRITE')) warnings.push('Optional: ITEMS_WRITE lets Inventory Sync set a Square product’s SKU to match Shopify. Without it, change SKUs in Square yourself.');
        if (lacking.length) warnings.push(`This token is missing: ${lacking.join(', ')}.${lacking.includes('INVENTORY_WRITE') ? ' Shopify → Square stock updates need INVENTORY_WRITE.' : ''}${lacking.some((x) => x === 'ORDERS_READ' || x === 'PAYMENTS_READ') ? ' My Commission needs ORDERS_READ and PAYMENTS_READ.' : ''}`);
      }
      const locations = await sq.listLocations();
      const want = c.SQUARE_INVENTORY_LOCATION_ID?.trim();
      if (want && !locations.some((l) => l.id === want)) warnings.push(`Inventory location ID ${want} wasn’t found in this Square account.`);
      if (!want && locations.length > 1) warnings.push(`Square has ${locations.length} locations: set the Inventory location ID to choose which one syncs with Shopify (${locations.map((l) => `${l.name}: ${l.id}`).join('; ')}).`);
      return { ok: true, message: `Connected to Square${name ? ` · ${name}` : ''} (${c.SQUARE_ENVIRONMENT}).`, warnings };
    }
    case 'shopify':
    case 'shopify2': {
      const domain = (p === 'shopify' ? c.SHOPIFY_STORE_DOMAIN : c.SHOPIFY2_STORE_DOMAIN)!.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      const shop = new ShopifyApiService(domain, p === 'shopify' ? 'SHOPIFY' : 'SHOPIFY2');
      const r = await shop.testConnection();
      const scopes = await shop.accessScopes();
      // write_inventory implies read access in Shopify, so either satisfies the read scope.
      const has = (s: string) => scopes.includes(s) || (s.startsWith('read_') && scopes.includes(s.replace('read_', 'write_')));
      const lacking = SHOPIFY_SCOPES.filter((s) => !has(s));
      if (lacking.length) warnings.push(`The Shopify app is missing these permissions, needed for inventory sync: ${lacking.join(', ')}.`);
      if (!scopes.includes('write_products')) warnings.push('Optional: write_products lets Inventory → Pricing change prices in this store. Without it, prices are changed in Shopify.');
      // Least privilege: point out access the CRM never uses, so it can be removed from the Shopify app.
      const needed = new Set([...SHOPIFY_SCOPES, ...SHOPIFY_SCOPES.map((s) => s.replace('read_', 'write_')), 'write_products', 'read_customers']);
      const extra = scopes.filter((s) => !needed.has(s));
      if (extra.length) warnings.push(`The app also has permissions the CRM doesn’t use (${extra.join(', ')}); you can remove them in Shopify.`);
      return { ok: true, message: `Connected to ${r.shopName} (${domain})${r.locationName ? ` · inventory location: ${r.locationName}` : ''}. Permissions granted: ${scopes.join(', ') || 'none'}.`, warnings };
    }
    case 'highlevel': {
      const hl = new HighLevelApiService(c.HIGHLEVEL_PRIVATE_TOKEN!, c.HIGHLEVEL_LOCATION_ID!);
      const r = await hl.testConnection();
      return { ok: true, message: `Connected to HighLevel${r.locationName ? ` · ${r.locationName}` : ''}.`, warnings };
    }
    case 'google':
      // Nothing to call yet: the client is used when an administrator connects the mailbox (Google’s sign-in).
      return { ok: true, message: 'Saved. Now connect the mailbox under Settings → Website Inquiries (Google’s sign-in).', warnings };
    case 'highlevel_hair': {
      const hl = new HighLevelApiService(c.HIGHLEVEL_HAIR_PRIVATE_TOKEN!, c.HIGHLEVEL_HAIR_LOCATION_ID!);
      const r = await hl.testConnection();
      return { ok: true, message: `Connected to Addendum Hair’s HighLevel${r.locationName ? ` · ${r.locationName}` : ''}.`, warnings };
    }
    case 'email': {
      const t = nodemailer.createTransport({
        host: c.SMTP_HOST, port: c.SMTP_PORT, secure: c.SMTP_SECURE,
        auth: c.SMTP_USER ? { user: c.SMTP_USER, pass: c.SMTP_PASS } : undefined,
        connectionTimeout: 15_000, greetingTimeout: 15_000,
      });
      try {
        await t.verify(); // connects and logs in; sends nothing
      } finally {
        t.close();
      }
      return { ok: true, message: `Signed in to ${c.SMTP_HOST} as ${c.SMTP_USER}. No email was sent.`, warnings };
    }
    case 'ai': {
      let res: Response;
      try {
        res = await fetch('https://api.anthropic.com/v1/models?limit=1', {
          headers: { 'x-api-key': c.ANTHROPIC_API_KEY!, 'anthropic-version': '2023-06-01' },
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        return { ok: false, message: 'Anthropic could not be reached. Try again in a moment.', warnings };
      }
      if (res.status === 401 || res.status === 403) return { ok: false, message: 'Anthropic rejected the API key.', warnings };
      if (!res.ok) return { ok: false, message: `Anthropic returned an error (${res.status}). Try again in a moment.`, warnings };
      return { ok: true, message: `API key accepted. Drafts will use ${c.AI_MODEL}.`, warnings };
    }
  }
}
