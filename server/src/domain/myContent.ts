import crypto from 'node:crypto';
import fs from 'node:fs';
import type { CurrentUser } from '@addendum/shared';
import { db } from '../db/index.js';
import { badRequest, notFound } from '../lib/errors.js';
import { getKV, setKV } from '../repos/settings.js';
import { abs, photoFile, removeFile, removeIfUnused, sniffImage, storeOriginal, visible, writeFileOnce, type Upload } from './transformations.js';

/**
 * My Content: a stylist's own Instagram plan — private. Every query is limited to the signed-in person's own posts, so
 * nobody else (administrators included) can read or change them.
 */
type Who = Pick<CurrentUser, 'id' | 'permissions'>;
export const FORMATS = ['post', 'reel', 'story', 'carousel'] as const;
export const STATUSES = ['idea', 'draft', 'ready', 'posted'] as const;

export interface PersonalMediaDTO { id: string; thumbUrl: string; originalUrl: string; mime: string; fromTransformation: boolean }
export interface PersonalPostDTO {
  id: string; date: string | null; time: string | null; format: (typeof FORMATS)[number]; status: (typeof STATUSES)[number];
  title: string; caption: string | null; hashtags: string | null; notes: string | null; media: PersonalMediaDTO[]; updatedAt: string;
}
export interface PersonalPostInput { date?: string | null; time?: string | null; format?: string; status?: string; title?: string; caption?: string | null; hashtags?: string | null; notes?: string | null }

const day = (d: unknown) => (d == null ? null : typeof d === 'string' ? d.slice(0, 10) : new Date(d as string).toISOString().slice(0, 10));

async function dtos(rows: any[]): Promise<PersonalPostDTO[]> {
  if (!rows.length) return [];
  const media = await db().query<any>(`SELECT m.*, tm.mime AS t_mime FROM personal_post_media m LEFT JOIN transformation_media tm ON tm.id = m.transformation_media_id
    WHERE m.post_id = ANY($1) ORDER BY m.position, m.created_at`, [rows.map((r) => r.id)]);
  return rows.map((r) => ({
    id: r.id, date: day(r.post_date), time: r.post_time, format: r.format, status: r.status, title: r.title, caption: r.caption, hashtags: r.hashtags, notes: r.notes,
    updatedAt: new Date(r.updated_at).toISOString(),
    media: media.filter((m) => m.post_id === r.id).map((m) => ({
      id: m.id, mime: m.mime ?? m.t_mime ?? 'image/jpeg', fromTransformation: !!m.transformation_media_id,
      thumbUrl: `/api/my-content/media/${m.id}/thumb`, originalUrl: `/api/my-content/media/${m.id}/original`,
    })),
  }));
}

async function own(id: string, u: Who) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('That post');
  const r = await db().one<any>('SELECT * FROM personal_posts WHERE id = $1 AND staff_id = $2', [id, u.id]);
  if (!r) throw notFound('That post');
  return r;
}
export const getPost = async (id: string, u: Who) => (await dtos([await own(id, u)]))[0];

/** Their posts between two dates, plus every undated idea. */
export async function listPosts(u: Who, from: string, to: string) {
  const rows = await db().query<any>(`SELECT * FROM personal_posts WHERE staff_id = $1 AND (post_date IS NULL OR post_date BETWEEN $2 AND $3)
    ORDER BY post_date NULLS FIRST, post_time NULLS FIRST, created_at`, [u.id, from, to]);
  return dtos(rows);
}

function clean(b: PersonalPostInput) {
  if (b.format !== undefined && !(FORMATS as readonly string[]).includes(b.format)) throw badRequest('Unknown format.');
  if (b.status !== undefined && !(STATUSES as readonly string[]).includes(b.status)) throw badRequest('Unknown status.');
  if (b.time && !/^\d{2}:\d{2}$/.test(b.time)) throw badRequest('Time as HH:MM.');
  return b;
}
export async function createPost(b: PersonalPostInput, u: Who) {
  clean(b);
  const [r] = await db().query<any>(`INSERT INTO personal_posts(staff_id, post_date, post_time, format, status, title, caption, hashtags, notes)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
  [u.id, b.date || null, b.time || null, b.format ?? 'post', b.status ?? (b.date ? 'draft' : 'idea'), b.title?.trim() ?? '', b.caption ?? null, b.hashtags ?? null, b.notes ?? null]);
  return (await dtos([r]))[0];
}
export async function updatePost(id: string, b: PersonalPostInput, u: Who) {
  await own(id, u);
  clean(b);
  const cols: Record<string, unknown> = {
    post_date: b.date, post_time: b.time, format: b.format, status: b.status, title: b.title?.trim(), caption: b.caption, hashtags: b.hashtags, notes: b.notes,
  };
  const set = Object.entries(cols).filter(([, v]) => v !== undefined);
  if (set.length) {
    await db().query(`UPDATE personal_posts SET ${set.map(([k], i) => `${k} = $${i + 3}`).join(', ')}, updated_at = now() WHERE id = $1 AND staff_id = $2`,
      [id, u.id, ...set.map(([k, v]) => (k === 'post_date' || k === 'post_time' ? v || null : v))]);
  }
  return getPost(id, u);
}
export async function deletePost(id: string, u: Who) {
  await own(id, u);
  const files = await db().query<{ file_path: string | null; thumb_path: string | null }>('SELECT file_path, thumb_path FROM personal_post_media WHERE post_id = $1', [id]);
  await db().query('DELETE FROM personal_posts WHERE id = $1 AND staff_id = $2', [id, u.id]);
  for (const f of files) { if (f.file_path) await removeIfUnused(f.file_path); await removeFile(f.thumb_path); }
}

// ---------------- photos & videos ----------------
const nextPos = async (postId: string) => (await db().one<{ n: number }>('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM personal_post_media WHERE post_id = $1', [postId]))!.n;

export async function addUpload(postId: string, receive: () => Promise<Upload>, u: Who) {
  await own(postId, u);
  const f = await storeOriginal(await receive());
  const [m] = await db().query<{ id: string }>('INSERT INTO personal_post_media(post_id, position, file_path, mime, size, sha256) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [postId, await nextPos(postId), f.rel, f.mime, f.size, f.sha]);
  await db().query('UPDATE personal_posts SET updated_at = now() WHERE id = $1', [postId]);
  return { mediaId: m.id, post: await getPost(postId, u) };
}
/** One of their transformation photos (a link to it — nothing is copied). */
export async function addFromTransformation(postId: string, transformationMediaId: string, u: Who) {
  await own(postId, u);
  const tm = await db().one<{ transformation_id: string }>('SELECT transformation_id FROM transformation_media WHERE id = $1', [transformationMediaId]);
  if (!tm) throw notFound('That photo');
  const { a } = await visible(tm.transformation_id, u);
  if (!a.download) throw notFound('That photo');
  if (!(await db().one('SELECT 1 FROM personal_post_media WHERE post_id = $1 AND transformation_media_id = $2', [postId, transformationMediaId]))) {
    await db().query('INSERT INTO personal_post_media(post_id, position, transformation_media_id) VALUES ($1,$2,$3)', [postId, await nextPos(postId), transformationMediaId]);
  }
  return getPost(postId, u);
}
async function ownMedia(mid: string, u: Who) {
  if (!/^[0-9a-f-]{36}$/i.test(mid)) throw notFound('That photo');
  const m = await db().one<any>('SELECT m.* FROM personal_post_media m JOIN personal_posts p ON p.id = m.post_id WHERE m.id = $1 AND p.staff_id = $2', [mid, u.id]);
  if (!m) throw notFound('That photo');
  return m;
}
export async function removeMedia(mid: string, u: Who) {
  const m = await ownMedia(mid, u);
  await db().query('DELETE FROM personal_post_media WHERE id = $1', [mid]);
  if (m.file_path) await removeIfUnused(m.file_path);
  await removeFile(m.thumb_path);
  return getPost(m.post_id, u);
}
export async function setThumb(mid: string, bytes: Buffer, u: Who) {
  const m = await ownMedia(mid, u);
  const k = sniffImage(bytes);
  if (!k || bytes.length > 1024 * 1024) throw badRequest('Thumbnails must be a JPEG, PNG or WebP under 1 MB.');
  const rel = `thumbs/p-${mid}-${crypto.randomBytes(4).toString('hex')}.${k.ext}`;
  await writeFileOnce(rel, bytes);
  await db().query('UPDATE personal_post_media SET thumb_path = $2 WHERE id = $1', [mid, rel]);
  await removeFile(m.thumb_path);
}
/** A file to send — only for the owner. Transformation photos go through the library's own checks. */
export async function mediaFile(mid: string, which: 'thumb' | 'original', u: Who) {
  const m = await ownMedia(mid, u);
  if (m.transformation_media_id) return photoFile(m.transformation_media_id, which, u);
  const isVideo = String(m.mime).startsWith('video/');
  const rel = which === 'thumb' ? m.thumb_path ?? (isVideo ? null : m.file_path) : m.file_path;
  if (!rel || !fs.existsSync(abs(rel))) return null;
  const mime = rel === m.file_path ? m.mime : rel.endsWith('.png') ? 'image/png' : rel.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
  return { path: abs(rel), mime, name: `post${rel.slice(rel.lastIndexOf('.'))}` };
}

/** Their own transformation photos to pick from (newest first). */
export async function myTransformationPhotos(u: Who) {
  return db().query<{ id: string; transformation_id: string; title: string; service_date: string; mime: string }>(`SELECT m.id, m.transformation_id, t.title, to_char(t.service_date, 'YYYY-MM-DD') AS service_date, m.mime
    FROM transformation_media m JOIN transformations t ON t.id = m.transformation_id WHERE t.stylist_staff_id = $1 ORDER BY t.service_date DESC, m.position LIMIT 200`, [u.id]);
}

// ---------------- their Instagram ----------------
const handleKey = (id: string) => `mycontent.instagram.${id}`;
export const getHandle = async (u: Who) => (await getKV<string>(handleKey(u.id))) ?? null;
export async function setHandle(u: Who, raw: string | null) {
  const h = (raw ?? '').trim().replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/^@/, '').replace(/[/?#].*$/, '').toLowerCase();
  if (h && !/^[A-Za-z0-9._]{1,30}$/.test(h)) throw badRequest('Enter your Instagram username, e.g. @yourname.');
  await setKV(handleKey(u.id), h || null);
  return h || null;
}

// ---------------- salon downloads ----------------
/** Posts and stories the salon shares with stylists (Content Calendar → Assets → "Stylists can download"). */
export async function salonDownloads() {
  const rows = await db().query<any>(`SELECT id, mime, name, size, title, tags, stylist_share, created_at FROM content_media WHERE stylist_share IS NOT NULL ORDER BY created_at DESC LIMIT 300`);
  return rows.map((m) => ({ id: m.id as string, kind: m.stylist_share as 'post' | 'story', title: (m.title ?? m.name ?? null) as string | null, mime: m.mime as string, size: m.size as number,
    url: `/api/my-content/downloads/${m.id}`, createdAt: new Date(m.created_at).toISOString() }));
}
/** A shared file (only ones the salon has shared). */
export async function salonDownload(id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('That download');
  const m = await db().one<{ mime: string; bytes: Buffer; name: string | null; title: string | null }>('SELECT mime, bytes, name, title FROM content_media WHERE id = $1 AND stylist_share IS NOT NULL', [id]);
  if (!m) throw notFound('That download');
  return m;
}

// ---------------- the salon's ideas ----------------
/**
 * The Content Calendar's saved Instagram ideas for the salon's account (addendum.salon, or ideas for every account), for
 * stylists to use in their own plan. Read-only: using one copies it into a post of theirs.
 */
export async function salonIdeas() {
  const rows = await db().query<any>(`SELECT id, title, pillar, format, hook, visual, shot_list, caption, cta, hashtags, also_story, effort FROM content_ideas
    WHERE platform = 'instagram' AND COALESCE(status, 'library') = 'library' AND (accounts = '{}' OR 'a1' = ANY(accounts))
    ORDER BY builtin, created_at DESC LIMIT 300`);
  return rows.map((r) => ({
    id: r.id as string, title: r.title as string, pillar: r.pillar as string,
    format: (r.format === 'reel' || r.format === 'story' || r.format === 'carousel' ? r.format : 'post') as (typeof FORMATS)[number],
    hook: r.hook, visual: r.visual, shotList: r.shot_list, caption: r.caption, cta: r.cta, hashtags: r.hashtags, alsoStory: !!r.also_story, effort: r.effort,
  }));
}
