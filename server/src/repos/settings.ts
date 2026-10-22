import { DEFAULT_APPEARANCE, DEFAULT_LOGIN, DEFAULT_WORKSPACES, type AppSettings } from '@addendum/shared';
import { db } from '../db/index.js';

export const DEFAULT_SETTINGS: AppSettings = {
  business: {
    name: 'Addendum Salon',
    address: 'San Diego, CA',
    phone: '',
    website: 'https://addendumsalon.square.site',
    bookingUrl: 'https://addendumsalon.square.site/s/appointments',
    // Google: opens the "write a review" box for Addendum Salon.
    reviewUrl: 'https://www.google.com/search?q=Addendum+Salon+12853+El+Camino+Real+San+Diego+CA#lrd=0x80dc0ecd7fb6aaab:0x3e215c50708febbd,3,,,,',
    timezone: 'America/Los_Angeles',
    hours: 'Tue–Sat 9:00 AM – 7:00 PM',
  },
  rules: {
    newLeadHours: 1,
    leadNoResponseHours: 24,
    leadSecondNoResponseHours: 48,
    cancellationEnabled: true,
    cancellationDelayHours: 2,
    noShowEnabled: true,
    noShowDelayHours: 1,
    reviewRequestEnabled: true,
    reviewDelayHours: 3,
    rebookingEnabled: true,
    rebookingGraceDays: 7,
    rebookingStopAfterDays: 365,
    rebookingMinVisits: 3,
    rebookingNoHistoryOnly: false,
    unreadMessageMinutes: 30,
  },
  reminders: {
    // Off by default: Square Appointments can already send reminders. Turn on only if Square's are off.
    enabled: false,
    offsetsHours: [48, 24, 2],
    autoSend: false,
    template:
      'Hi {firstName}! This is Addendum Salon reminding you of your {service} appointment on {date} at {time}. Reply C to confirm or call us to reschedule.',
  },
  reviews: {
    message:
      "Thanks for visiting Addendum Salon, {firstName}! We'd love to hear about your experience: {reviewUrl}",
    autoSend: false,
  },
  ai: { enabled: true, autoSend: false, tone: 'Warm, polished and concise — like a luxury salon front desk.' },
  inventorySync: { enabled: false, intervalMinutes: 15, firstSyncSource: 'square', holdChangesOver: 25 },
  commission: {
    enabled: false, autoSync: true, syncIntervalMinutes: 60, syncStartDate: null,
    basis: 'after_discounts', refunds: 'reverse', zeroPriced: 'no_commission', multiProvider: 'split_evenly',
    productAttribution: 'appointment_provider',
    unrecordedCheckout: { clientStylist: true, onTheClock: true, fallbackStaffId: null, hold: true },
    defaultServiceBps: 4000, defaultRetailBps: 1000, tips: 'separate', tipAttribution: 'service_share',
    disclaimer: 'Commission shown here is an estimate based on Square sales. Your final pay is confirmed with payroll and may differ.',
    payrollTaxes: { socialSecurityBps: 620, medicareBps: 145, futaBps: 60, sutaBps: 0, sdiBps: 130, stateIncomeBps: 400, workAddress: '12853 El Camino Real Ste 104, San Diego, CA 92130' },
    // Every 2 weeks, Saturday–Friday (e.g. Sep 26 – Oct 9, 2026), paid the following Friday (Oct 16).
    paySchedule: { frequency: 'biweekly', anchorStart: '2026-09-26', payDayOffsetDays: 7 },
  },
  replies: {
    // Starter set — the salon edits, adds and removes these in Settings → Saved replies.
    items: [
      { id: 'starter-new-lead', title: 'New inquiry — welcome', situations: ['new_lead', 'booking'],
        body: "Hi {firstName}! Thanks so much for reaching out to {salon}. We'd love to help with {service}. You can grab a time here: {bookingUrl} — or tell us what days work best and we'll find you a spot." },
      { id: 'starter-pricing', title: 'Pricing question', situations: ['pricing', 'new_lead'],
        body: "Hi {firstName}! Pricing depends on your hair length, density and the look you're going for, so we always start with a quick consultation (complimentary). Want me to book one for you? {bookingUrl}" },
      { id: 'starter-consult', title: 'Book a consultation', situations: ['consultation', 'booking', 'new_lead'],
        body: "Hi {firstName}! The best next step is a quick consultation so we can match your colour and plan the perfect look. Here's the link to choose a time: {bookingUrl}" },
      { id: 'starter-no-reply', title: 'Gentle follow-up', situations: ['no_reply', 'new_lead'],
        body: "Hi {firstName}, just checking in! Still thinking about {service}? Happy to answer any questions or hold a time for you. {signature}" },
      { id: 'starter-rebook', title: 'Time to rebook', situations: ['rebooking'],
        body: "Hi {firstName}! It's about that time — ready to book your next {service} with {stylist}? Here's the link: {bookingUrl} 💛" },
      { id: 'starter-cancel', title: 'After a cancellation', situations: ['cancellation'],
        body: "Hi {firstName}, no worries at all about your appointment! Whenever you're ready to reschedule, you can book here: {bookingUrl} — or just reply with a few times that work." },
      { id: 'starter-no-show', title: 'Missed appointment', situations: ['no_show'],
        body: "Hi {firstName}, we missed you today! Hope everything's okay. Would you like to find a new time? {bookingUrl}" },
      { id: 'starter-reschedule', title: 'Happy to reschedule', situations: ['reschedule'],
        body: "Of course, {firstName}! What days and times work best for you? You can also pick a new time here: {bookingUrl}" },
      { id: 'starter-reminder', title: 'Appointment reminder', situations: ['reminder'],
        body: "Hi {firstName}! Just a reminder of your {service} appointment on {date} at {time} with {stylist}. Reply C to confirm. See you soon!" },
      { id: 'starter-confirmed', title: "You're confirmed", situations: ['confirmed'],
        body: "Perfect, you're all set, {firstName}! See you on {date} at {time}. {signature}" },
      { id: 'starter-review', title: 'Ask for a review', situations: ['review', 'thanks'],
        body: "Thanks for coming in, {firstName}! If you loved your hair, we'd be so grateful for a quick review: {reviewUrl} 💛" },
      { id: 'starter-thanks', title: 'Thank you!', situations: ['thanks'],
        body: "Aw, thank you {firstName}! That truly made our day. We can't wait to see you again 💛" },
    ],
  },
  messaging: {
    autoCreateLeadFromUnknown: true,
    quietHoursStart: '20:00',
    quietHoursEnd: '08:00',
    signature: '— Addendum Salon',
  },
  notifications: { email: false, sms: false, browser: true, notifyEmail: '' },
  highlevel: {
    defaultAssigneeUserId: null,
    autoCreateContacts: true,
    automations: {
      new_lead: false,
      lead_no_response: false,
      cancelled: false,
      no_show: false,
      overdue_rebook: false,
      consultation_completed: false,
      follow_up_overdue: false,
    },
  },
  inventory: { orderEmail: 'gaby@addendumhair.com', ccRequester: true, catalog: [], orderFromName: 'Addendum Hair Order Form', orderFromAddress: '', sendAsSubmitter: true, senderDomains: [] },
  appearance: { ...DEFAULT_APPEARANCE },
  accounts: { allowAccessRequests: true },
  workspaces: DEFAULT_WORKSPACES,
  login: DEFAULT_LOGIN,
  access: { allowAnywhere: false, networks: [], restrictMobile: false },
  onboardingComplete: false,
  sharedSettings: { rules: false, rebooking: false, reminders: false, replies: false },
};

function deepMerge<T>(base: T, patch: any): T {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return (patch ?? base) as T;
  const out: any = { ...base };
  for (const k of Object.keys(patch ?? {})) {
    const bv = (base as any)[k];
    out[k] = bv && typeof bv === 'object' && !Array.isArray(bv) ? deepMerge(bv, patch[k]) : patch[k];
  }
  return out;
}

let cache: AppSettings | null = null;

export async function getSettings(): Promise<AppSettings> {
  if (cache) return cache;
  const row = await db().one<{ value: any }>("SELECT value FROM settings WHERE key = 'app'");
  cache = deepMerge(DEFAULT_SETTINGS, row?.value ?? {});
  return cache;
}

export async function updateSettings(patch: Partial<AppSettings> | Record<string, any>): Promise<AppSettings> {
  const current = await getSettings();
  const next = deepMerge(current, patch);
  // A role's default menu is replaced as a whole (so tabs moved back or names removed don't linger).
  const md = (patch as any)?.workspaces?.menuDefaults;
  if (md && next.workspaces) next.workspaces.menuDefaults = { ...(current.workspaces?.menuDefaults ?? {}), ...md };
  await db().query(
    `INSERT INTO settings(key, value, updated_at) VALUES ('app', $1::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify(next)],
  );
  cache = next;
  return next;
}

export function clearSettingsCache() {
  cache = null;
}

/** Generic key/value store for internal state (e.g. demo simulator state). */
export async function getKV<T>(key: string): Promise<T | null> {
  const row = await db().one<{ value: T }>('SELECT value FROM settings WHERE key = $1', [key]);
  return row?.value ?? null;
}

export async function setKV(key: string, value: unknown) {
  await db().query(
    `INSERT INTO settings(key, value, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}
