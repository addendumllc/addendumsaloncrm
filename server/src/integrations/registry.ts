import type { IntegrationStatusDTO } from '@addendum/shared';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { getIntegration } from '../repos/integrations.js';
import { getSettings } from '../repos/settings.js';
import { AnthropicAIService } from './ai/AnthropicAIService.js';
import type { AIService } from './ai/AIService.js';
import { RuleBasedAIService } from './ai/RuleBasedAIService.js';
import { HighLevelApiService } from './highlevel/HighLevelApiService.js';
import type { HighLevelService } from './highlevel/HighLevelService.js';
import { loadDemoHL, MockHighLevelService } from './highlevel/MockHighLevelService.js';
import { MockEmailService, SmtpEmailService, type EmailService } from './email/EmailService.js';
import { getSquareAccessToken } from './square/auth.js';
import { MockSquareService } from './square/MockSquareService.js';
import { SquareApiService } from './square/SquareApiService.js';
import type { SquareService } from './square/types.js';
import { resetShopifyToken, ShopifyApiService } from './shopify/ShopifyApiService.js';
import { isProviderDisabled, onCredentialsChanged } from './credentials.js';
import { MockShopifyService, MockShopifyStore2, type ShopifyService } from './shopify/ShopifyService.js';

/**
 * Picks the implementation for each integration. Demo Mode uses simulators for everything;
 * otherwise each integration is live when its credentials are configured, and simply
 * "not connected" when they aren't — the app keeps working either way.
 */
export const isDemo = () => config().DEMO_MODE;

let overrides: Partial<{ square: SquareService | null; highlevel: HighLevelService | null; ai: AIService; email: EmailService | null; shopify: ShopifyService | null; shopify2: ShopifyService | null }> = {};
/** Test hook: swap an integration for a fake. */
export function setIntegrationOverride(o: typeof overrides) {
  overrides = { ...overrides, ...o };
}

export async function squareService(): Promise<SquareService | null> {
  if ('square' in overrides) return overrides.square!;
  if (isDemo()) return new MockSquareService();
  if (isProviderDisabled('square')) return null;
  const c = config();
  if (c.SQUARE_ACCESS_TOKEN) return new SquareApiService(getSquareAccessToken);
  const row = await getIntegration('square');
  if (row && row.status !== 'disconnected' && row.encrypted_credentials) return new SquareApiService(getSquareAccessToken);
  return null;
}

export function highLevelService(): HighLevelService | null {
  if ('highlevel' in overrides) return overrides.highlevel!;
  if (isDemo()) return new MockHighLevelService();
  const c = config();
  if (c.HIGHLEVEL_PRIVATE_TOKEN && c.HIGHLEVEL_LOCATION_ID) return new HighLevelApiService(c.HIGHLEVEL_PRIVATE_TOKEN, c.HIGHLEVEL_LOCATION_ID);
  return null;
}

/**
 * Where Addendum Hair's clients come from in HighLevel: its own sub-account when one is connected, otherwise the
 * main HighLevel connection (then usually narrowed to a tag).
 */
export function hairHighLevelService(): { svc: HighLevelService; source: 'own' | 'main' } | null {
  if ('highlevel' in overrides) return overrides.highlevel ? { svc: overrides.highlevel, source: 'main' } : null;
  if (isDemo()) return { svc: new MockHighLevelService(), source: 'main' };
  const c = config();
  if (c.HIGHLEVEL_HAIR_PRIVATE_TOKEN && c.HIGHLEVEL_HAIR_LOCATION_ID) return { svc: new HighLevelApiService(c.HIGHLEVEL_HAIR_PRIVATE_TOKEN, c.HIGHLEVEL_HAIR_LOCATION_ID), source: 'own' };
  const main = highLevelService();
  return main ? { svc: main, source: 'main' } : null;
}

let smtp: SmtpEmailService | null = null;
export function emailService(): EmailService | null {
  if ('email' in overrides) return overrides.email!;
  if (isDemo()) return new MockEmailService();
  if (config().SMTP_HOST) return (smtp ??= new SmtpEmailService());
  return null;
}

let shopify: ShopifyApiService | null = null;
export function shopifyService(): ShopifyService | null {
  if ('shopify' in overrides) return overrides.shopify!;
  if (isDemo()) return new MockShopifyService();
  const c = config();
  const domain = c.SHOPIFY_STORE_DOMAIN?.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (domain && (c.SHOPIFY_ADMIN_TOKEN || (c.SHOPIFY_CLIENT_ID && c.SHOPIFY_CLIENT_SECRET))) return (shopify ??= new ShopifyApiService(domain));
  return null;
}

let shopify2: ShopifyApiService | null = null;
/** A second Shopify store that shares the same stock and SKUs (Settings → API & Integrations → Second Shopify store). */
export function shopifyService2(): ShopifyService | null {
  if ('shopify2' in overrides) return overrides.shopify2!;
  if (isDemo()) return null;
  if (isProviderDisabled('shopify2')) return null;
  const c = config();
  const domain = c.SHOPIFY2_STORE_DOMAIN?.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (domain && (c.SHOPIFY2_ADMIN_TOKEN || (c.SHOPIFY2_CLIENT_ID && c.SHOPIFY2_CLIENT_SECRET))) return (shopify2 ??= new ShopifyApiService(domain, 'SHOPIFY2'));
  return null;
}
/** What the second store is called in the CRM. */
export const shopify2Name = () => config().SHOPIFY2_NAME?.trim() || 'Second Shopify store';
/** What each store is called in the CRM (Settings → API & Integrations → Name in the CRM). */
export const squareName = () => config().SQUARE_NAME?.trim() || 'Square';
export const shopifyName = () => config().SHOPIFY_NAME?.trim() || 'Shopify';
export const storeNames = () => ({ square: squareName(), shopify: shopifyName(), shopify2: shopifyService2() ? shopify2Name() : null });
export { MockShopifyStore2 };

// Rebuild cached clients when credentials are changed in Settings → API & Integrations.
onCredentialsChanged.push(() => {
  smtp = null;
  shopify = null;
  shopify2 = null;
  resetShopifyToken();
});

export function aiService(): AIService {
  if (overrides.ai) return overrides.ai;
  if (!isDemo() && config().ANTHROPIC_API_KEY) return new AnthropicAIService();
  return new RuleBasedAIService();
}

export async function integrationStatus(): Promise<IntegrationStatusDTO> {
  const c = config();
  const demo = isDemo();
  const sq = await getIntegration('square');
  const settings = await getSettings();
  const hl = highLevelService();
  const pending = await db().one<{ n: number }>(
    "SELECT count(*)::int AS n FROM tasks WHERE hl_status IN ('pending','failed') AND status <> 'cancelled'",
  );
  const squareMode = demo ? 'demo' : c.SQUARE_ACCESS_TOKEN ? 'access_token' : sq?.encrypted_credentials && sq.status !== 'disconnected' ? 'oauth' : 'disconnected';
  return {
    demoMode: demo,
    square: {
      connected: squareMode !== 'disconnected' && sq?.status !== 'needs_reconnect',
      mode: squareMode,
      environment: demo ? 'demo' : c.SQUARE_ENVIRONMENT,
      merchantName: (sq?.meta?.merchantName as string) ?? null,
      lastSyncAt: sq?.last_sync_at ? new Date(sq.last_sync_at).toISOString() : null,
      lastSyncStatus: (sq?.last_sync_status as any) ?? 'never',
      lastSyncMessage: sq?.last_sync_message ?? null,
      webhooksConfigured: demo || !!(c.SQUARE_WEBHOOK_SIGNATURE_KEY && c.SQUARE_WEBHOOK_URL),
      needsReconnect: sq?.status === 'needs_reconnect',
    },
    sms: { connected: true, provider: 'apple_messages', phoneNumber: null },
    highlevel: {
      connected: !!hl,
      mode: demo ? 'demo' : hl ? 'private_token' : 'disconnected',
      locationId: hl?.locationId ?? null,
      pendingRetries: pending?.n ?? 0,
      simulateOutage: demo ? (await loadDemoHL()).outage : undefined,
    },
    ai: { enabled: settings.ai.enabled, provider: aiService().provider },
    email: { connected: !!emailService(), provider: emailService()?.provider ?? 'none' },
    shopify: { connected: !!shopifyService(), mode: demo ? 'demo' : shopifyService() ? 'live' : 'disconnected', store: demo ? null : c.SHOPIFY_STORE_DOMAIN ?? null },
  };
}
