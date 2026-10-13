import type { InventoryRequestDTO, InventoryStatus } from '@addendum/shared';
import { config } from '../config.js';
import { db, type Queryable } from '../db/index.js';
import { badRequest, notFound } from '../lib/errors.js';
import { IntegrationError } from '../lib/errors.js';
import { iso } from '../lib/time.js';
import { emailService } from '../integrations/registry.js';
import { notifications } from '../integrations/notifications/NotificationService.js';
import { getSettings } from '../repos/settings.js';

/**
 * Order Hair: requests for Addendum Hair. A stylist lists what they need (Size, Color, Collection, QTY,
 * Needed By); the request is saved, emailed to the ordering contact (Settings → Order Hair, default
 * gaby@addendumhair.com), and tracked Requested → Ordered → Received. If the email can't be sent it is
 * kept and retried automatically. Hair orders never touch Shopify; stock lives in Square (see squareInventory.ts).
 */

export interface NewInventoryItem {
  collection: string;
  size?: string | null;
  color?: string | null;
  quantity: number;
  neededBy?: string | null; // YYYY-MM-DD
  clientId?: string | null;
  note?: string | null;
}

export interface NewInventoryRequest {
  forStaffId?: string | null;
  note?: string | null;
  items: NewInventoryItem[];
}

/** The Addendum Hair team is copied on every Order Hair email, whoever sends it. */
export const ORDER_EMAIL_ALWAYS_CC = 'info@addendumhair.com';

/** CC list for an order email: Addendum Hair, then the stylist (if turned on). No duplicates, never the main recipient. */
export function orderEmailCc(to: string, requesterEmail: string | null | undefined, ccRequester: boolean) {
  const seen = new Set([to.trim().toLowerCase()]);
  const cc: string[] = [];
  for (const addr of [ORDER_EMAIL_ALWAYS_CC, ccRequester ? requesterEmail : null]) {
    const a = addr?.trim();
    if (a && !seen.has(a.toLowerCase())) { seen.add(a.toLowerCase()); cc.push(a); }
  }
  return cc;
}

const SELECT = `
  SELECT r.*, fs.name AS for_staff_name, rb.name AS requested_by_name, rb.email AS requested_by_email
    FROM inventory_requests r
    LEFT JOIN staff fs ON fs.id = r.for_staff_id
    LEFT JOIN staff rb ON rb.id = r.requested_by_staff_id`;

const ymd = (v: unknown) => (v ? (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)) : null);

async function toDTOs(rows: any[]): Promise<InventoryRequestDTO[]> {
  if (!rows.length) return [];
  const items = await db().query<any>(
    `SELECT i.*, NULLIF(trim(c.first_name || ' ' || c.last_name), '') AS client_name
       FROM inventory_request_items i LEFT JOIN clients c ON c.id = i.client_id
      WHERE i.request_id = ANY($1::uuid[]) ORDER BY i.position`,
    [rows.map((r) => r.id)],
  );
  return rows.map((r) => {
    const mine = items.filter((i) => i.request_id === r.id).map((i) => ({
      id: i.id,
      size: i.size,
      color: i.color,
      collection: i.collection ?? i.product,
      quantity: i.quantity,
      neededBy: ymd(i.needed_by),
      legacyDetails: i.size || i.color ? null : i.details,
      clientId: i.client_id,
      clientName: i.client_name,
      note: i.note,
    }));
    const dates = mine.map((i) => i.neededBy).filter((d): d is string => !!d).sort();
    return {
      id: r.id,
      number: Number(r.request_number),
      status: r.status,
      neededBy: dates[0] ?? ymd(r.needed_by),
      note: r.note,
      forStaffId: r.for_staff_id,
      forStaffName: r.for_staff_name,
      requestedById: r.requested_by_staff_id,
      requestedByName: r.requested_by_name,
      items: mine,
      totalUnits: mine.reduce((a, i) => a + i.quantity, 0),
      email: {
        to: r.email_to, cc: r.email_cc ? String(r.email_cc).split(',') : [], status: r.email_status, attempts: r.email_attempts, sentAt: iso(r.email_sent_at),
        error: r.email_error, subject: r.email_subject, text: r.email_text,
      },
      statusChangedAt: iso(r.status_changed_at),
      createdAt: iso(r.created_at)!,
    };
  });
}

export async function listInventoryRequests(f: { forStaffId?: string; status?: string; limit?: number }) {
  const where: string[] = [];
  const p: unknown[] = [];
  if (f.forStaffId) { p.push(f.forStaffId); where.push(`(r.for_staff_id = $${p.length} OR r.requested_by_staff_id = $${p.length})`); }
  if (f.status === 'open') where.push(`r.status IN ('submitted','ordered')`);
  else if (f.status) { p.push(f.status); where.push(`r.status = $${p.length}`); }
  p.push(Math.min(f.limit ?? 100, 300));
  const rows = await db().query(`${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY r.created_at DESC LIMIT $${p.length}`, p);
  return toDTOs(rows);
}

export async function getInventoryRequest(id: string) {
  const row = await db().one(`${SELECT} WHERE r.id = $1`, [id]);
  if (!row) throw notFound('That order request');
  return (await toDTOs([row]))[0];
}

/** Keeps the request-level date (used by older views and sorting) equal to the earliest item date. */
async function syncRequestNeededBy(q: Queryable, id: string) {
  await q.query(`UPDATE inventory_requests SET needed_by = (SELECT min(needed_by) FROM inventory_request_items WHERE request_id = $1), updated_at = now() WHERE id = $1`, [id]);
}

export async function createInventoryRequest(input: NewInventoryRequest, staffId: string) {
  const items = input.items.filter((i) => i.collection.trim());
  if (!items.length) throw badRequest('Add at least one item.');
  const s = await getSettings();
  const forStaffId = input.forStaffId ?? staffId;
  const id = await db().tx(async (q) => {
    const [r] = await q.query<{ id: string }>(
      `INSERT INTO inventory_requests(requested_by_staff_id, for_staff_id, note, email_to) VALUES ($1,$2,$3,$4) RETURNING id`,
      [staffId, forStaffId, input.note?.trim() || null, s.inventory.orderEmail],
    );
    let pos = 0;
    for (const i of items) {
      await q.query(
        `INSERT INTO inventory_request_items(request_id, position, product, collection, size, color, quantity, needed_by, client_id, note)
         VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9)`,
        [r.id, pos++, i.collection.trim(), i.size?.trim() || null, i.color?.trim() || null, i.quantity, i.neededBy || null,
          i.clientId || null, i.note?.trim() || null],
      );
    }
    await syncRequestNeededBy(q, r.id);
    return r.id;
  });
  await sendInventoryEmail(id);
  const req = await getInventoryRequest(id);
  await notifications.notify({
    kind: 'inventory', title: `Hair order #${req.number} from ${req.forStaffName ?? 'a stylist'}`,
    body: `${req.items.length} item${req.items.length === 1 ? '' : 's'} · ${req.totalUnits} units`, link: `/inventory?open=${id}`,
  });
  return req;
}

const fmtDate = (d: string | null) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }) : '—');

/** Builds the email Gaby receives. Plain text first (reads well on a phone), plus a simple HTML table. */
export function renderInventoryEmail(req: InventoryRequestDTO, salonName: string) {
  const who = req.forStaffName ?? req.requestedByName ?? 'A stylist';
  const subject = `Addendum Hair order request #${req.number} — ${who}`;
  const link = `${config().APP_URL.replace(/\/$/, '')}/inventory?open=${req.id}`;
  const lines = [
    `New hair order from ${salonName}.`,
    '',
    `Request #${req.number}`,
    `Stylist: ${who}`,
    req.requestedByName && req.requestedByName !== who ? `Submitted by: ${req.requestedByName}` : null,
    '',
    'Items:',
    ...req.items.map((i) => [
      `  • Size: ${i.size ?? '—'} | Color: ${i.color ?? '—'} | Collection: ${i.collection} | QTY: ${i.quantity} | Needed by: ${fmtDate(i.neededBy)}`,
      i.legacyDetails ? `     Details: ${i.legacyDetails}` : null,
      i.clientName ? `     For client: ${i.clientName}` : null,
      i.note ? `     Note: ${i.note}` : null,
    ].filter(Boolean).join('\n')),
    '',
    `Total: ${req.items.length} item${req.items.length === 1 ? '' : 's'}, ${req.totalUnits} unit${req.totalUnits === 1 ? '' : 's'}`,
    req.note ? `\nNote from stylist:\n${req.note}` : null,
    '',
    `View in the salon app: ${link}`,
  ].filter((l) => l !== null) as string[];
  const esc = (v: string) => v.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
  const td = 'padding:6px 10px;border-bottom:1px solid #eee;vertical-align:top';
  const rows = req.items.map((i) => {
    const extra = [i.legacyDetails, i.clientName ? `For ${i.clientName}` : null, i.note].filter(Boolean).map((x) => `<br><span style="color:#666;font-size:13px">${esc(x!)}</span>`).join('');
    return `<tr><td style="${td}">${esc(i.size ?? '—')}</td><td style="${td}">${esc(i.color ?? '—')}</td><td style="${td}"><b>${esc(i.collection)}</b>${extra}</td><td style="${td};text-align:right">${i.quantity}</td><td style="${td};white-space:nowrap">${esc(fmtDate(i.neededBy))}</td></tr>`;
  }).join('');
  const th = 'padding:6px 10px';
  const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;color:#1d1c1a;max-width:680px">
<p>New hair order from ${esc(salonName)}.</p>
<p><b>Request #${req.number}</b><br>Stylist: ${esc(who)}</p>
<table style="border-collapse:collapse;width:100%"><thead><tr style="text-align:left;color:#75716b;font-size:13px"><th style="${th}">Size</th><th style="${th}">Color</th><th style="${th}">Collection</th><th style="${th};text-align:right">QTY</th><th style="${th}">Needed By</th></tr></thead><tbody>${rows}</tbody></table>
<p style="color:#666">${req.items.length} item${req.items.length === 1 ? '' : 's'} · ${req.totalUnits} units</p>
${req.note ? `<p><b>Note from stylist</b><br>${esc(req.note).replace(/\n/g, '<br>')}</p>` : ''}
<p><a href="${esc(link)}">View in the salon app</a></p></div>`;
  return { subject, text: lines.join('\n'), html };
}

/** Sends (or re-sends) the email for a request. Never throws — the request is always kept. */
export async function sendInventoryEmail(id: string) {
  const s = await getSettings();
  const req = await getInventoryRequest(id);
  const { subject, text, html } = renderInventoryEmail(req, s.business.name);
  const email = emailService();
  if (!email) {
    await db().query(
      `UPDATE inventory_requests SET email_status = 'not_configured', email_subject = $2, email_text = $3,
         email_error = 'Email is not set up on the server yet, so this request was saved but not emailed.', updated_at = now() WHERE id = $1`,
      [id, subject, text],
    );
    return { ok: false as const };
  }
  const requester = await db().one<any>('SELECT s.email FROM inventory_requests r LEFT JOIN staff s ON s.id = r.requested_by_staff_id WHERE r.id = $1', [id]);
  const cc = orderEmailCc(req.email.to, requester?.email, s.inventory.ccRequester);
  try {
    const r = await email.send({ to: req.email.to, subject, text, html, cc, replyTo: requester?.email ?? null });
    await db().query(
      `UPDATE inventory_requests SET email_status = 'sent', email_sent_at = now(), email_message_id = $2, email_error = NULL,
         email_attempts = email_attempts + 1, email_last_attempt_at = now(), email_subject = $3, email_text = $4, email_cc = $5, updated_at = now() WHERE id = $1`,
      [id, r.messageId, subject, text, cc.join(',') || null],
    );
    return { ok: true as const };
  } catch (e) {
    const msg = e instanceof IntegrationError ? e.userMessage : 'The email could not be sent right now. It will be retried.';
    console.warn('[inventory] email failed:', e instanceof IntegrationError ? e.technical : (e as Error).message);
    await db().query(
      `UPDATE inventory_requests SET email_status = 'failed', email_error = $2, email_attempts = email_attempts + 1,
         email_last_attempt_at = now(), email_subject = $3, email_text = $4, updated_at = now() WHERE id = $1`,
      [id, msg, subject, text],
    );
    return { ok: false as const };
  }
}

/** Background retry with backoff (2, 4, 8, 16, 32 min…), up to 8 attempts. Also picks up requests saved before email was set up. */
export async function retryInventoryEmails(now = new Date()) {
  if (!emailService()) return { retried: 0 };
  const due = await db().query<{ id: string }>(
    `SELECT id FROM inventory_requests
      WHERE status <> 'cancelled' AND (email_status = 'not_configured'
         OR (email_status IN ('failed','pending') AND email_attempts < 8
             AND (email_last_attempt_at IS NULL OR email_last_attempt_at < $1::timestamptz - (power(2, email_attempts) * interval '1 minute'))))
      ORDER BY created_at LIMIT 20`,
    [now],
  );
  for (const r of due) await sendInventoryEmail(r.id);
  return { retried: due.length };
}

export async function setInventoryStatus(id: string, status: InventoryStatus, staffId: string) {
  const r = await db().one<any>('UPDATE inventory_requests SET status = $2, status_changed_at = now(), status_changed_by_staff_id = $3, updated_at = now() WHERE id = $1 RETURNING id', [id, status, staffId]);
  if (!r) throw notFound('That order request');
  return getInventoryRequest(id);
}

/** Edit an item's Needed By date. */
export async function updateInventoryItem(requestId: string, itemId: string, patch: { neededBy?: string | null }) {
  const req = await getInventoryRequest(requestId);
  if (!req.items.some((i) => i.id === itemId)) throw notFound('That item');
  if (patch.neededBy !== undefined) {
    await db().tx(async (q) => {
      await q.query('UPDATE inventory_request_items SET needed_by = $2 WHERE id = $1', [itemId, patch.neededBy || null]);
      await syncRequestNeededBy(q, requestId);
    });
  }
  return { request: await getInventoryRequest(requestId) };
}

/** Quick-pick suggestions: the owner's collection list first, then collections, sizes and colors used before. */
export async function inventorySuggestions() {
  const s = await getSettings();
  const past = await db().query<{ collection: string; size: string | null; color: string | null }>(
    `SELECT collection, size, color FROM (
       SELECT DISTINCT ON (lower(c), lower(COALESCE(size,'')), lower(COALESCE(color,''))) COALESCE(collection, product) AS c,
              COALESCE(collection, product) AS collection, size, color, created_at
         FROM inventory_request_items ORDER BY lower(c), lower(COALESCE(size,'')), lower(COALESCE(color,'')), created_at DESC) x
      ORDER BY created_at DESC LIMIT 200`,
  );
  const uniq = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => !!x))];
  return {
    collections: uniq([...s.inventory.catalog, ...past.map((p) => p.collection)]),
    sizes: uniq(past.map((p) => p.size)).slice(0, 40),
    colors: uniq(past.map((p) => p.color)).slice(0, 60),
    recent: past.filter((p) => p.size || p.color).slice(0, 40),
  };
}
