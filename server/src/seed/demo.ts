import bcrypt from 'bcryptjs';
import { DEFAULT_TAGS } from '@addendum/shared';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { saveDemoHL, loadDemoHL } from '../integrations/highlevel/MockHighLevelService.js';
import { demoSquareSimulator, saveDemoSquare, type DemoSquareState } from '../integrations/square/MockSquareService.js';
import type { SquareBooking, SquareCustomer } from '../integrations/square/types.js';
import { clearSettingsCache, getKV, setKV, updateSettings } from '../repos/settings.js';
import { badRequest } from '../lib/errors.js';
import { setClientTags } from '../repos/clients.js';
import { DAY, zonedToUtc } from '../lib/time.js';
import { handleInboundSms } from '../domain/messaging.js';
import { pushTaskToHighLevel } from '../domain/highlevelPush.js';
import { runRules } from '../domain/rulesEngine.js';
import { createInventoryRequest, setInventoryStatus } from '../domain/inventory.js';
import { runSquareSync, syncSingleBooking } from '../domain/squareSync.js';
import { createRule, syncCommission, type RuleInput } from '../domain/commission.js';
import { syncSquareInventory } from '../domain/squareInventory.js';

/**
 * DEMO MODE data. Builds a simulated Square account (customers, staff, services, bookings),
 * then imports it through the real sync pipeline, adds leads + text conversations, and runs the
 * follow-up rules — so everything on screen was produced by the same code that handles live data.
 * All names, numbers and emails are fictional (555 numbers, example.com).
 */
const TZ = 'America/Los_Angeles';
export const DEMO_PASSWORD = 'addendum-demo';

// Deterministic PRNG so demo data looks the same each reset.
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

function localAt(now: Date, daysFromToday: number, hour: number, minute = 0) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(now).reduce<Record<string, string>>((a, x) => ((a[x.type] = x.value), a), {});
  const base = new Date(Date.UTC(+p.year, +p.month - 1, +p.day + daysFromToday));
  return zonedToUtc(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), hour, minute, TZ);
}

const STAFF = [
  { key: 'lisa', name: 'Lisa Ha', email: 'owner@addendumsalon.com', role: 'admin', color: '#8C6E54', square: 'demo-tm-lisa', hl: 'demo-hlu-lisa' },
  { key: 'desk', name: 'Front Desk', email: 'frontdesk@addendumsalon.com', role: 'receptionist', color: '#7C8A86', square: null, hl: 'demo-hlu-desk' },
  { key: 'michael', name: 'Michael', email: 'michael@addendumsalon.com', role: 'stylist', color: '#B08968', square: 'demo-tm-michael', hl: 'demo-hlu-michael' },
  { key: 'kristoff', name: 'Kristoff', email: null, role: 'stylist', color: '#6D7A6A', square: 'demo-tm-kristoff', hl: null },
  { key: 'jennifer', name: 'Jennifer', email: 'jennifer@addendumsalon.com', role: 'stylist', color: '#A26769', square: 'demo-tm-jennifer', hl: 'demo-hlu-jennifer' },
  { key: 'tori', name: 'Tori', email: null, role: 'stylist', color: '#8E7DBE', square: 'demo-tm-tori', hl: null },
  { key: 'aubrie', name: 'Aubrie', email: null, role: 'stylist', color: '#C4A484', square: 'demo-tm-aubrie', hl: null },
  { key: 'carlos', name: 'Carlos', email: null, role: 'stylist', color: '#5E6472', square: 'demo-tm-carlos', hl: null },
  { key: 'ava', name: 'Ava (Assistant)', email: 'assistant@addendumsalon.com', role: 'assistant', color: '#9A8478', square: null, hl: null },
] as const;

const SERVICES = [
  { id: 'balayage', name: 'Balayage', min: 180, price: 28500 },
  { id: 'retouch', name: 'Root Retouch + Clear Gloss', min: 120, price: 16500 },
  { id: 'cut', name: "Women's Haircut", min: 60, price: 9500 },
  { id: 'blowout', name: 'Blowout', min: 45, price: 6500 },
  { id: 'brunette', name: 'Lived-In Brunette', min: 150, price: 24500 },
  { id: 'transform', name: 'Color Transformation', min: 240, price: 39500 },
  { id: 'botox', name: 'Hair Botox Treatment', min: 90, price: 15000 },
  { id: 'milbon', name: 'Milbon 5-Step Treatment', min: 60, price: 9500 },
  { id: 'polish', name: 'Hair Polish Treatment', min: 45, price: 7500 },
  { id: 'weft', name: 'Sewn Weft Extensions Install', min: 180, price: 45000 },
  { id: 'ktip', name: 'K-Tip Extensions Install', min: 240, price: 60000 },
  { id: 'moveup', name: 'Extension Move-Up', min: 120, price: 22500 },
  { id: 'extconsult', name: 'Extension Consultation', min: 30, price: 0 },
] as const;
type Svc = (typeof SERVICES)[number]['id'];
type StaffKey = (typeof STAFF)[number]['key'];

interface Profile {
  first: string; last: string; staff: StaffKey; services: Svc[];
  cadence: number; visits: number; lastDaysAgo: number;
  future?: { days: number; hour: number; minute?: number; svc?: Svc; status?: 'PENDING' };
  extra?: 'cancel_recent' | 'cancel_seller' | 'no_show_yesterday' | 'consult_yesterday' | 'reschedule';
  tags?: string[]; birthday?: string; note?: string;
}

const PROFILES: Profile[] = [
  { first: 'Sarah', last: 'Johnson', staff: 'michael', services: ['balayage', 'cut'], cadence: 45, visits: 6, lastDaysAgo: 38, future: { days: 7, hour: 14, svc: 'balayage' }, tags: ['VIP', 'Hair Color', 'Returning'], birthday: '0000-03-14', note: 'Cool-toned blonde. Sensitive scalp — use bond builder. Loves an oat milk latte.' },
  { first: 'Olivia', last: 'Bennett', staff: 'aubrie', services: ['brunette', 'cut'], cadence: 42, visits: 5, lastDaysAgo: 52, tags: ['Hair Color', 'Returning'] },
  { first: 'Emma', last: 'Rodriguez', staff: 'jennifer', services: ['moveup'], cadence: 56, visits: 5, lastDaysAgo: 80, tags: ['Extensions', 'At Risk'], note: 'Sewn weft, 22". Prefers Saturday mornings.' },
  { first: 'Chloe', last: 'Nguyen', staff: 'carlos', services: ['botox', 'blowout'], cadence: 35, visits: 4, lastDaysAgo: 41, tags: ['Returning'] },
  { first: 'Mia', last: 'Thompson', staff: 'michael', services: ['retouch'], cadence: 49, visits: 4, lastDaysAgo: 46, extra: 'cancel_recent', tags: ['Hair Color'] },
  { first: 'Ava', last: 'Patel', staff: 'tori', services: ['cut', 'polish'], cadence: 42, visits: 3, lastDaysAgo: 44, extra: 'cancel_seller' },
  { first: 'Isabella', last: 'Chen', staff: 'kristoff', services: ['retouch', 'cut'], cadence: 42, visits: 4, lastDaysAgo: 43, extra: 'no_show_yesterday', tags: ['Hair Color'] },
  { first: 'Sophia', last: 'Martinez', staff: 'aubrie', services: ['cut'], cadence: 63, visits: 3, lastDaysAgo: 1, tags: ['Haircut'] },
  { first: 'Grace', last: 'Kim', staff: 'tori', services: ['ktip', 'moveup'], cadence: 60, visits: 3, lastDaysAgo: 2, future: { days: 58, hour: 10, svc: 'moveup' }, tags: ['Extensions'] },
  { first: 'Hannah', last: 'Lee', staff: 'michael', services: ['balayage'], cadence: 70, visits: 3, lastDaysAgo: 72, future: { days: 0, hour: 9, minute: 30, svc: 'balayage' }, tags: ['Hair Color'] },
  { first: 'Lily', last: 'Walker', staff: 'carlos', services: ['cut', 'blowout'], cadence: 40, visits: 4, lastDaysAgo: 41, future: { days: 0, hour: 13, svc: 'cut' }, tags: ['Haircut'] },
  { first: 'Natalie', last: 'Brooks', staff: 'jennifer', services: ['weft'], cadence: 56, visits: 2, lastDaysAgo: 55, future: { days: 0, hour: 15, minute: 30, svc: 'moveup' }, tags: ['Extensions'] },
  { first: 'Zoe', last: 'Carter', staff: 'kristoff', services: ['transform'], cadence: 90, visits: 2, lastDaysAgo: 88, future: { days: 0, hour: 17, svc: 'polish' } },
  { first: 'Madison', last: 'Hayes', staff: 'aubrie', services: ['brunette'], cadence: 49, visits: 4, lastDaysAgo: 48, future: { days: 1, hour: 11, svc: 'brunette' }, tags: ['Returning'] },
  { first: 'Ella', last: 'Morgan', staff: 'tori', services: ['cut'], cadence: 45, visits: 2, lastDaysAgo: 46, future: { days: 1, hour: 14, svc: 'cut', status: 'PENDING' } },
  { first: 'Avery', last: 'Collins', staff: 'michael', services: ['retouch'], cadence: 42, visits: 3, lastDaysAgo: 40, future: { days: 3, hour: 12, svc: 'retouch', status: 'PENDING' } },
  { first: 'Scarlett', last: 'Reed', staff: 'carlos', services: ['cut'], cadence: 0, visits: 1, lastDaysAgo: 10, tags: ['New Client'] },
  { first: 'Aria', last: 'Foster', staff: 'kristoff', services: ['milbon', 'cut'], cadence: 30, visits: 2, lastDaysAgo: 38, tags: ['New Client'] },
  { first: 'Layla', last: 'Simmons', staff: 'jennifer', services: ['extconsult'], cadence: 0, visits: 0, lastDaysAgo: 0, extra: 'consult_yesterday', tags: ['Consultation', 'Extensions', 'Referral'] },
  { first: 'Camila', last: 'Ortiz', staff: 'aubrie', services: ['cut', 'botox'], cadence: 42, visits: 3, lastDaysAgo: 36, future: { days: 2, hour: 10, svc: 'botox' }, extra: 'reschedule' },
  { first: 'Penelope', last: 'Wright', staff: 'michael', services: ['retouch', 'blowout'], cadence: 28, visits: 8, lastDaysAgo: 18, future: { days: 10, hour: 9, svc: 'retouch' }, tags: ['VIP', 'Hair Color'], birthday: '1988-10-21' },
  { first: 'Riley', last: 'Adams', staff: 'tori', services: ['cut'], cadence: 49, visits: 4, lastDaysAgo: 30 },
  { first: 'Nora', last: 'Bishop', staff: 'kristoff', services: ['balayage', 'milbon'], cadence: 56, visits: 4, lastDaysAgo: 42, future: { days: 14, hour: 13, svc: 'balayage' } },
  { first: 'Victoria', last: 'Lane', staff: 'jennifer', services: ['brunette'], cadence: 60, visits: 4, lastDaysAgo: 98, tags: ['At Risk'] },
  { first: 'Jasmine', last: 'Ford', staff: 'tori', services: ['ktip'], cadence: 70, visits: 2, lastDaysAgo: 68, future: { days: 0, hour: 11, minute: 30, svc: 'moveup' }, tags: ['Extensions'] },
  { first: 'Brooke', last: 'Palmer', staff: 'carlos', services: ['blowout', 'polish'], cadence: 14, visits: 6, lastDaysAgo: 13, future: { days: 1, hour: 16, svc: 'blowout' }, tags: ['Returning'] },
  { first: 'Harper', last: 'Quinn', staff: 'michael', services: ['balayage', 'cut'], cadence: 56, visits: 3, lastDaysAgo: 34, future: { days: 4, hour: 10, svc: 'cut' } },
  { first: 'Stella', last: 'Vaughn', staff: 'aubrie', services: ['brunette'], cadence: 42, visits: 3, lastDaysAgo: 30, future: { days: 5, hour: 15, svc: 'brunette' } },
  { first: 'Lucy', last: 'Hart', staff: 'jennifer', services: ['moveup'], cadence: 56, visits: 4, lastDaysAgo: 50, future: { days: 6, hour: 9, svc: 'moveup' }, tags: ['Extensions'] },
  { first: 'Audrey', last: 'Blake', staff: 'kristoff', services: ['cut', 'milbon'], cadence: 35, visits: 5, lastDaysAgo: 28, future: { days: 8, hour: 16, svc: 'milbon' } },
  { first: 'Claire', last: 'Dunn', staff: 'tori', services: ['retouch'], cadence: 35, visits: 5, lastDaysAgo: 26, future: { days: 9, hour: 11, svc: 'retouch' } },
  { first: 'Elena', last: 'Ruiz', staff: 'carlos', services: ['blowout'], cadence: 21, visits: 6, lastDaysAgo: 15, future: { days: 6, hour: 17, svc: 'blowout' } },
];

const phoneFor = (i: number) => `+1619555${String(1100 + i * 7).padStart(4, '0')}`;
const tm = (k: StaffKey) => STAFF.find((s) => s.key === k)!.square!;
const svcVar = (id: Svc) => `demo-svc-${id}`;
const svcMin = (id: Svc) => SERVICES.find((s) => s.id === id)!.min;

function booking(id: string, customerId: string, staff: StaffKey, svc: Svc, start: Date, status: SquareBooking['status'] = 'ACCEPTED', createdAt?: Date): SquareBooking {
  return {
    id, version: 1, status, start_at: start.toISOString(), location_id: 'demo-loc-1', customer_id: customerId,
    created_at: (createdAt ?? new Date(start.getTime() - 14 * DAY)).toISOString(),
    updated_at: (createdAt ?? new Date(start.getTime() - 14 * DAY)).toISOString(),
    source: 'FIRST_PARTY_MERCHANT',
    appointment_segments: [{ duration_minutes: svcMin(svc), service_variation_id: svcVar(svc), team_member_id: tm(staff), service_variation_version: 1 }],
  };
}

function buildSquareState(now: Date): DemoSquareState {
  const rand = rng(42);
  const customers: SquareCustomer[] = [];
  const bookings: SquareBooking[] = [];
  let n = 0;
  const hours = [9, 10, 11, 12, 13, 14, 15, 16];
  PROFILES.forEach((p, i) => {
    const cid = `demo-cust-${i + 1}`;
    customers.push({
      id: cid, given_name: p.first, family_name: p.last, phone_number: phoneFor(i),
      email_address: `${p.first}.${p.last}@example.com`.toLowerCase(), birthday: p.birthday,
      created_at: new Date(now.getTime() - (p.lastDaysAgo + p.cadence * p.visits + 20) * DAY).toISOString(), creation_source: 'APPOINTMENTS',
    });
    for (let k = 0; k < p.visits; k++) {
      const daysAgo = p.lastDaysAgo + (p.visits - 1 - k) * p.cadence + (k === p.visits - 1 ? 0 : Math.floor(rand() * 5) - 2);
      const svc = p.services[k % p.services.length];
      bookings.push(booking(`demo-bk-${++n}`, cid, p.staff, svc, localAt(now, -daysAgo, hours[Math.floor(rand() * hours.length)])));
    }
    if (p.future) {
      const start = localAt(now, p.future.days, p.future.hour, p.future.minute ?? 0);
      bookings.push(booking(`demo-bk-${++n}`, cid, p.staff, p.future.svc ?? p.services[0], start, p.future.status ?? 'ACCEPTED', new Date(now.getTime() - 9 * DAY)));
    }
    if (p.extra === 'cancel_recent') {
      const b = booking(`demo-bk-${++n}`, cid, p.staff, p.services[0], localAt(now, 1, 10), 'CANCELLED_BY_CUSTOMER', new Date(now.getTime() - 12 * DAY));
      b.updated_at = new Date(now.getTime() - 20 * 3600_000).toISOString();
      bookings.push(b);
    }
    if (p.extra === 'cancel_seller') {
      const b = booking(`demo-bk-${++n}`, cid, p.staff, p.services[0], localAt(now, -2, 12), 'CANCELLED_BY_SELLER', new Date(now.getTime() - 15 * DAY));
      b.updated_at = new Date(now.getTime() - 3 * DAY).toISOString();
      b.seller_note = 'Stylist out sick — asked client to rebook.';
      bookings.push(b);
    }
    if (p.extra === 'no_show_yesterday') {
      bookings.push(booking(`demo-bk-${++n}`, cid, p.staff, p.services[0], localAt(now, -1, 14), 'NO_SHOW', new Date(now.getTime() - 10 * DAY)));
    }
    if (p.extra === 'consult_yesterday') {
      bookings.push(booking(`demo-bk-${++n}`, cid, p.staff, 'extconsult', localAt(now, -1, 16), 'ACCEPTED', new Date(now.getTime() - 6 * DAY)));
    }
  });
  // A few older cancellations/no-shows for analytics history.
  bookings.push(booking(`demo-bk-${++n}`, 'demo-cust-22', 'tori', 'cut', localAt(now, -20, 11), 'CANCELLED_BY_CUSTOMER'));
  bookings.push(booking(`demo-bk-${++n}`, 'demo-cust-26', 'carlos', 'blowout', localAt(now, -27, 15), 'NO_SHOW'));
  bookings.push(booking(`demo-bk-${++n}`, 'demo-cust-30', 'kristoff', 'cut', localAt(now, -12, 10), 'CANCELLED_BY_CUSTOMER'));
  return {
    merchantName: 'Addendum Salon (Demo Square account)',
    locations: [{ id: 'demo-loc-1', name: 'Addendum Salon', timezone: TZ, address: 'San Diego, CA' }],
    team: STAFF.filter((s) => s.square).map((s) => ({ id: s.square!, given_name: s.name.split(' ')[0], family_name: s.name.split(' ')[1] ?? '', email_address: s.email ?? undefined, status: 'ACTIVE', is_owner: s.role === 'admin' })),
    services: SERVICES.map((s) => ({ variationId: svcVar(s.id), itemId: `demo-item-${s.id}`, name: s.name, durationMinutes: s.min, priceCents: s.price })),
    customers,
    bookings,
  };
}

const ALL_TABLES = ['inventory_request_items', 'inventory_requests', 'audit_logs', 'notifications', 'automation_runs', 'webhook_events', 'messages', 'conversations', 'tasks', 'notes', 'client_tags', 'tags',
  'appointment_events', 'appointment_services', 'appointments', 'client_staff', 'leads', 'clients', 'services', 'locations', 'sessions', 'integrations', 'settings', 'staff'];

export async function wipeAll() {
  await db().query(`TRUNCATE ${ALL_TABLES.join(', ')} CASCADE`);
  clearSettingsCache();
}

/**
 * Demo data replaces everything, so it only ever runs on an empty database or one it created itself — never on a
 * database with real accounts (e.g. when DEMO_MODE was left on by mistake).
 */
export async function assertDemoDatabase() {
  const staff = (await db().one<{ n: number }>('SELECT count(*)::int AS n FROM staff'))!.n;
  if (staff && !(await getKV('demo.seeded'))) {
    throw badRequest('This database has real accounts, so demo data won’t replace it. Turn Demo Mode off (DEMO_MODE=false).');
  }
}

export async function seedDemo(now = new Date()) {
  await assertDemoDatabase();
  await wipeAll();
  await setKV('demo.seeded', { at: now.toISOString() });
  const hash = await bcrypt.hash(config().OWNER_PASSWORD || DEMO_PASSWORD, 10);
  const staffIds: Record<string, string> = {};
  for (const s of STAFF) {
    const row = await db().one<{ id: string }>(
      `INSERT INTO staff(name, email, role, color, square_team_member_id, highlevel_user_id, password_hash) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [s.name, s.key === 'lisa' ? config().OWNER_EMAIL : s.email, s.role, s.color, s.square, s.hl, s.email ? hash : null],
    );
    staffIds[s.key] = row!.id;
  }
  for (const t of DEFAULT_TAGS) await db().query('INSERT INTO tags(name, is_default) VALUES ($1, true) ON CONFLICT DO NOTHING', [t]);
  await updateSettings({ business: { phone: '(619) 555-0100', reviewUrl: 'https://g.page/r/addendum-salon-demo/review' }, highlevel: { defaultAssigneeUserId: 'demo-hlu-desk' } as any });

  // Simulated Square + HighLevel accounts.
  await saveDemoSquare(buildSquareState(now));
  await saveDemoHL({
    outage: false,
    users: [
      { id: 'demo-hlu-lisa', name: 'Lisa Ha', email: 'owner@addendumsalon.com' },
      { id: 'demo-hlu-desk', name: 'Front Desk', email: 'frontdesk@addendumsalon.com' },
      { id: 'demo-hlu-michael', name: 'Michael', email: 'michael@addendumsalon.com' },
      { id: 'demo-hlu-jennifer', name: 'Jennifer', email: 'jennifer@addendumsalon.com' },
    ],
    contacts: [
      { id: 'demo-hlc-sarah', name: 'Sarah Johnson', phone: phoneFor(0), email: 'sarah.johnson@example.com' },
      { id: 'demo-hlc-olivia', name: 'Olivia Bennett', phone: phoneFor(1), email: 'olivia.bennett@example.com' },
    ],
    tasks: [],
  });

  // Import through the real sync pipeline.
  const sync = await runSquareSync({ full: true });
  if (!sync.ok) throw new Error(`Demo import failed: ${sync.message}`);

  // A reschedule detected by the sync (Camila's appointment moved by 2 days in Square).
  const camila = PROFILES.findIndex((p) => p.extra === 'reschedule');
  const state = await import('../integrations/square/MockSquareService.js').then((m) => m.loadDemoSquare());
  const camilaBooking = state.bookings.find((b) => b.customer_id === `demo-cust-${camila + 1}` && new Date(b.start_at) > now);
  if (camilaBooking) {
    await demoSquareSimulator.updateBooking(camilaBooking.id, { start_at: new Date(new Date(camilaBooking.start_at).getTime() + 2 * DAY).toISOString() });
    await syncSingleBooking(camilaBooking.id);
  }

  // Client details that live only in the CRM (tags, notes, preferred stylist).
  for (const [i, p] of PROFILES.entries()) {
    const c = await db().one<{ id: string }>('SELECT id FROM clients WHERE square_customer_id = $1', [`demo-cust-${i + 1}`]);
    if (!c) continue;
    await db().query('UPDATE clients SET preferred_staff_id = $2, lead_source = COALESCE(lead_source, $3) WHERE id = $1', [
      c.id, staffIds[p.staff], ['Instagram', 'Referral', 'Google', 'Website'][i % 4],
    ]);
    if (p.tags) await setClientTags(c.id, p.tags);
    if (p.note) await db().query('INSERT INTO notes(client_id, author_staff_id, body, pinned) VALUES ($1,$2,$3,true)', [c.id, staffIds[p.staff], p.note]);
  }

  await seedLeadsAndMessages(now, staffIds);
  await runRules(now);
  await seedHighLevelExamples(staffIds);
  await seedInventory(now, staffIds);
  await seedCommission(staffIds);
  await db().query('DELETE FROM notifications');
  await setKV('demo.seededAt', now.toISOString());
}

/** Demo commission plan (example rates — set the salon's real plan in Settings → Commission), then a sales sync. */
async function seedCommission(staff: Record<string, string>) {
  await updateSettings({ commission: { enabled: true } });
  const from = '2026-01-01';
  const rule = (r: Partial<RuleInput>) => createRule({ staffId: null, category: 'service', targetType: 'all', targetId: null, method: 'percent', rateBps: null,
    flatCents: null, tiers: null, tierPeriod: 'month', effectiveFrom: from, effectiveTo: null, note: 'Demo example', ...r }, null);
  await rule({ category: 'service', rateBps: 4000 });
  await rule({ category: 'retail', rateBps: 1000 });
  await rule({ staffId: staff.jennifer, category: 'service', method: 'tiered', tiers: [{ upToCents: 50000, rateBps: 4000 }, { upToCents: null, rateBps: 4500 }] });
  const consult = await db().one<any>("SELECT id FROM services WHERE name = 'Extension Consultation'");
  if (consult) await rule({ category: 'service', targetType: 'service', targetId: consult.id, rateBps: 0 });
  await syncSquareInventory();
  await syncCommission({ trigger: 'manual' });
}

async function seedLeadsAndMessages(now: Date, staff: Record<string, string>) {
  const ago = (h: number) => new Date(now.getTime() - h * 3600_000);
  const leads: { name: string; phone: string; email?: string; source: string; svc: string; status: string; staff?: string; createdH: number; contactH?: number; inboundH?: number; notes?: string }[] = [
    { name: 'Jane Smith', phone: '+16195552001', email: 'jane.smith@example.com', source: 'Instagram', svc: 'Extensions', status: 'new', staff: 'jennifer', createdH: 26, inboundH: 26, notes: 'Fine hair, wants volume. Asked about sewn weft vs K-tips.' },
    { name: 'Danielle Price', phone: '+16195552002', email: 'danielle.price@example.com', source: 'Website', svc: 'Balayage', status: 'new', staff: 'michael', createdH: 3 },
    { name: 'Megan Torres', phone: '+16195552003', source: 'Referral', svc: 'Hair Botox Treatment', status: 'contacted', staff: 'carlos', createdH: 40, contactH: 30 },
    { name: 'Kelsey Ward', phone: '+16195552004', email: 'kelsey.ward@example.com', source: 'Instagram', svc: 'K-Tip Extensions', status: 'waiting', staff: 'tori', createdH: 100, contactH: 72, inboundH: 90 },
    { name: 'Priya Shah', phone: '+16195552005', email: 'priya.shah@example.com', source: 'Website', svc: 'Color Transformation', status: 'interested', staff: 'kristoff', createdH: 60, contactH: 30, inboundH: 24 },
    { name: 'Alyssa Moore', phone: '+16195552006', source: 'Google', svc: 'Extension Consultation', status: 'consultation_scheduled', staff: 'jennifer', createdH: 120, contactH: 100, inboundH: 98 },
    { name: 'Taylor Quinn', phone: '+16195552007', source: 'Event', svc: 'Hair Polish Treatment', status: 'booked', createdH: 200, contactH: 190, inboundH: 188, notes: 'Met at the Polish Party.' },
    { name: 'Jordan Ellis', phone: '+16195552008', source: 'Walk-in', svc: 'Blowout Membership', status: 'follow_up_needed', staff: 'carlos', createdH: 150, contactH: 52 },
    { name: 'Samantha Diaz', phone: '+16195552009', source: 'Instagram', svc: 'Balayage', status: 'won', staff: 'michael', createdH: 400, contactH: 390, inboundH: 389 },
    { name: 'Erin Walsh', phone: '+16195552010', source: 'Website', svc: 'Extensions', status: 'lost', createdH: 300, contactH: 290, notes: 'Went with a closer salon.' },
    { name: 'Nicole Haddad', phone: '+16195552011', source: 'Phone call', svc: 'Milbon 5-Step Treatment', status: 'new', createdH: 0.3 },
    { name: 'Bianca Russo', phone: '+16195552012', source: 'Referral', svc: 'Sewn Weft Extensions', status: 'contacted', staff: 'jennifer', createdH: 8, contactH: 5 },
  ];
  const leadIds: Record<string, string> = {};
  for (const l of leads) {
    const row = await db().one<{ id: string }>(
      `INSERT INTO leads(name, phone, email, source, service_interest, status, assigned_staff_id, created_at, last_contact_at, last_inbound_at, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [l.name, l.phone, l.email ?? null, l.source, l.svc, l.status, l.staff ? staff[l.staff] : null, ago(l.createdH),
        l.contactH ? ago(l.contactH) : null, l.inboundH ? ago(l.inboundH) : null, l.notes ?? null],
    );
    leadIds[l.name] = row!.id;
  }

  const clientByName = async (first: string) => (await db().one<any>('SELECT id, phone FROM clients WHERE first_name = $1', [first]))!;
  const convo = async (phone: string, link: { clientId?: string; leadId?: string }) => (await db().one<{ id: string }>(
    `INSERT INTO conversations(phone, client_id, lead_id) VALUES ($1,$2,$3) ON CONFLICT (phone) DO UPDATE SET updated_at = now() RETURNING id`,
    [phone, link.clientId ?? null, link.leadId ?? null]))!.id;
  const msg = async (cid: string, dir: 'inbound' | 'outbound', body: string, hoursAgo: number, by?: string) => {
    await db().query(
      `INSERT INTO messages(conversation_id, direction, body, status, provider_message_id, sent_by_staff_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [cid, dir, body, dir === 'inbound' ? 'received' : 'delivered', `demo-seed-${Math.random().toString(36).slice(2)}`, by ? staff[by] : null, ago(hoursAgo)],
    );
  };
  const finish = async (cid: string, unread: number, insight?: object) => {
    await db().query(
      `UPDATE conversations SET unread_count = $2, insight = $3::jsonb,
         last_message_at = (SELECT max(created_at) FROM messages WHERE conversation_id = $1),
         last_inbound_at = (SELECT max(created_at) FROM messages WHERE conversation_id = $1 AND direction = 'inbound') WHERE id = $1`,
      [cid, unread, insight ? JSON.stringify(insight) : null],
    );
  };

  let c = await convo('+16195552001', { leadId: leadIds['Jane Smith'] });
  await msg(c, 'inbound', "Hi! Do you do sewn-in weft extensions? I have pretty fine hair and want more volume. I'm free most weekends.", 26);
  await finish(c, 1, { intent: 'booking_request', isPotentialLead: true, service: 'Extensions', timeframe: 'This week', summary: 'Potential lead · Service: Extensions' });

  c = await convo('+16195552003', { leadId: leadIds['Megan Torres'] });
  await msg(c, 'outbound', "Hi Megan! Thank you for reaching out about our Hair Botox Treatment — it's perfect for frizz and shine. Would you like to come in this week or next? — Addendum Salon", 30, 'desk');
  await finish(c, 0);

  c = await convo('+16195552004', { leadId: leadIds['Kelsey Ward'] });
  await msg(c, 'inbound', 'How much are K-tips for shoulder length hair?', 90);
  await msg(c, 'outbound', "Hi Kelsey! K-tip pricing depends on length and density — we'd love to do a quick consultation so Tori can match your shade. Does Thursday or Saturday work? — Addendum Salon", 72, 'tori');
  await finish(c, 0);

  c = await convo('+16195552005', { leadId: leadIds['Priya Shah'] });
  await msg(c, 'outbound', 'Hi Priya! Kristoff would love to help with your color transformation. Can you send a current photo and your inspiration?', 30, 'desk');
  await msg(c, 'inbound', 'Yes!! Sending now. Do you have anything Saturday?', 24);
  await finish(c, 0, { intent: 'booking_request', isPotentialLead: true, service: 'Hair Color', timeframe: 'Saturday', summary: 'Potential lead · Service: Hair Color · Timeframe: Saturday' });

  const sarah = await clientByName('Sarah');
  c = await convo(sarah.phone, { clientId: sarah.id });
  await msg(c, 'outbound', 'Hi Sarah! Michael has you down for balayage next week. Reply C to confirm. — Addendum Salon', 50, 'desk');
  await msg(c, 'inbound', "C! Can't wait 🤍", 49);
  await finish(c, 0);

  const isabella = await clientByName('Isabella');
  c = await convo(isabella.phone, { clientId: isabella.id });
  await msg(c, 'inbound', 'So sorry I missed my appointment yesterday, my car broke down 😩 can I reschedule?', 2);
  await finish(c, 1, { intent: 'reschedule', isPotentialLead: false, service: null, timeframe: null, summary: 'reschedule' });

  const madison = await clientByName('Madison');
  c = await convo(madison.phone, { clientId: madison.id });
  await msg(c, 'outbound', 'Hi Madison! A friendly reminder of your appointment tomorrow at 11:00 AM with Aubrie. Reply C to confirm.', 20, 'desk');
  await msg(c, 'inbound', 'C', 19);
  await finish(c, 0);
  await db().query(`UPDATE appointments SET client_confirmed_at = $2 WHERE client_id = $1 AND start_at > now()`, [madison.id, ago(19)]);

  const grace = await clientByName('Grace');
  c = await convo(grace.phone, { clientId: grace.id });
  await msg(c, 'inbound', 'Obsessed with my hair!! Thank you Tori 🤍', 30);
  await finish(c, 0);

  // A brand-new inbound text from an unknown number goes through the real inbound pipeline
  // (AI insight + automatic lead creation).
  const r = await handleInboundSms({ from: '+16195552099', body: "Hi, I'm looking to get my hair colored next week.", providerMessageId: 'demo-seed-unknown-1' });
  if ('conversationId' in r && r.conversationId) {
    await db().query(`UPDATE messages SET created_at = $2 WHERE conversation_id = $1`, [r.conversationId, ago(0.7)]);
    await db().query(`UPDATE conversations SET last_message_at = $2, last_inbound_at = $2 WHERE id = $1`, [r.conversationId, ago(0.7)]);
    await db().query(`UPDATE leads SET created_at = $1 WHERE phone = '+16195552099'`, [ago(0.7)]);
  }

  // Lead notes (internal) + link the won lead to a client.
  await db().query('INSERT INTO notes(lead_id, author_staff_id, body) VALUES ($1,$2,$3)', [leadIds['Jane Smith'], staff.jennifer, 'Sent IG DM too. Suggest a consultation first.']);
  await db().query(`UPDATE leads SET client_id = (SELECT id FROM clients WHERE first_name = 'Penelope') WHERE id = $1`, [leadIds['Samantha Diaz']]);

  // Manual follow-ups + an internal (non-client) task.
  const penelope = await clientByName('Penelope');
  await db().query(
    `INSERT INTO tasks(kind, type, title, reason, priority, due_at, client_id, assigned_staff_id, created_by_staff_id) VALUES
     ('follow_up','call','Call Penelope about her birthday gloss','VIP — birthday this month. Offer a complimentary gloss add-on.','medium',$1,$2,$3,$4),
     ('task','internal','Reorder Milbon treatment stock','Down to 3 bottles of step 2.','low',$5,NULL,$4,$4)`,
    [new Date(now.getTime() + 4 * 3600_000), penelope.id, staff.michael, staff.lisa, new Date(now.getTime() + 2 * DAY)],
  );
}

async function seedHighLevelExamples(staff: Record<string, string>) {
  // One follow-up already in HighLevel (matched to an existing HL contact by phone).
  const olivia = await db().one<any>(`SELECT t.id FROM tasks t JOIN clients c ON c.id = t.client_id WHERE c.first_name = 'Olivia' AND t.type = 'rebook'`);
  if (olivia) await pushTaskToHighLevel(olivia.id);
  const jane = await db().one<any>(`SELECT t.id FROM tasks t JOIN leads l ON l.id = t.lead_id WHERE l.name = 'Jane Smith' AND t.type = 'new_lead'`);
  if (jane) await pushTaskToHighLevel(jane.id, { createContactIfMissing: true });
  // One that failed during a (simulated) HighLevel outage — safe here, waiting for retry.
  const hl = await loadDemoHL();
  await saveDemoHL({ ...hl, outage: true });
  const emma = await db().one<any>(`SELECT t.id FROM tasks t JOIN clients c ON c.id = t.client_id WHERE c.first_name = 'Emma' AND t.type = 'rebook'`);
  if (emma) await pushTaskToHighLevel(emma.id, { createContactIfMissing: true });
  await saveDemoHL({ ...(await loadDemoHL()), outage: false });
  void staff;
}

/** Demo Addendum Hair order requests (product names are generic demo examples). */
const DEMO_CATALOG = ['Hand-Tied Weft', 'K-Tip Extensions', 'Tape-In Extensions', 'I-Tip Extensions', 'Clip-In Set', 'Extension Care Kit', 'Bond Remover', 'Weft Thread'];

async function seedInventory(now: Date, staff: Record<string, string>) {
  await updateSettings({ inventory: { orderEmail: 'gaby@addendumhair.com', ccRequester: true, catalog: DEMO_CATALOG } });
  const make = async (by: string, forKey: string, daysAgo: number, input: Parameters<typeof createInventoryRequest>[0], status?: 'ordered' | 'received') => {
    // Demo orders are typed items (not picked from Shopify), so they don't change any stock.
    const { request: r } = await createInventoryRequest({ neededBy: due, ...input, forStaffId: staff[forKey] }, staff[by]);
    const at = new Date(now.getTime() - daysAgo * DAY);
    await db().query('UPDATE inventory_requests SET created_at = $2, email_sent_at = $2, email_last_attempt_at = $2 WHERE id = $1', [r.id, at]);
    if (status) {
      await setInventoryStatus(r.id, status, staff.lisa);
      await db().query('UPDATE inventory_requests SET status_changed_at = $2 WHERE id = $1', [r.id, new Date(at.getTime() + DAY)]);
    }
  };
  const due = new Date(now.getTime() + 3 * DAY).toISOString().slice(0, 10);
  const later = new Date(now.getTime() + 10 * DAY).toISOString().slice(0, 10);
  await make('carlos', 'carlos', 12, { items: [
    { collection: 'Tape-In Extensions', size: '16"', color: '#8 Chestnut', quantity: 2 },
    { collection: 'Bond Remover', quantity: 1 },
  ] }, 'received');
  await make('jennifer', 'jennifer', 4, { note: 'For two move-up appointments next week.', items: [
    { collection: 'Hand-Tied Weft', size: '20"', color: '#60 Platinum', quantity: 3, neededBy: later },
    { collection: 'Hand-Tied Weft', size: '20"', color: '#18/22 Balayage', quantity: 2, neededBy: later },
    { collection: 'Weft Thread', color: 'Blonde', quantity: 1 },
  ] }, 'ordered');
  await make('desk', 'tori', 0.1, { note: 'Client moved her install up — please confirm stock today.', items: [
    { collection: 'K-Tip Extensions', size: '22"', color: '#1B Natural Black', quantity: 2, neededBy: due },
    { collection: 'Extension Care Kit', quantity: 1, neededBy: due },
  ] });
}
