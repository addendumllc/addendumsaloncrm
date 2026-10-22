import { db } from '../db/index.js';
import { hairHighLevelService } from '../integrations/registry.js';
import type { HLContact, HLContactCursor } from '../integrations/highlevel/HighLevelService.js';
import { getKV, setKV } from '../repos/settings.js';

/** Addendum Hair → HighLevel: which contacts are its clients (a tag, or everyone), and the last pull. */
export interface HairHighLevelSettings {
  tag: string | null;
  auto: boolean;
  lastPullAt: string | null;
  lastResult: { added: number; updated: number; matched: number; scanned: number } | null;
  lastError: string | null;
}
const KEY = 'hair.highlevel';
const DEFAULTS: HairHighLevelSettings = { tag: 'Addendum Hair', auto: false, lastPullAt: null, lastResult: null, lastError: null };

export const getHairHighLevel = async (): Promise<HairHighLevelSettings> => ({ ...DEFAULTS, ...((await getKV<Partial<HairHighLevelSettings>>(KEY)) ?? {}) });
export async function setHairHighLevel(patch: Partial<HairHighLevelSettings>) {
  const next = { ...(await getHairHighLevel()), ...patch };
  await setKV(KEY, next);
  return next;
}

const MAX_PAGES = 200; // 20,000 contacts

/**
 * Pulls Addendum Hair's clients from HighLevel: every contact with the tag (or every contact when there's no tag, e.g.
 * Addendum Hair's own sub-account). Each is matched by its HighLevel contact, then by email; new ones are added.
 * Name, email, phone and company follow HighLevel; notes and tasks in the CRM are left alone. Nothing is deleted.
 */
export async function pullHairClients() {
  const conn = hairHighLevelService();
  if (!conn) throw new Error('HighLevel isn’t connected.');
  const s = await getHairHighLevel();
  const tag = s.tag?.trim().toLowerCase() || null;
  const result = { added: 0, updated: 0, matched: 0, scanned: 0 };
  try {
    let after: HLContactCursor | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const { contacts, next } = await conn.svc.listContacts(after);
      for (const c of contacts) {
        result.scanned++;
        if (tag && !c.tags.some((t) => t.trim().toLowerCase() === tag)) continue;
        if (!c.name && !c.email && !c.phone) continue;
        result.matched++;
        const r = await upsert(c);
        if (r) result[r]++;
      }
      if (!next) break;
      after = next;
    }
  } catch (e) {
    await setHairHighLevel({ lastError: (e as Error).message, lastPullAt: new Date().toISOString() });
    throw e;
  }
  await setHairHighLevel({ lastPullAt: new Date().toISOString(), lastResult: result, lastError: null });
  return { ...result, source: conn.source };
}

async function upsert(c: HLContact): Promise<'added' | 'updated' | null> {
  const name = c.name || c.email || c.phone!;
  const existing =
    (await db().one<any>('SELECT * FROM hair_clients WHERE highlevel_contact_id = $1', [c.id])) ??
    (c.email ? await db().one<any>('SELECT * FROM hair_clients WHERE lower(email) = lower($1) AND highlevel_contact_id IS NULL', [c.email]) : null);
  // An email another client already has stays with that client.
  const emailFree = async (exceptId: string | null) =>
    !c.email || !(await db().one('SELECT 1 FROM hair_clients WHERE lower(email) = lower($1) AND id IS DISTINCT FROM $2', [c.email, exceptId]));
  if (!existing) {
    const email = (await emailFree(null)) ? c.email : null;
    await db().query('INSERT INTO hair_clients (name, email, phone, company, highlevel_contact_id) VALUES ($1, $2, $3, $4, $5)', [name, email, c.phone, c.company, c.id]);
    return 'added';
  }
  const next = {
    name,
    email: c.email && (await emailFree(existing.id)) ? c.email : existing.email,
    phone: c.phone ?? existing.phone,
    company: c.company ?? existing.company,
  };
  const changed = existing.highlevel_contact_id !== c.id || (['name', 'email', 'phone', 'company'] as const).some((k) => (existing[k] ?? null) !== (next[k] ?? null));
  if (!changed) return null;
  await db().query('UPDATE hair_clients SET name = $2, email = $3, phone = $4, company = $5, highlevel_contact_id = $6, updated_at = now() WHERE id = $1',
    [existing.id, next.name, next.email, next.phone, next.company, c.id]);
  return 'updated';
}

/** Scheduler: an automatic pull every hour when it's turned on. */
export async function maybeAutoPullHairClients() {
  const s = await getHairHighLevel();
  if (!s.auto || !hairHighLevelService()) return;
  if (s.lastPullAt && Date.now() - Date.parse(s.lastPullAt) < 60 * 60_000) return;
  await pullHairClients();
}
