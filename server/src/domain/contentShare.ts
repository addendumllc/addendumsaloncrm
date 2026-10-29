import crypto from 'node:crypto';
import { db } from '../db/index.js';
import { badRequest, notFound } from '../lib/errors.js';
import { contentAccounts, publicMediaUrl } from './content.js';

/**
 * Sharing the Content Calendar with creators who don't have CRM accounts: a private link shows only the posts that are
 * shared — each post's sharing is Automatic (shared once approved), Always or Never — so drafts and unfinished work stay
 * private. Creators can view, download the photos and leave notes; they never change a post.
 */
export type CreatorShare = 'auto' | 'yes' | 'no';
export const SHARED_STATUSES = ['approved', 'scheduled', 'publishing', 'published'];
export const isShared = (p: { creator_share?: string | null; status: string }) => p.creator_share === 'yes' || ((p.creator_share ?? 'auto') === 'auto' && SHARED_STATUSES.includes(p.status));
/** The SQL test for the same thing. */
const SHARED_SQL = `(p.creator_share = 'yes' OR (p.creator_share = 'auto' AND p.status = ANY('{approved,scheduled,publishing,published}')))`;

export interface ShareLinkDTO { id: string; name: string; url: string; accounts: string[]; expiresOn: string | null; active: boolean; allowNotes: boolean; createdAt: string; lastViewedAt: string | null }
const linkDTO = (r: any, base: string): ShareLinkDTO => ({
  id: r.id, name: r.name, url: `${base}/share/${r.token}`, accounts: r.accounts ?? [], expiresOn: r.expires_on ? String(r.expires_on instanceof Date ? r.expires_on.toISOString() : r.expires_on).slice(0, 10) : null,
  active: r.active, allowNotes: r.allow_notes, createdAt: new Date(r.created_at).toISOString(), lastViewedAt: r.last_viewed_at ? new Date(r.last_viewed_at).toISOString() : null,
});
export async function listShareLinks(base: string) {
  return (await db().query<any>('SELECT * FROM content_share_links ORDER BY created_at DESC')).map((r) => linkDTO(r, base));
}
export async function createShareLink(b: { name: string; accounts: string[]; expiresOn: string | null; allowNotes: boolean }, staffId: string | null, base: string) {
  if (!b.name.trim()) throw badRequest('Who is it for? Add their name.');
  const token = crypto.randomBytes(18).toString('base64url');
  await db().query('INSERT INTO content_share_links(token, name, accounts, expires_on, allow_notes, created_by_staff_id) VALUES ($1,$2,$3,$4,$5,$6)',
    [token, b.name.trim().slice(0, 80), b.accounts, b.expiresOn, b.allowNotes, staffId]);
  return listShareLinks(base);
}
export async function updateShareLink(id: string, b: { name?: string; accounts?: string[]; expiresOn?: string | null; active?: boolean; allowNotes?: boolean }, base: string) {
  const set: string[] = []; const p: unknown[] = [id];
  const put = (c: string, v: unknown) => { p.push(v); set.push(`${c} = $${p.length}`); };
  if (b.name !== undefined) put('name', b.name.trim().slice(0, 80));
  if (b.accounts !== undefined) put('accounts', b.accounts);
  if (b.expiresOn !== undefined) put('expires_on', b.expiresOn);
  if (b.active !== undefined) put('active', b.active);
  if (b.allowNotes !== undefined) put('allow_notes', b.allowNotes);
  if (set.length) await db().query(`UPDATE content_share_links SET ${set.join(', ')} WHERE id = $1`, p);
  return listShareLinks(base);
}
export async function deleteShareLink(id: string, base: string) {
  await db().query('DELETE FROM content_share_links WHERE id = $1', [id]);
  return listShareLinks(base);
}

/** The link, if it works (active and not expired); 404 otherwise, so links can't be probed. */
async function openLink(token: string) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) throw notFound('That link');
  const r = await db().one<any>('SELECT * FROM content_share_links WHERE token = $1', [token]);
  const today = new Date().toISOString().slice(0, 10);
  if (!r || !r.active || (r.expires_on && String(r.expires_on instanceof Date ? r.expires_on.toISOString() : r.expires_on).slice(0, 10) < today)) throw notFound('That link');
  return r;
}

/** What a creator sees: shared posts (in the link's accounts) from a week ago on, with their photos and notes. */
export async function sharedCalendar(token: string) {
  const link = await openLink(token);
  await db().query('UPDATE content_share_links SET last_viewed_at = now() WHERE id = $1', [link.id]);
  const rows = await db().query<any>(`SELECT p.* FROM content_posts p WHERE ${SHARED_SQL}
    AND (cardinality($1::text[]) = 0 OR p.account = ANY($1::text[])) AND (p.scheduled_at IS NULL OR p.scheduled_at >= now() - interval '7 days')
    ORDER BY p.scheduled_at NULLS LAST, p.created_at LIMIT 300`, [link.accounts ?? []]);
  const accounts = new Map((await contentAccounts()).map((a) => [a.id as string, a]));
  const mediaIds = [...new Set(rows.flatMap((r) => r.media_ids ?? []))] as string[];
  const media = new Map((mediaIds.length ? await db().query<any>('SELECT id, mime, name, title FROM content_media WHERE id = ANY($1::uuid[])', [mediaIds]) : []).map((m) => [m.id as string, m]));
  const notes = rows.length && link.allow_notes ? await db().query<any>(`SELECT c.post_id, c.body, c.created_at, COALESCE(c.author_name, s.name) AS who, c.author_name IS NOT NULL AS creator
    FROM content_comments c LEFT JOIN staff s ON s.id = c.staff_id WHERE c.post_id = ANY($1::uuid[]) AND c.kind = 'comment' ORDER BY c.created_at`, [rows.map((r) => r.id)]) : [];
  const posts = [];
  for (const r of rows) {
    const a = accounts.get(r.account) as any;
    posts.push({
      id: r.id, title: r.title, account: a?.name ?? r.account, accountColor: a?.color ?? null, platform: r.platform, type: r.post_type,
      scheduledAt: r.scheduled_at ? new Date(r.scheduled_at).toISOString() : null, status: r.status === 'published' ? 'Published' : r.status === 'scheduled' || r.status === 'publishing' ? 'Scheduled' : 'Approved',
      headline: r.headline, caption: r.caption, cta: r.cta, hashtags: r.hashtags, permalink: r.permalink,
      media: await Promise.all(((r.media_ids ?? []) as string[]).filter((id) => media.has(id)).map(async (id) => ({ id, mime: media.get(id).mime, url: await publicMediaUrl(id) }))),
      notes: notes.filter((n) => n.post_id === r.id).map((n) => ({ who: n.who ?? 'Salon', body: n.body, creator: n.creator, at: new Date(n.created_at).toISOString() })),
    });
  }
  return { name: link.name, allowNotes: link.allow_notes, posts };
}

/** A note from the creator on a shared post: added to its comments (with their name) and the team is told. */
export async function addCreatorNote(token: string, postId: string, body: string) {
  const link = await openLink(token);
  if (!link.allow_notes) throw badRequest('Notes are turned off for this link.');
  const text = body.trim().slice(0, 2000);
  if (!text) throw badRequest('Write a note first.');
  const p = await db().one<any>('SELECT * FROM content_posts WHERE id = $1', [postId]);
  if (!p || !isShared(p) || (link.accounts?.length && !link.accounts.includes(p.account))) throw notFound('That post');
  await db().query("INSERT INTO content_comments(post_id, kind, body, author_name) VALUES ($1,'comment',$2,$3)", [postId, text, `${link.name} (creator)`]);
  const to = [...new Set([p.assigned_staff_id, p.created_by_staff_id].filter(Boolean))];
  for (const s of to) {
    await db().query("INSERT INTO notifications(staff_id, kind, title, body, link) VALUES ($1,'content',$2,$3,$4)",
      [s, `${link.name} left a note`, `${p.title}: ${text.slice(0, 140)}`, `/content?post=${postId}`]).catch(() => undefined);
  }
  return sharedCalendar(token);
}
