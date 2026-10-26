import crypto from 'node:crypto';
import { db } from '../db/index.js';
import { gmailClient, type GmailMessage } from '../integrations/google/gmail.js';
import { IntegrationError, badRequest, notFound } from '../lib/errors.js';
import { iso } from '../lib/time.js';
import { toE164 } from '../lib/phone.js';
import { getIntegration } from '../repos/integrations.js';
import { getKV, getSettings, setKV } from '../repos/settings.js';
import { runRules } from './rulesEngine.js';
import { createTask } from './tasks.js';

/**
 * Website Inquiries: Showit form notifications in the salon's Gmail become new-client inquiries in the CRM.
 *
 * - Only emails from senders an administrator has verified (after looking at real notifications) are read.
 * - Each one gets the "Showit Website Inquiries" label and stays in the inbox, so Showit's emails still arrive as before.
 * - Each submission is handled once (by Gmail message id, and the same submission arriving twice is a duplicate).
 * - Extension consultation requests and general salon inquiries are routed to their people; anything unclear goes to
 *   review instead of guessing. One follow-up per submission (the new-client follow-up, or one on an open inquiry).
 */
export interface ShowitSettings {
  account: string;
  label: string;
  /** Verified Showit notification senders (email addresses). Nothing is read until one is verified. */
  senders: string[];
  /** Who extension consultation requests go to (else the front desk, flagged as an extension consultation). */
  extensionAssigneeId: string | null;
  /** The front desk: general inquiries (and extension ones when no one is set for them). */
  frontDeskAssigneeId: string | null;
  enabled: boolean;
  /** Notifications from before this time aren't brought in (set when the first sender is verified). */
  since: string | null;
}
const KEY = 'showit.settings';
export const DEFAULT_SHOWIT: ShowitSettings = {
  account: 'salon.addendum@gmail.com', label: 'Showit Website Inquiries', senders: [], extensionAssigneeId: null, frontDeskAssigneeId: null, enabled: true, since: null,
};
export const showitSettings = async (): Promise<ShowitSettings> => ({ ...DEFAULT_SHOWIT, ...((await getKV<Partial<ShowitSettings>>(KEY)) ?? {}) });

export async function saveShowitSettings(p: Partial<ShowitSettings>) {
  const cur = await showitSettings();
  const senders = p.senders ? [...new Set(p.senders.map((s) => s.trim().toLowerCase()).filter(Boolean))] : cur.senders;
  // Starting point: the moment the first sender is verified (older notifications aren't brought in).
  const since = cur.since ?? (senders.length ? new Date().toISOString() : null);
  const next = { ...cur, ...p, senders, since };
  await setKV(KEY, next);
  return next;
}

const addressOf = (from: string) => (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase();

// ---------------- Parsing ----------------
export interface Parsed { fields: { label: string; value: string }[]; contact: { name: string | null; email: string | null; phone: string | null; instagram: string | null }; page: string | null }

/** "Label: value" lines, or a label line ("…?" or "…:") followed by its answer. */
export function parseShowit(text: string, sender = ''): Parsed {
  const lines = text.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  const fields: { label: string; value: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const m = l.match(/^([^:]{1,160}?):\s*(.+)$/);
    if (m && !/^https?$/i.test(m[1].trim())) { fields.push({ label: m[1].trim(), value: m[2].trim() }); continue; }
    if (/[:?]$/.test(l) && l.length <= 300 && lines[i + 1] && !/[:?]$/.test(lines[i + 1])) { fields.push({ label: l.replace(/:$/, '').trim(), value: lines[i + 1] }); i++; }
  }
  const find = (re: RegExp, not?: RegExp) => fields.find((f) => re.test(f.label) && !(not && not.test(f.label)))?.value ?? null;
  const emailRe = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
  const own = sender.toLowerCase();
  const email = (find(/e-?mail/i)?.match(emailRe)?.[0] ?? text.match(new RegExp(emailRe.source, 'gi'))?.find((e) => e.toLowerCase() !== own && !/showit|no-?reply/i.test(e)) ?? null)?.toLowerCase() ?? null;
  const phoneRaw = find(/phone|mobile|cell/i) ?? text.match(/(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/)?.[0] ?? null;
  const page = text.match(/https?:\/\/(www\.)?addendumsalon\.com\/?[^\s)"]*/i)?.[0] ?? find(/page|url|form name/i);
  return {
    fields,
    contact: {
      name: find(/name/i, /instagram|user ?name|handle|form name|page/i),
      email, phone: phoneRaw ? toE164(phoneRaw) ?? phoneRaw : null,
      instagram: find(/instagram|\big\b/i),
    },
    page,
  };
}

/** Questions only the extension consultation form asks (the contact page's form, checked Oct 2026). */
const EXTENSION_QUESTIONS = /extensions? before|maintenance|pricing varies|length, density|ideal look|current hair|goals? are you hoping/i;
const EXTENSION_WORDS = /\bextensions?\b|k-?tips?|tape-?ins?|\bwefts?\b|hand-?tied|clip-?ins?|i-?tips?|beaded rows?/i;

/** Extension consultation, general inquiry, or review (with why) — never a guess. */
export function classify(p: Parsed): { kind: 'extension' | 'general' | null; reason: string | null } {
  if (!p.contact.name || (!p.contact.email && !p.contact.phone)) return { kind: null, reason: 'No name, or no email or phone, found in the notification.' };
  if (p.fields.some((f) => EXTENSION_QUESTIONS.test(f.label))) return { kind: 'extension', reason: null };
  if (p.fields.some((f) => EXTENSION_WORDS.test(f.value))) return { kind: null, reason: 'Mentions extensions but isn’t the extension consultation form — choose which it is.' };
  if (p.fields.length >= 3) return { kind: 'general', reason: null };
  return { kind: null, reason: 'Too little in the notification to tell what it’s about.' };
}

const hashOf = (p: Parsed, m: GmailMessage) => crypto.createHash('sha256').update(JSON.stringify([
  p.contact.email ?? '', p.contact.phone ?? '', m.date.slice(0, 16), p.fields.map((f) => `${f.label}=${f.value}`).sort(),
])).digest('hex');

// ---------------- Inquiries ----------------
/**
 * The inquiry in the CRM: a new client (whose new-client follow-up the rules create — exactly one), or, when they
 * already have an open inquiry, a note on it and one follow-up for this submission.
 */
async function toInquiry(gmailId: string, receivedAt: string, p: Parsed, kind: 'extension' | 'general') {
  const s = await showitSettings();
  const assignee = kind === 'extension' ? s.extensionAssigneeId ?? s.frontDeskAssigneeId : s.frontDeskAssigneeId;
  const flagged = kind === 'extension' && !s.extensionAssigneeId;
  const interest = kind === 'extension' ? 'Extension consultation' : 'General inquiry';
  const when = new Date(receivedAt).toLocaleString('en-US', { timeZone: (await getSettings()).business.timezone, dateStyle: 'medium', timeStyle: 'short' });
  const body = [
    `${flagged ? '⚑ Extension consultation — ' : ''}Website inquiry (Showit) received ${when}${p.page ? ` · ${p.page}` : ''}`,
    ...(p.contact.instagram ? [`Instagram: ${p.contact.instagram}`] : []),
    '',
    ...p.fields.filter((f) => !/^(name|e-?mail|phone)/i.test(f.label)).map((f) => `${f.label}\n${f.value}`),
  ].join('\n');
  const open = await db().one<{ id: string }>(
    `SELECT id FROM leads WHERE archived_at IS NULL AND status NOT IN ('won', 'lost') AND ((lower(email) = $1 AND $1 IS NOT NULL) OR (phone = $2 AND $2 IS NOT NULL))
      ORDER BY created_at DESC LIMIT 1`, [p.contact.email, p.contact.phone]);
  if (open) {
    await db().query('INSERT INTO notes(lead_id, body) VALUES ($1, $2)', [open.id, body]);
    await createTask({
      type: 'new_lead', title: `Follow up: new website inquiry from ${p.contact.name}`, reason: `${interest} — submitted again on the website.`, priority: 'high',
      dueAt: new Date(Date.now() + (await getSettings()).rules.newLeadHours * 3600_000), leadId: open.id, assignedStaffId: assignee, sourceRule: 'showit', dedupeKey: `showit:${gmailId}`,
    });
    return open.id;
  }
  const row = await db().one<{ id: string }>(
    `INSERT INTO leads(name, phone, email, source, service_interest, status, assigned_staff_id, notes, created_at) VALUES ($1,$2,$3,'Website',$4,'new',$5,$6,$7) RETURNING id`,
    [p.contact.name, p.contact.phone && p.contact.phone.startsWith('+') ? p.contact.phone : null, p.contact.email, interest, assignee, body, new Date(receivedAt)]);
  if (p.contact.phone?.startsWith('+')) await db().query('UPDATE conversations SET lead_id = $1 WHERE phone = $2 AND lead_id IS NULL', [row!.id, p.contact.phone]);
  await runRules(); // the new-client follow-up (one per inquiry)
  return row!.id;
}

/** Reads new notifications from verified senders: labels them, then files each one (or sends it to review). */
export async function processShowit() {
  const s = await showitSettings();
  const g = await gmailClient();
  const result = { read: 0, processed: 0, review: 0, duplicate: 0, failed: 0, skipped: '' };
  if (!g) { result.skipped = 'Gmail isn’t connected.'; return result; }
  if (!s.enabled) { result.skipped = 'Turned off.'; return result; }
  if (!s.senders.length) { result.skipped = 'No Showit sender verified yet.'; return result; }
  try {
    const labelId = await g.ensureLabel(s.label);
    const after = s.since ? Math.floor(Date.parse(s.since) / 1000) - 3600 : Math.floor(Date.now() / 1000) - 86400;
    const ids = await g.search(`{${s.senders.map((x) => `from:${x}`).join(' ')}} after:${after}`, 50);
    const known = new Set((await db().query<{ gmail_id: string }>('SELECT gmail_id FROM showit_messages WHERE gmail_id = ANY($1::text[])', [ids])).map((r) => r.gmail_id));
    for (const id of ids.filter((x) => !known.has(x)).reverse()) {
      const m = await g.get(id);
      const sender = addressOf(m.from);
      if (!s.senders.includes(sender)) continue; // Gmail's search matched loosely: only exact verified senders
      if (s.since && m.date < s.since) continue;
      result.read++;
      await g.addLabel(id, labelId);
      const p = parseShowit(m.text, sender);
      const hash = hashOf(p, m);
      const base = [id, m.date, sender, m.subject, JSON.stringify(p.fields), JSON.stringify(p.contact), p.page, hash];
      const dupe = await db().one<{ gmail_id: string }>("SELECT gmail_id FROM showit_messages WHERE content_hash = $1 AND status = 'processed'", [hash]);
      if (dupe) {
        await db().query(`INSERT INTO showit_messages(gmail_id, received_at, sender, subject, fields, contact, page, content_hash, status, reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'duplicate',$9)`, [...base, 'The same submission arrived again — already filed.']);
        result.duplicate++;
        continue;
      }
      const c = classify(p);
      if (!c.kind) {
        await db().query(`INSERT INTO showit_messages(gmail_id, received_at, sender, subject, fields, contact, page, content_hash, status, reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'review',$9)`, [...base, c.reason]);
        result.review++;
        continue;
      }
      try {
        const leadId = await toInquiry(id, m.date, p, c.kind);
        await db().query(`INSERT INTO showit_messages(gmail_id, received_at, sender, subject, fields, contact, page, content_hash, status, kind, lead_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'processed',$9,$10)`, [...base, c.kind, leadId]);
        result.processed++;
      } catch (e) {
        await db().query(`INSERT INTO showit_messages(gmail_id, received_at, sender, subject, fields, contact, page, content_hash, status, reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'failed',$9)`, [...base, (e as Error).message.slice(0, 300)]);
        result.failed++;
      }
    }
  } catch (e) {
    await setKV('showit.lastRun', { at: new Date().toISOString(), ok: false, message: e instanceof IntegrationError ? e.userMessage : (e as Error).message });
    throw e;
  }
  await setKV('showit.lastRun', { at: new Date().toISOString(), ok: true, message: `${result.read} read · ${result.processed} filed · ${result.review} to review${result.duplicate ? ` · ${result.duplicate} duplicate` : ''}${result.failed ? ` · ${result.failed} failed` : ''}` });
  return result;
}

/** Scheduler: only when connected and a sender is verified. */
export async function maybeProcessShowit() {
  if ((await getIntegration('gmail'))?.status !== 'connected') return;
  await processShowit();
}

/** Admin: a notification in review (or failed) filed as an extension or general inquiry — or ignored. */
export async function resolveShowit(gmailId: string, action: 'extension' | 'general' | 'ignore', staffId: string | null, contact?: { name?: string; email?: string; phone?: string }) {
  const r = await db().one<any>('SELECT * FROM showit_messages WHERE gmail_id = $1', [gmailId]);
  if (!r) throw notFound('That notification');
  if (r.status === 'processed') throw badRequest('That one is already filed.');
  if (action === 'ignore') {
    await db().query("UPDATE showit_messages SET status = 'ignored', resolved_by_staff_id = $2, updated_at = now() WHERE gmail_id = $1", [gmailId, staffId]);
    return null;
  }
  const p: Parsed = { fields: r.fields, page: r.page, contact: { ...r.contact, ...Object.fromEntries(Object.entries(contact ?? {}).filter(([, v]) => v)) } };
  if (p.contact.phone) p.contact.phone = toE164(p.contact.phone) ?? p.contact.phone;
  if (!p.contact.name || (!p.contact.email && !p.contact.phone)) throw badRequest('Add a name and an email or phone first.');
  const leadId = await toInquiry(gmailId, iso(r.received_at)!, p, action);
  await db().query("UPDATE showit_messages SET status = 'processed', kind = $2, lead_id = $3, contact = $4, reason = NULL, resolved_by_staff_id = $5, updated_at = now() WHERE gmail_id = $1",
    [gmailId, action, leadId, JSON.stringify(p.contact), staffId]);
  return leadId;
}

/**
 * Before a sender is trusted: recent emails that look like Showit form notifications, for an administrator to check
 * (sender, subject, and what the form fields read as). Nothing is filed from here.
 */
export async function showitCandidates() {
  const g = await gmailClient();
  if (!g) return [];
  const ids = await g.search('{from:showit.co from:showit.com from:showitapp.com subject:"form submission" subject:"new form" subject:"contact form"} newer_than:120d', 10);
  const out = [];
  for (const id of ids) {
    const m = await g.get(id);
    const p = parseShowit(m.text, addressOf(m.from));
    out.push({ id, from: m.from, sender: addressOf(m.from), subject: m.subject, date: m.date, fields: p.fields.slice(0, 20), contact: p.contact, classification: classify(p) });
  }
  return out;
}

/** People inquiries can be routed to (active team members). */
export const listStaffForPicker = async () => (await db().query<{ id: string; name: string; role: string }>("SELECT id, name, role FROM staff WHERE active AND approval_status = 'approved' ORDER BY name"));

export async function showitOverview() {
  const row = await getIntegration('gmail');
  const history = await db().query<any>(
    `SELECT m.gmail_id, m.received_at, m.sender, m.subject, m.status, m.kind, m.contact, m.fields, m.page, m.reason, m.lead_id, l.name AS lead_name
       FROM showit_messages m LEFT JOIN leads l ON l.id = m.lead_id ORDER BY m.received_at DESC LIMIT 200`);
  return {
    connection: { connected: row?.status === 'connected', email: row?.meta?.email ?? null, connectedAt: row?.meta?.connectedAt ?? null },
    settings: await showitSettings(),
    lastRun: await getKV<{ at: string; ok: boolean; message: string }>('showit.lastRun'),
    history: history.map((h) => ({
      gmailId: h.gmail_id, receivedAt: iso(h.received_at), sender: h.sender, subject: h.subject, status: h.status, kind: h.kind, contact: h.contact, fields: h.fields, page: h.page, reason: h.reason, leadId: h.lead_id, leadName: h.lead_name,
    })),
  };
}
