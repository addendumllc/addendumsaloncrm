import crypto from 'node:crypto';
import type { ContentAccount, ContentMediaDTO, ContentPostDTO, ContentPostType, ContentStatus } from '@addendum/shared';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { InstagramApi, instagramAccounts, type IgSlot } from '../integrations/instagram.js';
import { badRequest, notFound } from '../lib/errors.js';
import { iso } from '../lib/time.js';
import { getKV, getSettings, setKV } from '../repos/settings.js';

/**
 * Content calendar: Instagram posts planned for the salon's three accounts — when, what type, caption, photos/videos,
 * what it promotes and who's on it — and, for connected accounts, posted automatically at the scheduled time.
 */
const ACCOUNTS_KEY = 'content.accounts';
const DEFAULT_ACCOUNTS: Omit<ContentAccount, 'connected'>[] = [
  { id: 'a1', name: 'Account 1', handle: '', color: '#6b5242' },
  { id: 'a2', name: 'Account 2', handle: '', color: '#8a9a5b' },
  { id: 'a3', name: 'Account 3', handle: '', color: '#4b6a88' },
];

const connectedSlots = () => new Set(instagramAccounts(config()).map((a) => a.slot));
export async function contentAccounts(): Promise<ContentAccount[]> {
  const saved = (await getKV<Omit<ContentAccount, 'connected'>[]>(ACCOUNTS_KEY)) ?? [];
  const on = connectedSlots();
  return DEFAULT_ACCOUNTS.map((d) => ({ ...d, ...(saved.find((s) => s.id === d.id) ?? {}), connected: on.has(d.id) }));
}
export async function saveContentAccounts(list: { id: ContentAccount['id']; name: string; handle: string; color: string }[]) {
  await setKV(ACCOUNTS_KEY, DEFAULT_ACCOUNTS.map((d) => { const x = list.find((l) => l.id === d.id); return x ? { id: d.id, name: x.name, handle: x.handle.replace(/^@/, ''), color: x.color } : d; }));
  return contentAccounts();
}

// ---------------- Media ----------------
export const MEDIA_LIMITS = { image: 15 * 1024 * 1024, video: 100 * 1024 * 1024 };
const MEDIA_TYPES = /^(image\/(jpeg|png|webp|heic|heif)|video\/(mp4|quicktime))$/;

/** A secret for the public media links (Instagram downloads media from them); made once. */
async function mediaSecret() {
  let s = await getKV<string>('content.mediaSecret');
  if (!s) { s = crypto.randomBytes(32).toString('hex'); await setKV('content.mediaSecret', s); }
  return s;
}
const sign = (secret: string, id: string) => crypto.createHmac('sha256', secret).update(id).digest('base64url').slice(0, 32);
/** The public, unguessable link to one file (for Instagram to download). */
export async function publicMediaUrl(id: string) {
  return `${config().APP_URL.replace(/\/+$/, '')}/content-media/${id}/${sign(await mediaSecret(), id)}`;
}
export async function checkMediaSignature(id: string, sig: string) {
  const want = sign(await mediaSecret(), id);
  return sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
}

export async function saveMedia(bytes: Buffer, mime: string, name: string | null, staffId: string | null): Promise<ContentMediaDTO> {
  const type = mime.toLowerCase().split(';')[0].trim();
  if (!MEDIA_TYPES.test(type)) throw badRequest('Photos (JPG, PNG, WebP, HEIC) or videos (MP4, MOV) only.');
  const limit = type.startsWith('video/') ? MEDIA_LIMITS.video : MEDIA_LIMITS.image;
  if (!bytes.length) throw badRequest('That file is empty.');
  if (bytes.length > limit) throw badRequest(`Too big — ${type.startsWith('video/') ? 'videos up to 100 MB' : 'photos up to 15 MB'}.`);
  const r = (await db().one<{ id: string }>('INSERT INTO content_media(mime, name, bytes, size, created_by_staff_id) VALUES ($1,$2,$3,$4,$5) RETURNING id', [type, name?.slice(0, 200) ?? null, bytes, bytes.length, staffId]))!;
  return { id: r.id, mime: type, name, size: bytes.length, url: `/api/content/media/${r.id}` };
}
export async function readMedia(id: string) {
  return db().one<{ mime: string; bytes: Buffer; name: string | null }>('SELECT mime, bytes, name FROM content_media WHERE id = $1', [id]);
}

// ---------------- Posts ----------------
const SELECT = `SELECT p.*, s.name AS assigned_name FROM content_posts p LEFT JOIN staff s ON s.id = p.assigned_staff_id`;
async function toDTO(rows: any[]): Promise<ContentPostDTO[]> {
  const ids = [...new Set(rows.flatMap((r) => r.media_ids ?? []))];
  const media = new Map((ids.length ? await db().query<any>('SELECT id, mime, name, size FROM content_media WHERE id = ANY($1::uuid[])', [ids]) : [])
    .map((m) => [m.id as string, { id: m.id, mime: m.mime, name: m.name, size: m.size, url: `/api/content/media/${m.id}` } as ContentMediaDTO]));
  return rows.map((r) => ({
    id: r.id, account: r.account, type: r.post_type, scheduledAt: iso(r.scheduled_at), caption: r.caption, status: r.status, autoPost: r.auto_post,
    media: (r.media_ids ?? []).map((id: string) => media.get(id)).filter(Boolean),
    link: r.link_kind ? { kind: r.link_kind, ref: r.link_ref, label: r.link_label ?? '' } : null,
    assignedStaffId: r.assigned_staff_id, assignedName: r.assigned_name ?? null, notes: r.notes,
    permalink: r.permalink, postedAt: iso(r.posted_at), error: r.error, createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)!,
  }));
}
/** Posts scheduled in [from, to) — plus ideas with no date yet. */
export async function listPosts(from: string, to: string) {
  return toDTO(await db().query(`${SELECT} WHERE (p.scheduled_at >= $1 AND p.scheduled_at < $2) OR p.scheduled_at IS NULL ORDER BY p.scheduled_at NULLS LAST, p.created_at`, [from, to]));
}
export async function getPost(id: string) {
  const r = await db().one(`${SELECT} WHERE p.id = $1`, [id]);
  if (!r) throw notFound('Post not found');
  return (await toDTO([r]))[0];
}

export interface PostInput {
  account: ContentAccount['id']; type: ContentPostType; scheduledAt: string | null; caption: string; status: ContentStatus; autoPost: boolean;
  mediaIds: string[]; link: { kind: 'product' | 'service'; ref: string; label: string } | null; assignedStaffId: string | null; notes: string | null;
}

/** What auto-posting needs for this post (null = ready). */
export function autoPostProblem(p: { type: ContentPostType; scheduledAt: string | null; media: { mime: string }[] }, connected: boolean) {
  if (!connected) return 'This account isn’t connected for auto-posting yet (Settings → API & Integrations → Instagram).';
  if (!p.scheduledAt) return 'Pick a date and time to post it.';
  const videos = p.media.filter((m) => m.mime.startsWith('video/')).length;
  if (!p.media.length) return 'Add a photo or video.';
  if (p.type === 'carousel' && (p.media.length < 2 || p.media.length > 10)) return 'A carousel needs 2 to 10 photos or videos.';
  if (p.type === 'reel' && (p.media.length !== 1 || videos !== 1)) return 'A Reel is one video.';
  if ((p.type === 'feed' || p.type === 'story') && p.media.length !== 1) return `A ${p.type === 'story' ? 'Story' : 'feed post'} is one photo or video (use Carousel for several).`;
  if (p.media.some((m) => /heic|heif/.test(m.mime))) return 'Instagram can’t take HEIC photos — upload a JPG or PNG.';
  return null;
}

async function check(input: PostInput) {
  if (input.autoPost && input.status === 'scheduled') {
    const media = input.mediaIds.length ? await db().query<{ mime: string }>('SELECT mime FROM content_media WHERE id = ANY($1::uuid[])', [input.mediaIds]) : [];
    const problem = autoPostProblem({ type: input.type, scheduledAt: input.scheduledAt, media }, connectedSlots().has(input.account));
    if (problem) throw badRequest(problem);
  }
  if (input.caption.length > 2200) throw badRequest('Instagram captions are up to 2,200 characters.');
}

export async function createPost(input: PostInput, staffId: string | null) {
  await check(input);
  const r = (await db().one<{ id: string }>(
    `INSERT INTO content_posts(account, post_type, scheduled_at, caption, status, auto_post, media_ids, link_kind, link_ref, link_label, assigned_staff_id, notes, created_by_staff_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7::uuid[],$8,$9,$10,$11,$12,$13) RETURNING id`,
    [input.account, input.type, input.scheduledAt, input.caption, input.status, input.autoPost, input.mediaIds, input.link?.kind ?? null, input.link?.ref ?? null, input.link?.label ?? null, input.assignedStaffId, input.notes, staffId]))!;
  return getPost(r.id);
}

export async function updatePost(id: string, input: PostInput) {
  const before = await getPost(id);
  if (before.status === 'publishing') throw badRequest('It’s being posted right now — try again in a minute.');
  await check(input);
  const moved = before.scheduledAt !== input.scheduledAt || before.assignedStaffId !== input.assignedStaffId;
  await db().query(
    `UPDATE content_posts SET account=$2, post_type=$3, scheduled_at=$4, caption=$5, status=$6, auto_post=$7, media_ids=$8::uuid[], link_kind=$9, link_ref=$10, link_label=$11,
       assigned_staff_id=$12, notes=$13, error = CASE WHEN $6 = 'failed' THEN error ELSE NULL END,
       reminded_day_before = reminded_day_before AND NOT $14, reminded_today = reminded_today AND NOT $14, updated_at = now() WHERE id = $1`,
    [id, input.account, input.type, input.scheduledAt, input.caption, input.status, input.autoPost, input.mediaIds, input.link?.kind ?? null, input.link?.ref ?? null, input.link?.label ?? null, input.assignedStaffId, input.notes, moved]);
  return getPost(id);
}

export async function deletePost(id: string) {
  const p = await getPost(id);
  await db().query('DELETE FROM content_posts WHERE id = $1', [id]);
  // Its files go too, unless another post uses them.
  if (p.media.length) await db().query('DELETE FROM content_media m WHERE m.id = ANY($1::uuid[]) AND NOT EXISTS (SELECT 1 FROM content_posts x WHERE m.id = ANY(x.media_ids))', [p.media.map((m) => m.id)]);
}

/** What a post can promote: products (inventory) and services, by name. */
export async function linkOptions(q: string) {
  const like = `%${q.trim().toLowerCase()}%`;
  const services = await db().query<{ id: string; name: string }>(`SELECT id, name FROM services WHERE lower(name) LIKE $1 ORDER BY name LIMIT 15`, [like]);
  const { stockRows } = await import('./stock.js');
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const products = (await stockRows().catch(() => [])).filter((r) => words.every((w) => `${r.label} ${r.sku ?? ''}`.toLowerCase().includes(w))).slice(0, 15);
  return [...products.map((p) => ({ kind: 'product' as const, ref: p.key, label: p.label })), ...services.map((s) => ({ kind: 'service' as const, ref: s.id, label: s.name }))];
}

// ---------------- Scheduler: reminders and auto-posting ----------------
/** Bell reminders for the person on a post: the day before and on the day (posts not done yet). */
export async function remindContent(now = new Date()) {
  const tz = (await getSettings()).business.timezone;
  const day = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: tz });
  const today = day(now); const tomorrow = day(new Date(now.getTime() + 86400_000));
  const rows = await db().query<any>(`SELECT id, account, post_type, scheduled_at, assigned_staff_id, reminded_day_before, reminded_today FROM content_posts
     WHERE assigned_staff_id IS NOT NULL AND scheduled_at IS NOT NULL AND status NOT IN ('posted','publishing') AND scheduled_at > $1::timestamptz - interval '1 day'`, [now]);
  const names = new Map((await contentAccounts()).map((a) => [a.id, a.name]));
  let sent = 0;
  for (const r of rows) {
    const d = day(new Date(r.scheduled_at));
    const when = new Date(r.scheduled_at).toLocaleString('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: '2-digit' });
    const what = `${names.get(r.account) ?? 'Instagram'} ${r.post_type === 'reel' ? 'Reel' : r.post_type === 'story' ? 'Story' : r.post_type === 'carousel' ? 'carousel' : 'post'}`;
    if (d === tomorrow && !r.reminded_day_before) {
      await db().query("INSERT INTO notifications(staff_id, kind, title, body, link) VALUES ($1,'content',$2,$3,$4)", [r.assigned_staff_id, `Tomorrow: ${what}`, `Scheduled ${when}. Make sure it’s ready.`, `/content?post=${r.id}`]);
      await db().query('UPDATE content_posts SET reminded_day_before = true WHERE id = $1', [r.id]); sent++;
    } else if (d === today && !r.reminded_today) {
      await db().query("INSERT INTO notifications(staff_id, kind, title, body, link) VALUES ($1,'content',$2,$3,$4)", [r.assigned_staff_id, `Today: ${what}`, `Scheduled ${when}.`, `/content?post=${r.id}`]);
      await db().query('UPDATE content_posts SET reminded_today = true, reminded_day_before = true WHERE id = $1', [r.id]); sent++;
    }
  }
  return sent;
}

const PARENT = 'P:';
/**
 * Auto-posting: due posts get their Instagram containers made (videos are processed by Instagram first), then
 * published once ready — over a few checks if needed. A problem marks the post Failed with the reason (and tells the
 * person on it); nothing is retried on its own.
 */
export async function publishDueContent(now = new Date(), api = (slot: IgSlot) => { const a = instagramAccounts(config()).find((x) => x.slot === slot); return a ? new InstagramApi(a.accountId, a.token) : null; }) {
  const due = await db().query<any>(`SELECT * FROM content_posts WHERE auto_post AND ((status = 'scheduled' AND scheduled_at <= $1) OR status = 'publishing') ORDER BY scheduled_at LIMIT 10`, [now]);
  let posted = 0;
  for (const r of due) {
    const ig = api(r.account);
    const fail = async (msg: string) => {
      await db().query("UPDATE content_posts SET status = 'failed', error = $2, updated_at = now() WHERE id = $1", [r.id, msg.slice(0, 500)]);
      if (r.assigned_staff_id) await db().query("INSERT INTO notifications(staff_id, kind, title, body, link) VALUES ($1,'content','Instagram post didn’t go out',$2,$3)", [r.assigned_staff_id, msg.slice(0, 300), `/content?post=${r.id}`]);
    };
    if (!ig) { await fail('This account isn’t connected for auto-posting (Settings → API & Integrations → Instagram).'); continue; }
    try {
      const media = await db().query<{ id: string; mime: string }>('SELECT id, mime FROM content_media WHERE id = ANY($1::uuid[])', [r.media_ids]);
      const ordered = (r.media_ids as string[]).map((id) => media.find((m) => m.id === id)).filter((m): m is { id: string; mime: string } => !!m);
      const problem = autoPostProblem({ type: r.post_type, scheduledAt: iso(r.scheduled_at), media: ordered }, true);
      if (problem) { await fail(problem); continue; }
      let ids: string[] = r.ig_container_ids ?? [];
      if (r.status === 'scheduled') {
        // Make the containers: one, or each carousel item (the carousel itself once they're ready).
        const urls = await Promise.all(ordered.map(async (m) => ({ url: await publicMediaUrl(m.id), video: m.mime.startsWith('video/') })));
        ids = r.post_type === 'carousel'
          ? await Promise.all(urls.map((u) => ig.container(u, { kind: 'carousel_item' })))
          : [await ig.container(urls[0], { kind: r.post_type, caption: r.caption })];
        await db().query("UPDATE content_posts SET status = 'publishing', ig_container_ids = $2, updated_at = now() WHERE id = $1", [r.id, ids]);
      }
      const statuses = await Promise.all(ids.filter((x) => !x.startsWith(PARENT)).map((x) => ig.status(x)));
      if (statuses.some((s) => s === 'ERROR' || s === 'EXPIRED')) { await fail('Instagram couldn’t process the media (check the format and size).'); continue; }
      if (statuses.some((s) => s !== 'FINISHED')) continue; // still processing: next check
      let final = ids[0];
      if (r.post_type === 'carousel') {
        const parent = ids.find((x) => x.startsWith(PARENT))?.slice(PARENT.length) ?? await ig.carousel(ids, r.caption);
        if (!ids.some((x) => x.startsWith(PARENT))) await db().query('UPDATE content_posts SET ig_container_ids = $2 WHERE id = $1', [r.id, [...ids, `${PARENT}${parent}`]]);
        if ((await ig.status(parent)) !== 'FINISHED') continue;
        final = parent;
      }
      const out = await ig.publish(final);
      await db().query("UPDATE content_posts SET status = 'posted', ig_media_id = $2, permalink = $3, posted_at = now(), error = NULL, updated_at = now() WHERE id = $1", [r.id, out.mediaId, out.permalink]);
      posted++;
    } catch (e) {
      await fail((e as { userMessage?: string }).userMessage ?? (e as Error).message);
    }
  }
  return posted;
}
