import { Router } from 'express';
import { requireOwnerReauth } from '../auth/reauth.js';
import { z } from 'zod';
import { requirePermission } from '../auth/session.js';
import { config } from '../config.js';
import { IntegrationError } from '../lib/errors.js';
import { runSquareSync } from '../domain/squareSync.js';
import { highLevelService, integrationStatus, isDemo, shopifyService } from '../integrations/registry.js';
import { SHOPIFY_SCOPES } from '../integrations/shopify/ShopifyApiService.js';
import { buildAuthorizeUrl, disconnectSquare, handleCallback, SQUARE_SCOPES } from '../integrations/square/auth.js';
import { ah, logAction, parse } from './util.js';
import { disconnectGmail, gmailAuthorizeUrl, gmailCallback } from '../integrations/google/gmail.js';
import { listStaffForPicker, processShowit, resolveShowit, saveShowitSettings, showitCandidates, showitOverview, showitSettings } from '../domain/showit.js';

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

integrationsRouter.get('/square/connect', requireOwnerReauth('integrations:manage'), ah(async (_req, res) => {
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

// ---------------- Instagram (Content Calendar) ----------------
// Connect Instagram: one Facebook sign-in finds the accounts; each is matched to @addendum.salon, @addendumhair or
// @addendumhairpro by its username and saved (encrypted) for posting. Owners re-enter their password first.
integrationsRouter.get('/instagram/connect', requireOwnerReauth('integrations:manage'), ah(async (_req, res) => {
  const { metaAuthorizeUrl } = await import('../integrations/instagram.js');
  res.json({ url: await metaAuthorizeUrl() });
}));
integrationsRouter.get('/instagram/callback', requirePermission('integrations:manage'), ah(async (req, res) => {
  const { code, state, error } = req.query as Record<string, string>;
  const back = (q: string) => res.redirect(`/content?tab=settings&${q}`);
  if (error || !code) return back('instagram=denied');
  try {
    const { metaCallback } = await import('../integrations/instagram.js');
    const { contentAccounts } = await import('../domain/content.js');
    const { saveCredentials } = await import('../integrations/credentials.js');
    const found = await metaCallback(code, state);
    const norm = (h: string) => h.toLowerCase().replace(/^@/, '').replace(/[^a-z0-9._]/g, '');
    const values: Record<string, string> = {};
    const linked: string[] = [];
    for (const a of await contentAccounts()) {
      if (a.privateAccount) continue; // private (e.g. stylists only): apps can't post to it
      const hit = found.find((f) => norm(f.username) === norm(a.handle));
      if (!hit) continue;
      const n = a.id.slice(1);
      values[`INSTAGRAM_${n}_ACCOUNT_ID`] = hit.accountId;
      values[`INSTAGRAM_${n}_TOKEN`] = hit.token;
      linked.push(`@${hit.username}`);
    }
    if (linked.length) await saveCredentials('instagram', values, req.user!.id);
    const others = found.filter((f) => !linked.includes(`@${f.username}`)).map((f) => `@${f.username}`);
    await logAction(req, 'integration.instagram_connected', undefined, undefined, { linked, others });
    back(`instagram=connected&linked=${encodeURIComponent(linked.join(', '))}&others=${encodeURIComponent(others.join(', '))}`);
  } catch (e) {
    console.error('[instagram] oauth callback failed', e instanceof IntegrationError ? e.technical ?? e.userMessage : e);
    back(`instagram=failed&reason=${encodeURIComponent(e instanceof IntegrationError ? e.userMessage : 'The connection didn’t complete.')}`);
  }
}));

// ---------------- Website Inquiries (Showit → Gmail) ----------------
// Connecting the mailbox: Google's own sign-in (never a password or token typed into the CRM); owners re-enter theirs first.
integrationsRouter.get('/gmail/connect', requireOwnerReauth('integrations:manage'), ah(async (_req, res) => {
  res.json({ url: await gmailAuthorizeUrl((await showitSettings()).account) });
}));
integrationsRouter.get('/gmail/callback', requirePermission('integrations:manage'), ah(async (req, res) => {
  const { code, state, error } = req.query as Record<string, string>;
  if (error || !code) return res.redirect('/settings?tab=inquiries&gmail=denied');
  try {
    const email = await gmailCallback(code, state, (await showitSettings()).account);
    await logAction(req, 'integration.gmail_connected', undefined, undefined, { email });
    res.redirect('/settings?tab=inquiries&gmail=connected');
  } catch (e) {
    console.error('[gmail] oauth callback failed', e instanceof IntegrationError ? e.technical ?? e.userMessage : e);
    res.redirect(`/settings?tab=inquiries&gmail=failed&reason=${encodeURIComponent(e instanceof IntegrationError ? e.userMessage : 'The connection didn’t complete.')}`);
  }
}));
integrationsRouter.post('/gmail/disconnect', requireOwnerReauth('integrations:manage'), ah(async (req, res) => {
  await disconnectGmail();
  await logAction(req, 'integration.gmail_disconnected');
  res.json({ ok: true });
}));
// Setup, history and review — administrators only (the mailbox's content isn't shared beyond them; inquiries are,
// through the usual new-client permissions).
integrationsRouter.get('/showit', requirePermission('integrations:manage'), ah(async (_req, res) => res.json({ ...(await showitOverview()), staff: await listStaffForPicker() })));
integrationsRouter.get('/showit/candidates', requirePermission('integrations:manage'), ah(async (_req, res) => res.json({ candidates: await showitCandidates() })));
integrationsRouter.put('/showit/settings', requirePermission('integrations:manage'), ah(async (req, res) => {
  const b = parse(z.object({
    senders: z.array(z.string().trim().toLowerCase().email()).max(10).optional(), label: z.string().trim().min(1).max(80).optional(),
    extensionAssigneeId: z.string().uuid().nullable().optional(), frontDeskAssigneeId: z.string().uuid().nullable().optional(), enabled: z.boolean().optional(),
  }), req.body);
  const s = await saveShowitSettings(b);
  await logAction(req, 'integration.showit_settings', undefined, undefined, { senders: s.senders, label: s.label });
  res.json({ settings: s });
}));
integrationsRouter.post('/showit/check', requirePermission('integrations:manage'), ah(async (req, res) => {
  const r = await processShowit();
  await logAction(req, 'integration.showit_check', undefined, undefined, r);
  res.json({ result: r });
}));
integrationsRouter.post('/showit/:id/resolve', requirePermission('integrations:manage'), ah(async (req, res) => {
  const b = parse(z.object({ action: z.enum(['extension', 'general', 'ignore']), name: z.string().trim().max(120).optional(), email: z.string().trim().max(200).optional(), phone: z.string().trim().max(40).optional() }), req.body);
  const leadId = await resolveShowit(req.params.id, b.action, req.user!.id, { name: b.name, email: b.email, phone: b.phone });
  await logAction(req, 'integration.showit_resolve', 'lead', leadId, { action: b.action });
  res.json({ leadId });
}));
integrationsRouter.post('/square/sync', requirePermission('square:sync'), ah(async (req, res) => {
  const { full } = parse(z.object({ full: z.boolean().optional() }), req.body ?? {});
  const result = await runSquareSync({ full });
  await logAction(req, 'integration.square_sync', undefined, undefined, { ok: result.ok });
  res.json({ result, status: await integrationStatus() });
}));

integrationsRouter.post('/square/disconnect', requireOwnerReauth('integrations:manage'), ah(async (req, res) => {
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


