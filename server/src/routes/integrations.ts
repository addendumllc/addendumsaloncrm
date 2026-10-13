import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../auth/session.js';
import { config } from '../config.js';
import { IntegrationError } from '../lib/errors.js';
import { runSquareSync } from '../domain/squareSync.js';
import { highLevelService, integrationStatus, isDemo, shopifyService } from '../integrations/registry.js';
import { SHOPIFY_SCOPES } from '../integrations/shopify/ShopifyApiService.js';
import { buildAuthorizeUrl, disconnectSquare, handleCallback, SQUARE_SCOPES } from '../integrations/square/auth.js';
import { ah, logAction, parse } from './util.js';

export const integrationsRouter = Router();

integrationsRouter.get('/status', ah(async (_req, res) => res.json(await integrationStatus())));

/** Setup details shown in Settings (no secrets — only whether each one is set). */
integrationsRouter.get('/setup-info', requirePermission('settings:read'), ah(async (_req, res) => {
  const c = config();
  const base = c.APP_URL.replace(/\/$/, '');
  const hook = (c.PUBLIC_WEBHOOK_BASE_URL ?? base).replace(/\/$/, '');
  res.json({
    demoMode: isDemo(),
    square: {
      environment: c.SQUARE_ENVIRONMENT, scopes: SQUARE_SCOPES, redirectUri: `${base}/api/integrations/square/callback`,
      webhookUrl: `${hook}/api/webhooks/square`, webhookEvents: ['booking.created', 'booking.updated', 'customer.created', 'customer.updated', 'inventory.count.updated'],
      oauthConfigured: !!(c.SQUARE_APPLICATION_ID && c.SQUARE_APPLICATION_SECRET), accessTokenConfigured: !!c.SQUARE_ACCESS_TOKEN,
      webhookKeyConfigured: !!c.SQUARE_WEBHOOK_SIGNATURE_KEY,
    },
    highlevel: { configured: !!c.HIGHLEVEL_PRIVATE_TOKEN && !!c.HIGHLEVEL_LOCATION_ID, scopes: ['contacts.readonly', 'contacts.write', 'users.readonly', 'locations.readonly'] },
    ai: { configured: !!c.ANTHROPIC_API_KEY, model: c.AI_MODEL },
    email: { configured: !!c.SMTP_HOST, from: c.EMAIL_FROM ?? c.SMTP_USER ?? null, host: c.SMTP_HOST ?? null },
    shopify: {
      configured: !!shopifyService() && !isDemo(), store: c.SHOPIFY_STORE_DOMAIN ?? null, scopes: SHOPIFY_SCOPES,
      auth: c.SHOPIFY_ADMIN_TOKEN ? 'admin_token' : c.SHOPIFY_CLIENT_ID && c.SHOPIFY_CLIENT_SECRET ? 'client_credentials' : 'none',
      locationConfigured: !!c.SHOPIFY_LOCATION_ID,
    },
  });
}));

integrationsRouter.get('/square/connect', requirePermission('integrations:manage'), ah(async (_req, res) => {
  res.json({ url: await buildAuthorizeUrl() });
}));

integrationsRouter.get('/square/callback', requirePermission('integrations:manage'), ah(async (req, res) => {
  const { code, state, error } = req.query as Record<string, string>;
  if (error || !code) return res.redirect('/settings?tab=square&square=denied');
  try {
    await handleCallback(code, state);
    await logAction(req, 'integration.square_connected');
    runSquareSync({ full: true }).catch(() => undefined); // import in the background
    res.redirect('/settings?tab=square&square=connected');
  } catch (e) {
    console.error('[square] oauth callback failed', e instanceof IntegrationError ? e.technical : e);
    res.redirect('/settings?tab=square&square=failed');
  }
}));

integrationsRouter.post('/square/sync', requirePermission('square:sync'), ah(async (req, res) => {
  const { full } = parse(z.object({ full: z.boolean().optional() }), req.body ?? {});
  const result = await runSquareSync({ full });
  await logAction(req, 'integration.square_sync', undefined, undefined, { ok: result.ok });
  res.json({ result, status: await integrationStatus() });
}));

integrationsRouter.post('/square/disconnect', requirePermission('integrations:manage'), ah(async (req, res) => {
  await disconnectSquare();
  await logAction(req, 'integration.square_disconnected');
  res.json({ status: await integrationStatus() });
}));

integrationsRouter.post('/highlevel/test', requirePermission('integrations:manage'), ah(async (_req, res) => {
  const hl = highLevelService();
  if (!hl) return res.json({ ok: false, message: 'HighLevel credentials are not configured on the server.' });
  try {
    const r = await hl.testConnection();
    res.json({ ok: true, message: `Connected to ${r.locationName ?? 'HighLevel'}.` });
  } catch (e) {
    res.json({ ok: false, message: e instanceof IntegrationError ? e.userMessage : 'HighLevel could not be reached.' });
  }
}));

integrationsRouter.post('/shopify/test', requirePermission('integrations:manage'), ah(async (_req, res) => {
  const shop = shopifyService();
  if (!shop) return res.json({ ok: false, message: 'Shopify credentials are not configured on the server.' });
  try {
    const r = await shop.testConnection();
    res.json({ ok: true, message: `Connected to ${r.shopName}${r.locationName ? ` · stock is removed from ${r.locationName}` : ''}.` });
  } catch (e) {
    res.json({ ok: false, message: e instanceof IntegrationError ? e.userMessage : 'Shopify could not be reached.' });
  }
}));

integrationsRouter.get('/highlevel/users', requirePermission('settings:read'), ah(async (_req, res) => {
  const hl = highLevelService();
  if (!hl) return res.json({ users: [] });
  try {
    res.json({ users: await hl.listUsers() });
  } catch (e) {
    res.json({ users: [], error: e instanceof IntegrationError ? e.userMessage : 'Could not load HighLevel users.' });
  }
}));


