import type { CurrentUser } from '@addendum/shared';
import { can } from '../auth/permissions.js';
import { db } from '../db/index.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { iso } from '../lib/time.js';

/**
 * Team announcements — kept apart from tasks: publishing one shows it to its audience (everyone, or chosen roles)
 * without creating a task for anybody. "View" sees published ones for them; "Create and publish" writes and manages
 * their own; "Manage all" edits, pins, unpublishes and deletes anyone's.
 */
export interface AnnouncementInput {
  title: string;
  body?: string;
  linkUrl?: string | null;
  linkLabel?: string | null;
  important?: boolean;
  pinned?: boolean;
  audienceRoles?: string[] | null;
}

function toDTO(r: any) {
  return {
    id: r.id, title: r.title, body: r.body, linkUrl: r.link_url, linkLabel: r.link_label, important: r.important, pinned: r.pinned,
    audienceRoles: r.audience_roles ?? null, status: r.status as 'draft' | 'published', publishedAt: iso(r.published_at),
    authorId: r.author_staff_id, authorName: r.author_name ?? null, read: !!r.read_at, readAt: iso(r.read_at),
    readCount: r.read_count ?? 0, createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)!,
  };
}
export type AnnouncementDTO = ReturnType<typeof toDTO>;

const SELECT = `
  SELECT a.*, s.name AS author_name, rd.read_at,
         (SELECT count(*)::int FROM announcement_reads x WHERE x.announcement_id = a.id) AS read_count
    FROM announcements a
    LEFT JOIN staff s ON s.id = a.author_staff_id
    LEFT JOIN announcement_reads rd ON rd.announcement_id = a.id AND rd.staff_id = $1`;
// Published, and meant for everyone or this person's role.
const VISIBLE = `a.status = 'published' AND (a.audience_roles IS NULL OR $2 = ANY(a.audience_roles))`;

/** What this person sees: published ones for them, plus drafts they can work on. Pinned first, newest first. */
export async function listAnnouncements(user: CurrentUser, opts: { limit?: number } = {}) {
  const manage = can(user, 'announcements:manage');
  const publish = can(user, 'announcements:publish');
  const rows = await db().query(
    `${SELECT} WHERE ${VISIBLE} OR ($3 AND a.status = 'draft') OR ($4 AND a.author_staff_id = $1)
      ORDER BY (a.status = 'draft') DESC, a.pinned DESC, a.published_at DESC NULLS LAST, a.created_at DESC LIMIT $5`,
    [user.id, user.role, manage, publish, Math.min(opts.limit ?? 100, 200)],
  );
  return rows.map(toDTO);
}

export async function unreadAnnouncements(user: CurrentUser) {
  const r = await db().one<{ n: number }>(
    `SELECT count(*)::int AS n FROM announcements a
      WHERE ${VISIBLE} AND NOT EXISTS (SELECT 1 FROM announcement_reads x WHERE x.announcement_id = a.id AND x.staff_id = $1)`, [user.id, user.role]);
  return r?.n ?? 0;
}

async function load(id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('That announcement');
  const r = await db().one<any>('SELECT * FROM announcements WHERE id = $1', [id]);
  if (!r) throw notFound('That announcement');
  return r;
}

/** Editing, publishing and deleting: your own (with "Create and publish"), or anyone's (with "Manage all"). */
function assertCanChange(user: CurrentUser, a: any) {
  if (can(user, 'announcements:manage')) return;
  if (can(user, 'announcements:publish') && a.author_staff_id === user.id) return;
  throw forbidden('You can only change your own announcements.');
}

function clean(input: AnnouncementInput) {
  const title = input.title?.trim();
  if (!title) throw badRequest('Give the announcement a title.');
  const link = input.linkUrl?.trim() || null;
  if (link && !/^https:\/\/[^\s]+$/i.test(link)) throw badRequest('The link must start with https://');
  return {
    title, body: input.body?.trim() ?? '', link, linkLabel: input.linkLabel?.trim() || null,
    important: !!input.important, pinned: !!input.pinned,
    audience: input.audienceRoles?.length ? [...new Set(input.audienceRoles)] : null,
  };
}

export async function createAnnouncement(user: CurrentUser, input: AnnouncementInput, publish: boolean) {
  const v = clean(input);
  const r = await db().one<{ id: string }>(
    `INSERT INTO announcements(title, body, link_url, link_label, important, pinned, audience_roles, status, published_at, author_staff_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [v.title, v.body, v.link, v.linkLabel, v.important, v.pinned, v.audience, publish ? 'published' : 'draft', publish ? new Date() : null, user.id],
  );
  return getAnnouncement(user, r!.id);
}

export async function updateAnnouncement(user: CurrentUser, id: string, input: AnnouncementInput) {
  assertCanChange(user, await load(id));
  const v = clean(input);
  await db().query(
    `UPDATE announcements SET title = $2, body = $3, link_url = $4, link_label = $5, important = $6, pinned = $7, audience_roles = $8, updated_at = now() WHERE id = $1`,
    [id, v.title, v.body, v.link, v.linkLabel, v.important, v.pinned, v.audience],
  );
  return getAnnouncement(user, id);
}

export async function setPublished(user: CurrentUser, id: string, published: boolean) {
  assertCanChange(user, await load(id));
  await db().query(
    `UPDATE announcements SET status = $2, published_at = CASE WHEN $2 = 'published' THEN COALESCE(published_at, now()) ELSE published_at END, updated_at = now() WHERE id = $1`,
    [id, published ? 'published' : 'draft'],
  );
  return getAnnouncement(user, id);
}

export async function deleteAnnouncement(user: CurrentUser, id: string) {
  assertCanChange(user, await load(id));
  await db().query('DELETE FROM announcements WHERE id = $1', [id]);
}

/** One announcement, if this person may see it (published for them, or a draft they can work on). */
export async function getAnnouncement(user: CurrentUser, id: string) {
  const r = await db().one<any>(`${SELECT} WHERE a.id = $2`, [user.id, id]);
  if (!r) throw notFound('That announcement');
  const visible = r.status === 'published' && (!r.audience_roles || r.audience_roles.includes(user.role));
  const ownDraft = r.author_staff_id === user.id;
  if (!visible && !ownDraft && !can(user, 'announcements:manage')) throw notFound('That announcement');
  return toDTO(r);
}

export async function markRead(user: CurrentUser, id: string) {
  await getAnnouncement(user, id);
  await db().query('INSERT INTO announcement_reads(announcement_id, staff_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, user.id]);
}

export async function markAllRead(user: CurrentUser) {
  await db().query(
    `INSERT INTO announcement_reads(announcement_id, staff_id)
     SELECT a.id, $1 FROM announcements a WHERE ${VISIBLE} ON CONFLICT DO NOTHING`, [user.id, user.role]);
}
