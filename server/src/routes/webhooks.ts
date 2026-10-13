import express, { Router } from 'express';
import { scheduleWebhookSync } from '../domain/inventorySync.js';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { runRules } from '../domain/rulesEngine.js';
import { syncSingleBooking, upsertCustomer } from '../domain/squareSync.js';
import { isDemo, squareService } from '../integrations/registry.js';
import { verifySquareSignature } from '../integrations/square/webhooks.js';

/**
 * Public webhook endpoints. Every request is signature-verified before anything is processed.
 * They are excluded from session auth and CSRF checks (providers can't send those).
 */
export const webhooksRouter = Router();
webhooksRouter.use(rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false }));

webhooksRouter.post('/square', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  const c = config();
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  if (!c.SQUARE_WEBHOOK_SIGNATURE_KEY || !c.SQUARE_WEBHOOK_URL) return res.status(503).json({ error: 'Square webhooks not configured' });
  if (!verifySquareSignature(raw, req.get('x-square-hmacsha256-signature'), c.SQUARE_WEBHOOK_SIGNATURE_KEY, c.SQUARE_WEBHOOK_URL)) {
    return res.status(403).json({ error: 'invalid signature' });
  }
  let event: any;
  try {
    event = JSON.parse(raw);
  } catch {
    return res.status(400).json({ error: 'bad json' });
  }
  const eventId = String(event.event_id ?? '');
  const seen = await db().query('INSERT INTO webhook_events(id, provider, event_type) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING RETURNING id', [
    `square:${eventId}`, 'square', String(event.type ?? ''),
  ]);
  res.status(200).json({ ok: true }); // acknowledge fast; Square retries on timeouts
  if (!seen.length) return; // duplicate delivery
  try {
    const type = String(event.type ?? '');
    const id = event.data?.id ?? event.data?.object?.booking?.id ?? event.data?.object?.customer?.id;
    if (type === 'inventory.count.updated') scheduleWebhookSync(); // product stock only; debounced
    else if (type.startsWith('booking.') && id) await syncSingleBooking(id);
    else if (type.startsWith('customer.') && id && type !== 'customer.deleted') {
      const svc = await squareService();
      const [cust] = (await svc?.bulkRetrieveCustomers([id])) ?? [];
      if (cust) await upsertCustomer(cust);
    }
    await db().query('UPDATE webhook_events SET processed_at = now() WHERE id = $1', [`square:${eventId}`]);
  } catch (e) {
    console.error('[webhook:square] processing failed', (e as Error).message);
    await db().query('UPDATE webhook_events SET error = $2 WHERE id = $1', [`square:${eventId}`, (e as Error).message.slice(0, 300)]);
  }
});

