import { db } from '../db/index.js';
import { getSettings } from '../repos/settings.js';

/**
 * Stylists' booking pages (addendumsalon.info/book/<first name>): each bookable stylist's own services, each opening
 * that service in Square's booking site (the client then taps the stylist there — Square has no link that picks the
 * stylist). Public: no sign-in, nothing private (first names, services, prices and times only).
 */
export interface StylistLink { staffId: string; firstName: string; slug: string; services: number }

const slugOf = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Bookable stylists with their link (first name; a shared first name adds the last initial, e.g. lisa-h). */
export async function stylistLinks(): Promise<StylistLink[]> {
  const rows = await db().query<{ id: string; name: string; tm: string; n: number }>(
    `SELECT s.id, s.name, s.square_team_member_id AS tm,
            (SELECT count(*)::int FROM services v WHERE v.available_for_booking AND s.square_team_member_id = ANY(v.team_member_ids)) AS n
       FROM staff s WHERE s.active AND s.square_team_member_id IS NOT NULL AND COALESCE(s.square_bookable, true) ORDER BY s.name`);
  const first = (n: string) => n.trim().split(/\s+/)[0] ?? n;
  const count = new Map<string, number>();
  for (const r of rows) count.set(slugOf(first(r.name)), (count.get(slugOf(first(r.name))) ?? 0) + 1);
  return rows.map((r) => {
    const f = first(r.name);
    const last = r.name.trim().split(/\s+/).slice(1).join(' ');
    const slug = (count.get(slugOf(f)) ?? 0) > 1 && last ? `${slugOf(f)}-${slugOf(last)[0]}` : slugOf(f);
    return { staffId: r.id, firstName: f, slug, services: r.n };
  });
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const money = (c: number | null) => (c == null ? '' : `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`);
const time = (m: number | null) => (m == null ? '' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} hr${m >= 120 ? 's' : ''}${m % 60 ? ` ${m % 60} min` : ''}`);

function page(title: string, salon: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="robots" content="noindex">
<style>
  :root { color-scheme: light; --ink: #2b2420; --soft: #6f655d; --line: #e5e0d8; --accent: #6b5242; --paper: #f7f5f2; }
  * { box-sizing: border-box; } body { margin: 0; background: var(--paper); color: var(--ink); font: 16px/1.5 system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif; }
  main { max-width: 640px; margin: 0 auto; padding: 40px 16px 64px; }
  .salon { margin: 0; font-size: 13px; letter-spacing: .12em; text-transform: uppercase; color: var(--soft); }
  h1 { margin: 6px 0 4px; font: 400 34px/1.15 Georgia, "Times New Roman", serif; }
  p.lead { margin: 0 0 24px; color: var(--soft); font-size: 15px; }
  ul { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--line); }
  li a { display: flex; align-items: center; gap: 12px; padding: 14px 4px; border-bottom: 1px solid var(--line); color: inherit; text-decoration: none; }
  li a:hover { background: #fff; }
  .name { flex: 1; min-width: 0; } .meta { color: var(--soft); font-size: 13px; white-space: nowrap; text-align: right; }
  .go { font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: var(--accent); white-space: nowrap; }
  .all { display: inline-block; margin-top: 28px; color: var(--accent); font-size: 14px; }
</style></head><body><main><p class="salon">${esc(salon)}</p>${body}</main></body></html>`;
}

/** Square's booking address for one service (by its item); the salon's booking page when Square's isn't set. */
const serviceLink = (base: string, fallback: string, itemId: string | null) => (base && itemId ? `${base.replace(/\/+$/, '')}/services/${encodeURIComponent(itemId)}` : fallback);

/** The page for one stylist, or null when there's no such stylist. */
export async function stylistPage(slug: string): Promise<string | null> {
  const link = (await stylistLinks()).find((l) => l.slug === slug.toLowerCase());
  if (!link) return null;
  const s = await getSettings();
  const tm = (await db().one<{ tm: string }>('SELECT square_team_member_id AS tm FROM staff WHERE id = $1', [link.staffId]))!.tm;
  const services = await db().query<{ name: string; item: string | null; price: number | null; mins: number | null }>(
    `SELECT name, square_item_id AS item, price_cents AS price, duration_minutes AS mins FROM services
      WHERE available_for_booking AND $1 = ANY(team_member_ids) ORDER BY name`, [tm]);
  const base = s.business.squareBookingBase ?? '';
  const items = services.map((v) => `<li><a href="${esc(serviceLink(base, s.business.bookingUrl, v.item))}" rel="noopener">
    <span class="name">${esc(v.name)}</span><span class="meta">${esc([money(v.price), time(v.mins)].filter(Boolean).join(' · '))}</span><span class="go">Book</span></a></li>`).join('');
  const body = `<h1>Book with ${esc(link.firstName)}</h1>
<p class="lead">Choose a service, then pick ${esc(link.firstName)} under Staff and a time that works for you.</p>
${services.length ? `<ul>${items}</ul>` : `<p class="lead">Online booking with ${esc(link.firstName)} isn’t open right now — <a href="${esc(s.business.bookingUrl)}">see all services</a>.</p>`}
<a class="all" href="${esc(s.business.bookingUrl)}">All services and stylists</a>`;
  return page(`Book with ${link.firstName} · ${s.business.name}`, s.business.name, body);
}

/** Every stylist's page, in one list (addendumsalon.info/book). */
export async function stylistIndexPage(): Promise<string> {
  const s = await getSettings();
  const links = (await stylistLinks()).filter((l) => l.services > 0);
  const body = `<h1>Book an appointment</h1><p class="lead">Choose your stylist.</p>
<ul>${links.map((l) => `<li><a href="/book/${esc(l.slug)}"><span class="name">${esc(l.firstName)}</span><span class="meta">${l.services} service${l.services === 1 ? '' : 's'}</span><span class="go">Book</span></a></li>`).join('')}</ul>
<a class="all" href="${esc(s.business.bookingUrl)}">All services</a>`;
  return page(`Book · ${s.business.name}`, s.business.name, body);
}
