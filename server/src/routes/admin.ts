import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../auth/session.js';
import { db } from '../db/index.js';
import { getSettings } from '../repos/settings.js';
import {
  assertProvider, credentialStatus, PROVIDERS, removeCredentials, saveCredentials, type CredentialProvider,
} from '../integrations/credentials.js';
import { testConnection } from '../integrations/connectionTests.js';
import { isDemo } from '../integrations/registry.js';
import { ah, logAction, parse } from './util.js';

/**
 * Settings → API & Integrations. Administrators only ("integrations:manage" — enforced here on the server).
 * Responses never contain a secret value: only whether each field is set and where it comes from.
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
  if (p === 'email') {
    const n = await db().one<{ n: number }>("SELECT count(*)::int n FROM inventory_requests WHERE status IN ('submitted','ordered')");
    out.push(`Order Hair emails are sent with it${n?.n ? ` (${n.n} open order${n.n === 1 ? '' : 's'})` : ''}.`);
  }
  if (p === 'highlevel') out.push('Follow-ups are pushed to HighLevel as tasks.');
  if (p === 'ai') out.push('AI drafts for texts use it (built-in templates are used without it).');
  return out;
}

adminRouter.get('/credentials', ah(async (_req, res) => {
  const integrations = [];
  for (const p of PROVIDERS) integrations.push({ ...(await credentialStatus(p)), usedFor: await usage(p) });
  res.json({ integrations, demoMode: isDemo() });
}));

adminRouter.put('/credentials/:provider', ah(async (req, res) => {
  const p = assertProvider(req.params.provider);
  const { values } = parse(z.object({ values: z.record(z.string().max(4000).nullable()) }), req.body);
  const changed = await saveCredentials(p, values, req.user!.id);
  // Field names only — never values.
  if (changed.length) await logAction(req, 'credentials.update', 'integration', p, { fields: changed });
  res.json({ integration: { ...(await credentialStatus(p)), usedFor: await usage(p) }, changed });
}));

adminRouter.delete('/credentials/:provider', ah(async (req, res) => {
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
