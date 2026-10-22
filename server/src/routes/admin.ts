import { Router } from 'express';
import { z } from 'zod';
import { requireAnyPermission, requirePermission } from '../auth/session.js';
import { config } from '../config.js';
import { systemStatus } from '../system/health.js';
import { db } from '../db/index.js';
import { getSettings } from '../repos/settings.js';
import {
  assertProvider, credentialStatus, missingRequirements, PROVIDERS, removeCredentials, restoreCredentials, saveCredentials,
  setProviderDisabled, snapshotCredentials, type CredentialProvider,
} from '../integrations/credentials.js';
import { requireOwnerReauth } from '../auth/reauth.js';
import { testConnection } from '../integrations/connectionTests.js';
import { isDemo } from '../integrations/registry.js';
import { ah, logAction, parse } from './util.js';

/**
 * Settings → API & Integrations. Viewing the status needs "integrations:manage"; every change also needs the Owner/Admin
 * role and a password confirmed in the last few minutes (enforced here on the server). Responses never contain a secret
 * value: only whether each field is set and where it comes from. The activity log records field names, never values.
 */
export const adminRouter = Router();
adminRouter.use('/credentials', requirePermission('integrations:manage'));

/** What the CRM currently uses each integration for — shown as a warning before removing credentials. */
async function usage(p: CredentialProvider): Promise<string[]> {
  const s = await getSettings();
  const out: string[] = [];
  if (p === 'square') {
    out.push('Appointments, clients and services are read from Square.');
    if (s.inventorySync.enabled) out.push('Inventory sync with Shopify is turned on.');
    if (s.commission.enabled) out.push('Commission is calculated from Square sales (needs ORDERS_READ and PAYMENTS_READ).');
  }
  if (p === 'shopify' && s.inventorySync.enabled) out.push('Inventory sync with Square is turned on.');
  if (p === 'shopify2') out.push('Its stock is kept in step with Square and the main Shopify store, and its sales are in Analytics.');
  if (p === 'email') {
    const n = await db().one<{ n: number }>("SELECT count(*)::int n FROM inventory_requests WHERE status IN ('submitted','ordered')");
    out.push(`Order Hair emails are sent with it${n?.n ? ` (${n.n} open order${n.n === 1 ? '' : 's'})` : ''}.`);
  }
  if (p === 'highlevel') out.push('Follow-ups are pushed to HighLevel as tasks.');
  if (p === 'ai') out.push('AI drafts for texts use it (built-in templates are used without it).');
  return out;
}

/** Data safety for Owners/Admins: where accounts are stored, schema updates, the encryption key (no secrets). */
adminRouter.get('/system', requireAnyPermission('settings:write', 'integrations:manage'), ah(async (_req, res) => {
  res.json({ system: await systemStatus(config(), db()) });
}));

adminRouter.get('/credentials', ah(async (_req, res) => {
  const integrations = [];
  for (const p of PROVIDERS) integrations.push({ ...(await credentialStatus(p)), usedFor: await usage(p) });
  res.json({ integrations, demoMode: isDemo() });
}));

const ownerReauth = requireOwnerReauth('integrations:manage');

/**
 * Save or replace credentials. When the integration currently works, the new values are tested first and, if the
 * test fails, the previous ones are put back untouched (skipVerify saves anyway, e.g. while the provider is down).
 */
adminRouter.put('/credentials/:provider', ownerReauth, ah(async (req, res) => {
  const p = assertProvider(req.params.provider);
  const b = parse(z.object({ values: z.record(z.string().max(4000).nullable()), skipVerify: z.boolean().default(false) }), req.body);
  const before = await snapshotCredentials(p);
  const wasWorking = before?.last_test_ok === true && !before.disabled && !missingRequirements(p).length;
  const changed = await saveCredentials(p, b.values, req.user!.id);
  if (changed.length && wasWorking && !b.skipVerify && !missingRequirements(p).length) {
    const result = await testConnection(p);
    if (!result.ok) {
      await restoreCredentials(p, before);
      await logAction(req, 'credentials.update_rejected', 'integration', p, { fields: changed });
      return res.status(409).json({ error: { code: 'verification_failed', message: `${result.message} Nothing was changed: the working settings are still in use.` } });
    }
  }
  // Field names only — never values.
  if (changed.length) await logAction(req, 'credentials.update', 'integration', p, { fields: changed, verified: wasWorking && !b.skipVerify });
  res.json({ integration: { ...(await credentialStatus(p)), usedFor: await usage(p) }, changed });
}));

/** Switch an integration off without deleting its credentials, or back on. */
adminRouter.post('/credentials/:provider/:state(enable|disable)', ownerReauth, ah(async (req, res) => {
  const p = assertProvider(req.params.provider);
  const off = req.params.state === 'disable';
  await setProviderDisabled(p, off, req.user!.id);
  await logAction(req, off ? 'credentials.disable' : 'credentials.enable', 'integration', p);
  res.json({ integration: { ...(await credentialStatus(p)), usedFor: await usage(p) } });
}));

/** Who changed which integration settings, and when (names of fields only). */
adminRouter.get('/credentials/history', ah(async (_req, res) => {
  const rows = await db().query<any>(
    `SELECT a.action, a.entity_id AS provider, a.detail, a.created_at, s.name AS staff_name
       FROM audit_logs a LEFT JOIN staff s ON s.id = a.staff_id
      WHERE a.action LIKE 'credentials.%' OR a.action LIKE 'integration.square_%connected'
      ORDER BY a.created_at DESC LIMIT 50`,
  );
  res.json({ history: rows.map((r) => ({ action: r.action, provider: r.provider, fields: r.detail?.fields ?? [], at: new Date(r.created_at).toISOString(), by: r.staff_name ?? null })) });
}));

adminRouter.delete('/credentials/:provider', ownerReauth, ah(async (req, res) => {
  const p = assertProvider(req.params.provider);
  await removeCredentials(p);
  await logAction(req, 'credentials.remove', 'integration', p);
  res.json({ integration: { ...(await credentialStatus(p)), usedFor: await usage(p) } });
}));

adminRouter.post('/credentials/:provider/test', ah(async (req, res) => {
  const p = assertProvider(req.params.provider);
  const result = await testConnection(p);
  await logAction(req, 'credentials.test', 'integration', p, { ok: result.ok });
  res.json({ result, integration: { ...(await credentialStatus(p)), usedFor: await usage(p) } });
}));
