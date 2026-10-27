import crypto from 'node:crypto';
import type {
  ContentAccount, ContentAccountId, ContentCampaignDTO, ContentEmail, ContentCommentDTO, ContentIdeaDTO, ContentMediaDTO, ContentMetrics, ContentPlatform, ContentPostDTO,
  ContentPostType, ContentSettings, ContentStatus, CurrentUser,
} from '@addendum/shared';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { aiService } from '../integrations/registry.js';
import { InstagramApi, instagramAccounts, type IgSlot } from '../integrations/instagram.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { iso } from '../lib/time.js';
import { getKV, getSettings, setKV } from '../repos/settings.js';
import { BUILTIN_IDEAS, EMAIL_IDEAS } from './contentIdeas.js';

/**
 * Content calendar for the three social accounts (@addendum.salon, @addendumhair, @addendumhairpro): planning,
 * the ideas library and AI drafts, a review workflow (Idea → Draft → In review → Changes requested → Approved →
 * Scheduled → Published), assets, goals and performance. AI never publishes; nothing is marked published unless it was
 * posted (Instagram auto-posting) or someone allowed to publish confirms it.
 */
type Who = Pick<CurrentUser, 'id' | 'permissions'>;
const has = (u: Who, p: string) => u.permissions.includes(p) || u.permissions.includes('*');
const ACCOUNT_IDS: ContentAccountId[] = ['a1', 'a2', 'a3'];

// ---------------- Accounts ----------------
const ACCOUNTS_KEY = 'content.accounts';
const DEFAULT_ACCOUNTS: Omit<ContentAccount, 'connected' | 'privateAccount'>[] = [
  { id: 'a1', name: '@addendum.salon', handle: 'addendum.salon', color: '#6b5242', brand: 'salon', cta: 'Book an appointment',
    voice: 'Luxury editorial: warm, confident, elevated and client-facing — the salon experience, never salesy.',
    pillars: ['Transformations', 'Color, cuts, styling & treatments', 'Hair extensions & maintenance', 'Hair trends', 'Professional advice', 'Stylist spotlights & salon culture', 'Retail: Milbon & Oribe', 'The Insider & salon experience', 'Client testimonials', 'Appointments & booking promotions'] },
  { id: 'a2', name: '@addendumhair', handle: 'addendumhair', color: '#8a9a5b', brand: 'hair', cta: 'Shop the collection',
    voice: 'Professional and modern: product-led, clear benefits, confident brand storytelling.',
    pillars: ['Product spotlights & demonstrations', 'Extension tools & accessories', 'Product features & benefits', 'Behind the scenes', 'Launches & restocks', 'Product education & storytelling', 'Shopify promotions'] },
  { id: 'a3', name: '@addendumhairpro', handle: 'addendumhairpro', color: '#4b6a88', brand: 'hair', cta: 'Learn more or shop professional products',
    voice: 'Education-led and peer-to-peer: precise technique, practical tips, supportive of the stylist community.',
    pillars: ['Installation education', 'Methods: weft, K-Tip, tape, hybrid', 'Professional tips & best practices', 'Demonstrations & tutorials', 'Stylist education & FAQs', 'Transformations & case studies', 'Stylist spotlights & UGC', 'Maintenance & troubleshooting', 'Professional product recommendations'] },
];
const connectedSlots = () => new Set(instagramAccounts(config()).map((a) => a.slot));
/** Accounts the CRM can post to: connected, and not private. */
async function postableSlots() { return new Set((await contentAccounts()).filter((a) => a.connected).map((a) => a.id)); }
export async function contentAccounts(): Promise<ContentAccount[]> {
  const saved = (await getKV<Partial<ContentAccount>[]>(ACCOUNTS_KEY)) ?? [];
  const on = connectedSlots();
  return DEFAULT_ACCOUNTS.map((d) => {
    const s = saved.find((x) => x.id === d.id) ?? {};
    // Saved before the accounts had their own names: the generic "Account 1…" names give way to the handles.
    const name = s.name && !/^Account \d$/.test(s.name) ? s.name : d.name;
    // @addendumhairpro is private (stylists only) unless changed in Settings.
    const priv = s.privateAccount ?? d.id === 'a3';
    return { ...d, ...s, name, handle: s.handle || d.handle, pillars: s.pillars?.length ? s.pillars : d.pillars, id: d.id, brand: d.brand, privateAccount: priv, connected: on.has(d.id) && !priv } as ContentAccount;
  });
}
export async function saveContentAccounts(list: { id: ContentAccountId; name: string; handle: string; color: string; cta?: string; voice?: string; pillars?: string[]; privateAccount?: boolean }[]) {
  const current = await contentAccounts();
  await setKV(ACCOUNTS_KEY, current.map((c) => {
    const x = list.find((l) => l.id === c.id);
    return { id: c.id, name: x?.name ?? c.name, handle: (x?.handle ?? c.handle).replace(/^@/, ''), color: x?.color ?? c.color, cta: x?.cta ?? c.cta, voice: x?.voice ?? c.voice, pillars: x?.pillars ?? c.pillars, privateAccount: x?.privateAccount ?? c.privateAccount };
  }));
  return contentAccounts();
}

// ---------------- Settings and access ----------------
const SETTINGS_KEY = 'content.settings';
export async function contentSettings(): Promise<ContentSettings> {
  return { requireApproval: true, goals: {}, access: {}, ...((await getKV<ContentSettings>(SETTINGS_KEY)) ?? {}) };
}
export async function saveContentSettings(s: ContentSettings) { await setKV(SETTINGS_KEY, s); return contentSettings(); }
/** The accounts this person may work on (administrators: all). */
export async function accountsFor(u: Who): Promise<ContentAccountId[]> {
  if (has(u, 'settings:write')) return ACCOUNT_IDS;
  const { access } = await contentSettings();
  return ACCOUNT_IDS.filter((a) => !access[a]?.length || access[a]!.includes(u.id));
}
async function assertAccount(u: Who, account: string) {
  if (!(await accountsFor(u)).includes(account as ContentAccountId)) throw forbidden('You don’t have access to that account.');
}

// ---------------- Media and the asset library ----------------
export const MEDIA_LIMITS = { image: 15 * 1024 * 1024, video: 100 * 1024 * 1024 };
const MEDIA_TYPES = /^(image\/(jpeg|png|webp|heic|heif)|video\/(mp4|quicktime))$/;
async function mediaSecret() {
  let s = await getKV<string>('content.mediaSecret');
  if (!s) { s = crypto.randomBytes(32).toString('hex'); await setKV('content.mediaSecret', s); }
  return s;
}
const sign = (secret: string, id: string) => crypto.createHmac('sha256', secret).update(id).digest('base64url').slice(0, 32);
/** The public, unguessable link to one file (Instagram downloads media from it when posting). */
export async function publicMediaUrl(id: string) { return `${config().APP_URL.replace(/\/+$/, '')}/content-media/${id}/${sign(await mediaSecret(), id)}`; }
export async function checkMediaSignature(id: string, sig: string) {
  const want = sign(await mediaSecret(), id);
  return sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
}
const mediaDTO = (m: any): ContentMediaDTO => ({ id: m.id, mime: m.mime, name: m.name, size: m.size, url: `/api/content/media/${m.id}`, title: m.title ?? null, tags: m.tags ?? [], account: m.account ?? null, approved: !!m.approved, createdAt: iso(m.created_at) ?? undefined });
export async function saveMedia(bytes: Buffer, mime: string, name: string | null, staffId: string | null, account: string | null = null): Promise<ContentMediaDTO> {
  const type = mime.toLowerCase().split(';')[0].trim();
  if (!MEDIA_TYPES.test(type)) throw badRequest('Photos (JPG, PNG, WebP, HEIC) or videos (MP4, MOV) only.');
  if (!bytes.length) throw badRequest('That file is empty.');
  if (bytes.length > (type.startsWith('video/') ? MEDIA_LIMITS.video : MEDIA_LIMITS.image)) throw badRequest(`Too big — ${type.startsWith('video/') ? 'videos up to 100 MB' : 'photos up to 15 MB'}.`);
  const r = (await db().one<any>('INSERT INTO content_media(mime, name, bytes, size, created_by_staff_id, account, title) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, mime, name, size, title, tags, account, approved, created_at',
    [type, name?.slice(0, 200) ?? null, bytes, bytes.length, staffId, ACCOUNT_IDS.includes(account as ContentAccountId) ? account : null, name ? name.replace(/\.[a-z0-9]+$/i, '').slice(0, 120) : null]))!;
  return mediaDTO(r);
}
export async function readMedia(id: string) { return db().one<{ mime: string; bytes: Buffer; name: string | null }>('SELECT mime, bytes, name FROM content_media WHERE id = $1', [id]); }
/** The asset library: files the person's accounts may use (an account's own, or shared), newest first. */
export async function listAssets(u: Who, f: { q?: string; account?: string; tag?: string; approved?: boolean }) {
  const mine = await accountsFor(u);
  const rows = await db().query<any>(`SELECT id, mime, name, size, title, tags, account, approved, created_at FROM content_media
     WHERE (account IS NULL OR account = ANY($1::text[])) ORDER BY created_at DESC LIMIT 500`, [mine]);
  const words = (f.q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((m) => (!f.account || m.account === f.account || (f.account && !m.account)) && (!f.tag || (m.tags ?? []).includes(f.tag)) && (f.approved == null || m.approved === f.approved)
    && words.every((w) => `${m.title ?? ''} ${m.name ?? ''} ${(m.tags ?? []).join(' ')}`.toLowerCase().includes(w))).map(mediaDTO);
}
export async function updateAsset(u: Who, id: string, p: { title?: string | null; tags?: string[]; account?: ContentAccountId | null; approved?: boolean }) {
  if (p.approved !== undefined && !has(u, 'content:approve')) throw forbidden('Only people who approve content can mark assets approved.');
  if (p.account) await assertAccount(u, p.account);
  await db().query(`UPDATE content_media SET title = COALESCE($2, title), tags = COALESCE($3, tags), account = CASE WHEN $4 THEN $5 ELSE account END, approved = COALESCE($6, approved) WHERE id = $1`,
    [id, p.title ?? null, p.tags ? [...new Set(p.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))] : null, p.account !== undefined, p.account ?? null, p.approved ?? null]);
}
export async function deleteAsset(id: string) {
  const used = await db().one('SELECT 1 FROM content_posts WHERE $1 = ANY(media_ids) LIMIT 1', [id]);
  if (used) throw badRequest('It’s used in a post — remove it from the post first.');
  await db().query('DELETE FROM content_media WHERE id = $1', [id]);
}

// ---------------- Posts ----------------
const SELECT = `SELECT p.*, a.name AS assigned_name, r.name AS reviewer_name, b.name AS publisher_name, c.name AS campaign_name
  FROM content_posts p LEFT JOIN staff a ON a.id = p.assigned_staff_id LEFT JOIN staff r ON r.id = p.reviewer_staff_id
  LEFT JOIN staff b ON b.id = p.publisher_staff_id LEFT JOIN content_campaigns c ON c.id = p.campaign_id`;
async function toDTO(rows: any[]): Promise<ContentPostDTO[]> {
  const ids = [...new Set(rows.flatMap((r) => r.media_ids ?? []))];
  const media = new Map((ids.length ? await db().query<any>('SELECT id, mime, name, size, title, tags, account, approved, created_at FROM content_media WHERE id = ANY($1::uuid[])', [ids]) : []).map((m) => [m.id as string, mediaDTO(m)]));
  return rows.map((r) => ({
    id: r.id, account: r.account, platform: r.platform, type: r.post_type, title: r.title, scheduledAt: iso(r.scheduled_at), dueAt: iso(r.due_at),
    headline: r.headline, caption: r.caption, cta: r.cta, hashtags: r.hashtags, pillar: r.pillar, status: r.status, autoPost: r.auto_post,
    media: (r.media_ids ?? []).map((id: string) => media.get(id)).filter(Boolean), externalLinks: r.external_links ?? [],
    link: r.link_kind ? { kind: r.link_kind, ref: r.link_ref, label: r.link_label ?? '' } : null,
    campaignId: r.campaign_id, campaignName: r.campaign_name ?? null, groupId: r.group_id, sourcePostId: r.source_post_id, ideaId: r.idea_id,
    assignedStaffId: r.assigned_staff_id, assignedName: r.assigned_name ?? null, reviewerStaffId: r.reviewer_staff_id, reviewerName: r.reviewer_name ?? null,
    publisherStaffId: r.publisher_staff_id, publisherName: r.publisher_name ?? null, notes: r.notes, revision: r.revision,
    metrics: r.metrics ?? {}, metricsSource: r.metrics_source, metricsUpdatedAt: iso(r.metrics_updated_at), email: r.email ?? null,
    permalink: r.permalink, postedAt: iso(r.posted_at), error: r.error, createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)!,
  }));
}
/** Posts scheduled in [from, to), plus ideas with no date — only the person's accounts. */
export async function listPosts(u: Who, from: string, to: string) {
  return toDTO(await db().query(`${SELECT} WHERE p.account = ANY($3::text[]) AND ((p.scheduled_at >= $1 AND p.scheduled_at < $2) OR p.scheduled_at IS NULL)
    ORDER BY p.scheduled_at NULLS LAST, p.created_at`, [from, to, await accountsFor(u)]));
}
export async function getPost(u: Who, id: string) {
  const r = await db().one(`${SELECT} WHERE p.id = $1`, [id]);
  if (!r) throw notFound('Post not found');
  await assertAccount(u, r.account);
  return (await toDTO([r]))[0];
}

export interface PostFields {
  platform: ContentPlatform; type: ContentPostType; title: string; scheduledAt: string | null; dueAt: string | null;
  headline: string | null; caption: string; cta: string | null; hashtags: string | null; pillar: string | null; autoPost: boolean;
  mediaIds: string[]; externalLinks: string[]; link: ContentPostDTO['link']; campaignId: string | null;
  assignedStaffId: string | null; reviewerStaffId: string | null; publisherStaffId: string | null; notes: string | null; ideaId?: string | null;
  /** Email campaigns only. */
  email?: ContentEmail | null;
}

/** What Instagram auto-posting needs for this post (null = ready). */
export function autoPostProblem(p: { platform: string; type: ContentPostType; scheduledAt: string | null; media: { mime: string }[] }, connected: boolean) {
  if (p.platform !== 'instagram') return 'Auto-posting is for Instagram; schedule others and confirm them as published.';
  if (!['feed', 'carousel', 'reel', 'story'].includes(p.type)) return 'Pick Post, Carousel, Reel or Story to auto-post to Instagram.';
  if (!connected) return 'This account isn’t connected for auto-posting yet (Settings → API & Integrations → Instagram).';
  if (!p.scheduledAt) return 'Pick a date and time to post it.';
  const videos = p.media.filter((m) => m.mime.startsWith('video/')).length;
  if (!p.media.length) return 'Add a photo or video.';
  if (p.type === 'carousel' && (p.media.length < 2 || p.media.length > 10)) return 'A carousel needs 2 to 10 photos or videos.';
  if (p.type === 'reel' && (p.media.length !== 1 || videos !== 1)) return 'A Reel is one video.';
  if ((p.type === 'feed' || p.type === 'story') && p.media.length !== 1) return `A ${p.type === 'story' ? 'Story' : 'post'} is one photo or video (use Carousel for several).`;
  if (p.media.some((m) => /heic|heif/.test(m.mime))) return 'Instagram can’t take HEIC photos — upload a JPG or PNG.';
  return null;
}
const fullCaption = (r: { caption: string; cta?: string | null; hashtags?: string | null }) => [r.caption.trim(), r.cta?.trim(), r.hashtags?.trim()].filter(Boolean).join('\n\n');
function checkFields(f: PostFields) {
  if (fullCaption(f).length > 2200 && f.platform === 'instagram') throw badRequest('Instagram captions (with the CTA and hashtags) are up to 2,200 characters.');
  if (!f.title.trim()) throw badRequest('Give the post a title.');
}
const VALUES = (f: PostFields) => [f.platform, f.type, f.title.trim().slice(0, 200), f.scheduledAt, f.dueAt, f.headline, f.caption, f.cta, f.hashtags, f.pillar, f.autoPost, f.mediaIds, f.externalLinks,
  f.link?.kind ?? null, f.link?.ref ?? null, f.link?.label ?? null, f.campaignId, f.assignedStaffId, f.reviewerStaffId, f.publisherStaffId, f.notes];

async function log(postId: string, staffId: string | null, kind: 'comment' | 'status' | 'revision', body: string | null, from?: string | null, to?: string | null) {
  await db().query('INSERT INTO content_comments(post_id, staff_id, kind, body, from_status, to_status) VALUES ($1,$2,$3,$4,$5,$6)', [postId, staffId, kind, body, from ?? null, to ?? null]);
}
async function notify(staffId: string | null | undefined, title: string, body: string, postId: string, except?: string) {
  if (!staffId || staffId === except) return;
  await db().query("INSERT INTO notifications(staff_id, kind, title, body, link) VALUES ($1,'content',$2,$3,$4)", [staffId, title, body.slice(0, 300), `/content?post=${postId}`]);
}

/**
 * New posts: one per chosen account (linked by a group, each edited, approved and tracked on its own). A new post starts
 * as an Idea or a Draft; it moves on through the workflow.
 */
export async function createPosts(u: Who, accounts: ContentAccountId[], f: PostFields, status: 'idea' | 'draft', sourcePostId: string | null = null, schedules: Partial<Record<ContentAccountId, string | null>> = {}, groupId: string | null = null) {
  if (!accounts.length) throw badRequest('Choose at least one account.');
  for (const a of accounts) await assertAccount(u, a);
  checkFields(f);
  const group = groupId ?? (accounts.length > 1 ? crypto.randomUUID() : null);
  const out: ContentPostDTO[] = [];
  for (const account of accounts) {
    const r = (await db().one<{ id: string }>(
      `INSERT INTO content_posts(account, platform, post_type, title, scheduled_at, due_at, headline, caption, cta, hashtags, pillar, auto_post, media_ids, external_links,
         link_kind, link_ref, link_label, campaign_id, assigned_staff_id, reviewer_staff_id, publisher_staff_id, notes, status, group_id, source_post_id, idea_id, created_by_staff_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::boolean,$13::uuid[],$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27) RETURNING id`,
      // Cross-posted accounts can go out on different days (their own date and time).
      [account, ...VALUES({ ...f, autoPost: false, scheduledAt: account in schedules ? schedules[account] ?? null : f.scheduledAt }), status, group, sourcePostId, f.ideaId ?? null, u.id]))!;
    if (f.email !== undefined) await db().query('UPDATE content_posts SET email = $2 WHERE id = $1', [r.id, f.platform === 'email' && f.email ? JSON.stringify(f.email) : null]);
    await log(r.id, u.id, 'status', null, null, status);
    out.push(await getPost(u, r.id));
  }
  return out;
}

/** Edits the post's content. Changing the caption, headline, CTA or hashtags keeps the previous version (a revision). */
export async function updatePost(u: Who, id: string, f: PostFields) {
  const before = await getPost(u, id);
  if (['publishing', 'published'].includes(before.status)) throw badRequest(before.status === 'published' ? 'It’s published — repurpose it to make a new version.' : 'It’s being posted right now — try again in a minute.');
  checkFields(f);
  if (f.autoPost && !has(u, 'content:publish')) throw forbidden('Only people who publish content can turn on auto-posting.');
  if (f.autoPost && (await contentAccounts()).find((a) => a.id === before.account)?.privateAccount) throw badRequest('This account is private — Instagram doesn’t let apps post to it. It’s posted by hand, with a “Time to post” reminder.');
  const changedCopy = before.caption !== f.caption || before.headline !== f.headline || before.cta !== f.cta || before.hashtags !== f.hashtags
    || (f.email !== undefined && (before.email?.subject ?? null) !== (f.email?.subject ?? null)) || (f.email !== undefined && (before.email?.previewText ?? null) !== (f.email?.previewText ?? null));
  if (changedCopy) await log(id, u.id, 'revision', JSON.stringify({ revision: before.revision, headline: before.headline, caption: before.caption, cta: before.cta, hashtags: before.hashtags }));
  // Approved copy that changes goes back for review (when approval is required).
  const { requireApproval } = await contentSettings();
  const backToReview = changedCopy && requireApproval && ['approved', 'scheduled'].includes(before.status);
  const moved = before.scheduledAt !== f.scheduledAt || before.assignedStaffId !== f.assignedStaffId;
  await db().query(
    `UPDATE content_posts SET platform=$2, post_type=$3, title=$4, scheduled_at=$5, due_at=$6, headline=$7, caption=$8, cta=$9, hashtags=$10, pillar=$11, auto_post=$12,
       media_ids=$13::uuid[], external_links=$14, link_kind=$15, link_ref=$16, link_label=$17, campaign_id=$18, assigned_staff_id=$19, reviewer_staff_id=$20, publisher_staff_id=$21, notes=$22,
       revision = revision + $23::int, status = CASE WHEN $24 THEN 'in_review' ELSE status END,
       reminded_day_before = reminded_day_before AND NOT $25, reminded_today = reminded_today AND NOT $25, reminded_due = reminded_due AND NOT $25, updated_at = now() WHERE id = $1`,
    [id, ...VALUES(f), changedCopy ? 1 : 0, backToReview, moved]);
  if (f.email !== undefined) await db().query('UPDATE content_posts SET email = $2 WHERE id = $1', [id, f.platform === 'email' && f.email ? JSON.stringify(f.email) : null]);
  if (backToReview) {
    await log(id, u.id, 'status', 'Copy changed after approval', before.status, 'in_review');
    await notify(f.reviewerStaffId, 'Post back in review', `“${f.title}” changed after it was approved.`, id, u.id);
  }
  return getPost(u, id);
}

/** Moves a post to another day (drag and drop), keeping the time. */
export async function reschedule(u: Who, id: string, scheduledAt: string | null) {
  const p = await getPost(u, id);
  if (['publishing', 'published'].includes(p.status)) throw badRequest('Published posts stay where they are.');
  await db().query('UPDATE content_posts SET scheduled_at = $2, reminded_day_before = false, reminded_today = false, reminded_due = false, updated_at = now() WHERE id = $1', [id, scheduledAt]);
  return getPost(u, id);
}

/**
 * The workflow. Creators move Idea → Draft → In review (and back from Changes requested); reviewers approve or request
 * changes; publishers schedule and confirm publication. With approval required, only approved posts are scheduled.
 */
export async function transition(u: Who, id: string, to: ContentStatus, comment: string | null) {
  const p = await getPost(u, id);
  const from = p.status;
  if (from === to) return p;
  const { requireApproval } = await contentSettings();
  const creator = has(u, 'content:manage'); const reviewer = has(u, 'content:approve'); const publisher = has(u, 'content:publish');
  const allowed: Partial<Record<ContentStatus, () => boolean>> = {
    idea: () => creator && ['draft', 'changes_requested'].includes(from),
    draft: () => creator && ['idea', 'in_review', 'changes_requested', 'approved', 'scheduled', 'failed'].includes(from),
    in_review: () => creator && ['idea', 'draft', 'changes_requested'].includes(from),
    changes_requested: () => reviewer && ['in_review', 'approved', 'scheduled'].includes(from),
    approved: () => reviewer && ['in_review', 'changes_requested', 'draft', 'scheduled', 'failed'].includes(from),
    scheduled: () => publisher && (from === 'approved' || (!requireApproval && ['draft', 'in_review'].includes(from)) || (from === 'failed' && (!requireApproval || true))),
    published: () => publisher && ['approved', 'scheduled', 'failed'].includes(from) && (!requireApproval || from !== 'draft'),
  };
  if (!allowed[to]?.()) {
    if (to === 'scheduled' && requireApproval && from !== 'approved') throw badRequest('Approve it first — posts need approval before they’re scheduled.');
    throw forbidden(`You can’t move a post from ${from.replace('_', ' ')} to ${to.replace('_', ' ')}.`);
  }
  if (to === 'scheduled') {
    if (!p.scheduledAt) throw badRequest('Pick a date and time first.');
    // An email is "Scheduled in Flodesk" only once it's set up there — its Flodesk link is the record of that.
    if (p.platform === 'email' && !p.email?.flodeskUrl) throw badRequest('Schedule it in Flodesk first, then add the Flodesk campaign link and mark it scheduled.');
    if (p.autoPost) {
      const acc = (await contentAccounts()).find((a) => a.id === p.account);
      if (acc?.privateAccount) throw badRequest(`${acc.name} is private — Instagram doesn’t let apps post to it. Turn off auto-posting; you’ll get a “Time to post” reminder instead.`);
      const problem = autoPostProblem(p, (await postableSlots()).has(p.account)); if (problem) throw badRequest(problem);
    }
  }
  if (to === 'changes_requested' && !comment?.trim()) throw badRequest('Say what needs changing.');
  // Published by hand: confirmed by someone allowed to publish (auto-posting sets it itself).
  await db().query(`UPDATE content_posts SET status = $2, posted_at = CASE WHEN $2 = 'published' THEN COALESCE(posted_at, now()) ELSE posted_at END,
    error = CASE WHEN $2 IN ('scheduled','approved') THEN NULL ELSE error END, updated_at = now() WHERE id = $1`, [id, to]);
  await log(id, u.id, 'status', comment?.trim() || (to === 'published' ? (p.platform === 'email' ? 'Confirmed as sent (Flodesk)' : 'Confirmed as published') : to === 'scheduled' && p.platform === 'email' ? 'Scheduled in Flodesk' : null), from, to);
  const t = `“${p.title}”`;
  if (to === 'in_review') await notify(p.reviewerStaffId, 'Post to review', `${t} is ready for review.`, id, u.id);
  if (to === 'changes_requested') await notify(p.assignedStaffId, 'Changes requested', `${t}: ${comment}`, id, u.id);
  if (to === 'approved') { await notify(p.assignedStaffId, 'Post approved', `${t} was approved.`, id, u.id); await notify(p.publisherStaffId, 'Post approved — ready to schedule', t, id, u.id); }
  return getPost(u, id);
}

export async function deletePost(u: Who, id: string) {
  const p = await getPost(u, id);
  if (p.status === 'published' && !has(u, 'content:publish')) throw forbidden('Only people who publish content can delete published posts.');
  await db().query('DELETE FROM content_posts WHERE id = $1', [id]);
}

export async function comments(u: Who, id: string): Promise<ContentCommentDTO[]> {
  await getPost(u, id);
  return (await db().query<any>(`SELECT c.*, s.name AS staff_name FROM content_comments c LEFT JOIN staff s ON s.id = c.staff_id WHERE c.post_id = $1 ORDER BY c.created_at`, [id]))
    .map((c) => ({ id: c.id, kind: c.kind, body: c.body, fromStatus: c.from_status, toStatus: c.to_status, staffName: c.staff_name ?? null, createdAt: iso(c.created_at)! }));
}
export async function addComment(u: Who, id: string, body: string) {
  const p = await getPost(u, id);
  await log(id, u.id, 'comment', body.trim().slice(0, 2000));
  for (const s of new Set([p.assignedStaffId, p.reviewerStaffId, p.publisherStaffId])) await notify(s, `Comment on “${p.title}”`, body, id, u.id);
}

/**
 * Cross-post: the same post for other accounts, each on its own day (its own entry — edited, approved and scheduled on
 * its own, linked to this one). The content is copied; the call to action becomes the target account's when the post
 * used its own account's (or none). For a version rewritten for another audience, use Repurpose.
 */
export async function crossPost(u: Who, id: string, targets: { account: ContentAccountId; scheduledAt: string | null }[]) {
  const src = await getPost(u, id);
  const accounts = await contentAccounts();
  const srcCta = accounts.find((a) => a.id === src.account)?.cta;
  let group = src.groupId;
  if (!group) { group = crypto.randomUUID(); await db().query('UPDATE content_posts SET group_id = $2 WHERE id = $1', [id, group]); }
  const out: ContentPostDTO[] = [];
  for (const t of targets) {
    if (t.account === src.account) continue;
    const acc = accounts.find((a) => a.id === t.account)!;
    const [p] = await createPosts(u, [t.account], {
      platform: src.platform, type: src.type, title: src.title, scheduledAt: t.scheduledAt, dueAt: src.dueAt, headline: src.headline, caption: src.caption,
      cta: !src.cta || src.cta === srcCta ? acc.cta : src.cta, hashtags: src.hashtags, pillar: acc.pillars.includes(src.pillar ?? '') ? src.pillar : null, autoPost: false,
      mediaIds: src.media.map((m) => m.id), externalLinks: src.externalLinks, link: src.link, campaignId: src.campaignId, assignedStaffId: src.assignedStaffId,
      reviewerStaffId: src.reviewerStaffId, publisherStaffId: src.publisherStaffId, notes: src.notes, ideaId: src.ideaId,
    }, 'draft', src.id, {}, group);
    out.push(p);
  }
  return out;
}

/**
 * Repurpose: new drafts for other accounts or platforms from a post — the original isn't changed. Each new draft is
 * rewritten for its account's audience and CTA (with AI when available, else the account's CTA and the same copy).
 */
export async function repurpose(u: Who, id: string, targets: { account: ContentAccountId; platform: ContentPlatform; type: ContentPostType }[]) {
  const src = await getPost(u, id);
  const accounts = await contentAccounts();
  const out: ContentPostDTO[] = [];
  for (const t of targets) {
    const acc = accounts.find((a) => a.id === t.account)!;
    const g = await generate({ account: t.account, platform: t.platform, format: t.type, pillar: src.pillar, tone: null, objective: null, campaign: src.campaignName,
      brief: `Repurpose this post for ${acc.name} (${t.platform}, ${t.type}). Keep the idea; adapt the message for this account's audience.\nTitle: ${src.title}\nHeadline: ${src.headline ?? ''}\nCaption: ${src.caption}\nCTA: ${src.cta ?? ''}` });
    const [p] = await createPosts(u, [t.account], {
      platform: t.platform, type: t.type, title: `${src.title} (${acc.name})`.slice(0, 200), scheduledAt: null, dueAt: null, headline: g.headline ?? src.headline, caption: g.caption || src.caption,
      cta: g.cta ?? acc.cta, hashtags: g.hashtags ?? src.hashtags, pillar: src.pillar, autoPost: false, mediaIds: src.media.map((m) => m.id), externalLinks: src.externalLinks, link: src.link,
      campaignId: src.campaignId, assignedStaffId: src.assignedStaffId, reviewerStaffId: src.reviewerStaffId, publisherStaffId: src.publisherStaffId,
      notes: [g.extra, `Repurposed from “${src.title}”.`].filter(Boolean).join('\n\n'),
    }, 'draft', src.id);
    out.push(p);
  }
  return out;
}

/** Performance by hand (marked manual), or imported from Instagram for posts it published. */
export async function setMetrics(u: Who, id: string, m: ContentMetrics) {
  await getPost(u, id);
  await db().query("UPDATE content_posts SET metrics = $2, metrics_source = 'manual', metrics_updated_at = now() WHERE id = $1", [id, JSON.stringify(m)]);
  return getPost(u, id);
}
export async function importMetrics(u: Who | null, id: string) {
  const r = await db().one<any>('SELECT account, platform, ig_media_id, metrics FROM content_posts WHERE id = $1', [id]);
  if (!r) throw notFound('Post not found');
  if (u) await assertAccount(u, r.account);
  if (r.platform !== 'instagram' || !r.ig_media_id) throw badRequest('Only posts the CRM published to Instagram can import their numbers — enter others by hand.');
  const a = instagramAccounts(config()).find((x) => x.slot === r.account);
  if (!a) throw badRequest('This account isn’t connected (Settings → API & Integrations → Instagram).');
  const got = await new InstagramApi(a.accountId, a.token).insights(r.ig_media_id);
  const m: ContentMetrics = { ...(r.metrics ?? {}), ...got };
  await db().query("UPDATE content_posts SET metrics = $2, metrics_source = 'imported', metrics_updated_at = now() WHERE id = $1", [id, JSON.stringify(m)]);
  return m;
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

// ---------------- Campaigns ----------------
export async function listCampaigns(): Promise<ContentCampaignDTO[]> {
  return (await db().query<any>(`SELECT c.*, (SELECT count(*)::int FROM content_posts p WHERE p.campaign_id = c.id) AS posts FROM content_campaigns c ORDER BY c.starts_on NULLS LAST, c.name`))
    .map((c) => ({ id: c.id, name: c.name, accounts: c.accounts ?? [], startsOn: c.starts_on ? String(iso(c.starts_on)).slice(0, 10) : null, endsOn: c.ends_on ? String(iso(c.ends_on)).slice(0, 10) : null, notes: c.notes, posts: c.posts, kind: c.kind ?? 'campaign', product: c.product ?? null }));
}
export async function saveCampaign(c: { id?: string; name: string; accounts: ContentAccountId[]; startsOn: string | null; endsOn: string | null; notes: string | null }) {
  if (c.id) {
    await db().query('UPDATE content_campaigns SET name=$2, accounts=$3, starts_on=$4, ends_on=$5, notes=$6 WHERE id=$1', [c.id, c.name, c.accounts, c.startsOn, c.endsOn, c.notes]);
    await placeLaunchPosts(c.id); // a launch's posts follow its release date
    return listCampaigns();
  }
  else await db().query('INSERT INTO content_campaigns(name, accounts, starts_on, ends_on, notes) VALUES ($1,$2,$3,$4,$5)', [c.name, c.accounts, c.startsOn, c.endsOn, c.notes]);
  return listCampaigns();
}
export async function deleteCampaign(id: string) {
  await db().query('UPDATE content_posts SET campaign_id = NULL WHERE campaign_id = $1', [id]);
  await db().query('DELETE FROM content_campaigns WHERE id = $1', [id]);
  return listCampaigns();
}

// ---------------- Product launches ----------------
/** An instant at the given local time on a day, in the salon's time zone (e.g. 10:00 on the release date). */
async function atLocal(day: string, hh: number, mm = 0) {
  const tz = (await getSettings()).business.timezone;
  const guess = new Date(`${day}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`);
  const local = new Date(guess.toLocaleString('en-US', { timeZone: tz }));
  return new Date(guess.getTime() + (guess.getTime() - local.getTime()));
}
const plusDays = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);

/**
 * A product launch: a campaign for the product with its promotion drafts — teasers, launch day and follow-ups for each
 * chosen account — placed around the release date (or unscheduled until it's set). Nothing is approved or posted.
 */
export async function createLaunch(u: Who, l: { product: string; releaseOn: string | null; accounts: ContentAccountId[]; notes: string | null }) {
  for (const a of l.accounts) await assertAccount(u, a);
  const { launchPlan } = await import('./contentLaunch.js');
  const c = (await db().one<{ id: string }>(`INSERT INTO content_campaigns(name, accounts, starts_on, notes, kind, product) VALUES ($1,$2,$3,$4,'launch',$5) RETURNING id`,
    [`Launch: ${l.product.trim()}`, l.accounts, l.releaseOn, l.notes, l.product.trim()]))!;
  const accounts = await contentAccounts();
  for (const p of launchPlan(l.product, l.accounts)) {
    const [post] = await createPosts(u, [p.account], {
      platform: p.platform ?? 'instagram', type: p.type, title: p.title, scheduledAt: null, dueAt: null, headline: p.hook, caption: p.caption, cta: p.cta || accounts.find((a) => a.id === p.account)?.cta || null,
      hashtags: p.hashtags || null, pillar: p.account === 'a3' ? 'Professional product recommendations' : p.account === 'a1' ? 'Retail: Milbon & Oribe' : 'Launches & restocks', autoPost: false,
      mediaIds: [], externalLinks: [], link: null, campaignId: c.id, assignedStaffId: null, reviewerStaffId: null, publisherStaffId: null, notes: p.notes || null,
    }, 'draft');
    await db().query('UPDATE content_posts SET launch_offset = $2, email = $3 WHERE id = $1', [post.id, p.offset, p.email ? JSON.stringify({ audience: [], objective: null, destinationUrl: null, draftUrl: null, flodeskUrl: null, ...p.email }) : null]);
  }
  await placeLaunchPosts(c.id);
  return (await listCampaigns()).find((x) => x.id === c.id)!;
}

/** Puts a launch's posts at release date + their offset (10:00 salon time); unscheduled while there's no date. Posted or scheduled ones stay. */
export async function placeLaunchPosts(campaignId: string) {
  const c = await db().one<{ kind: string; starts_on: string | null }>('SELECT kind, starts_on FROM content_campaigns WHERE id = $1', [campaignId]);
  if (!c || c.kind !== 'launch') return 0;
  const day = c.starts_on ? String(iso(c.starts_on)).slice(0, 10) : null;
  const rows = await db().query<{ id: string; launch_offset: number }>(`SELECT id, launch_offset FROM content_posts WHERE campaign_id = $1 AND launch_offset IS NOT NULL AND status NOT IN ('scheduled','publishing','published')`, [campaignId]);
  for (const r of rows) {
    const at = day ? await atLocal(plusDays(day, r.launch_offset), 10) : null;
    await db().query('UPDATE content_posts SET scheduled_at = $2, reminded_day_before = false, reminded_today = false, reminded_due = false, updated_at = now() WHERE id = $1', [r.id, at]);
  }
  return rows.length;
}

/**
 * A campaign's timeline: every deliverable (emails and posts) in date order, which still need approval, and conflicts —
 * two emails to one account within 2 days, or two posts for one account at the same hour.
 */
export async function campaignTimeline(u: Who, id: string) {
  const mine = await accountsFor(u);
  const posts = await toDTO(await db().query(`${SELECT} WHERE p.campaign_id = $1 AND p.account = ANY($2::text[]) ORDER BY p.scheduled_at NULLS LAST, p.created_at`, [id, mine]));
  const conflicts: { a: string; b: string; reason: string }[] = [];
  const dated = posts.filter((p) => p.scheduledAt);
  for (let i = 0; i < dated.length; i++) for (let j = i + 1; j < dated.length; j++) {
    const a = dated[i], b = dated[j];
    if (a.account !== b.account) continue;
    const gap = Math.abs(Date.parse(a.scheduledAt!) - Date.parse(b.scheduledAt!));
    if (a.platform === 'email' && b.platform === 'email' && gap < 2 * 86400_000) conflicts.push({ a: a.id, b: b.id, reason: 'Two emails to the same account within 2 days' });
    else if (a.platform === b.platform && a.platform !== 'email' && gap < 3600_000) conflicts.push({ a: a.id, b: b.id, reason: 'Two posts for the same account within an hour' });
  }
  return { posts, conflicts, needsApproval: posts.filter((p) => !['approved', 'scheduled', 'publishing', 'published'].includes(p.status)).map((p) => p.id) };
}

// ---------------- Ideas library ----------------
const REMOVED_IDEAS_KEY = 'content.ideas.removed';
/** Adds any built-in ideas not there yet (one someone removed isn't added back). */
export async function seedContentIdeas() {
  const removed = new Set((await getKV<string[]>(REMOVED_IDEAS_KEY)) ?? []);
  const have = new Set((await db().query<{ key: string }>('SELECT key FROM content_ideas WHERE key IS NOT NULL')).map((r) => r.key));
  for (const i of [...BUILTIN_IDEAS, ...EMAIL_IDEAS]) {
    if (have.has(i.key) || removed.has(i.key)) continue;
    await db().query(
      `INSERT INTO content_ideas(key, accounts, title, pillar, audience, platform, format, hook, visual, shot_list, caption, cta, hashtags, season, effort, builtin, also_story, subject, preview_text, send_timing)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,true,$16,$17,$18,$19) ON CONFLICT (key) DO NOTHING`,
      [i.key, i.accounts, i.title, i.pillar, i.audience, i.platform, i.format, i.hook, i.visual, i.shots, i.caption, i.cta, i.hashtags, i.season, i.effort, !!i.alsoStory, i.subject ?? null, i.preview ?? null, i.timing ?? null]);
  }
}
const ideaDTO = (r: any, favs: Set<string>): ContentIdeaDTO => ({
  id: r.id, accounts: r.accounts ?? [], title: r.title, pillar: r.pillar, audience: r.audience, platform: r.platform, format: r.format, hook: r.hook, visual: r.visual,
  shotList: r.shot_list, caption: r.caption, cta: r.cta, hashtags: r.hashtags, season: r.season, effort: r.effort, builtin: r.builtin, favorite: favs.has(r.id),
  alsoStory: !!r.also_story, subject: r.subject ?? null, previewText: r.preview_text ?? null, sendTiming: r.send_timing ?? null, suggested: r.status === 'suggested', suggestedOn: r.suggested_on ? String(iso(r.suggested_on)).slice(0, 10) : null,
});
export async function listIdeas(u: Who) {
  await seedContentIdeas();
  const mine = await accountsFor(u);
  const favs = new Set((await db().query<{ idea_id: string }>('SELECT idea_id FROM content_idea_favorites WHERE staff_id = $1', [u.id])).map((r) => r.idea_id));
  return (await db().query<any>(`SELECT * FROM content_ideas WHERE accounts && $1::text[] OR accounts = '{}' ORDER BY builtin, created_at DESC`, [mine])).map((r) => ideaDTO(r, favs));
}
export async function saveIdea(u: Who, i: Omit<ContentIdeaDTO, 'id' | 'builtin' | 'favorite' | 'suggested' | 'suggestedOn'> & { id?: string }) {
  const vals = [i.accounts, i.title, i.pillar, i.audience, i.platform, i.format, i.hook, i.visual, i.shotList, i.caption, i.cta, i.hashtags, i.season, i.effort, !!i.alsoStory, i.subject ?? null, i.previewText ?? null, i.sendTiming ?? null];
  // Editing a suggestion saves it to the library.
  if (i.id) await db().query("UPDATE content_ideas SET accounts=$2, title=$3, pillar=$4, audience=$5, platform=$6, format=$7, hook=$8, visual=$9, shot_list=$10, caption=$11, cta=$12, hashtags=$13, season=$14, effort=$15, also_story=$16, subject=$17, preview_text=$18, send_timing=$19, status='library' WHERE id=$1", [i.id, ...vals]);
  else await db().query('INSERT INTO content_ideas(accounts, title, pillar, audience, platform, format, hook, visual, shot_list, caption, cta, hashtags, season, effort, also_story, subject, preview_text, send_timing, created_by_staff_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)', [...vals, u.id]);
  return listIdeas(u);
}
export async function deleteIdea(u: Who, id: string) {
  const r = await db().one<{ key: string | null }>('DELETE FROM content_ideas WHERE id = $1 RETURNING key', [id]);
  if (r?.key) await setKV(REMOVED_IDEAS_KEY, [...new Set([...((await getKV<string[]>(REMOVED_IDEAS_KEY)) ?? []), r.key])]);
  return listIdeas(u);
}
/** Keeps a suggested idea (moves it into the library, so it isn't replaced next week). */
export async function keepIdea(u: Who, id: string) {
  await db().query("UPDATE content_ideas SET status = 'library', created_by_staff_id = COALESCE(created_by_staff_id, $2) WHERE id = $1", [id, u.id]);
  return listIdeas(u);
}

// ---- New ideas each week (and on demand)
const ANGLES = [
  ['Quick tip', 'One thing to do differently this week.', 'reel', true], ['Myth vs fact', 'You’ve probably heard this — it isn’t true.', 'carousel', false],
  ['Behind the scenes', 'What you don’t usually see.', 'reel', true], ['FAQ', 'The question we get asked most this month.', 'reel', true],
  ['Before & after', 'The difference one appointment makes.', 'reel', true], ['Step by step', 'How it’s done, in five steps.', 'carousel', false],
  ['This or that', 'Which would you choose?', 'story', false], ['Customer story', 'In their words.', 'feed', false],
  ['Save this', 'A checklist worth keeping.', 'carousel', false], ['60-second demo', 'Watch it in action.', 'reel', true],
] as const;
/**
 * Drafts fresh ideas per account — with Claude when it's set up (in the account's voice, pillars and season, avoiding
 * ideas already in the library), else from varied angles on the account's pillars. They're suggestions until saved.
 */
export async function suggestIdeas(accounts: ContentAccountId[] = ACCOUNT_IDS, perAccount = 4, now = new Date()) {
  const all = await contentAccounts();
  const today = now.toISOString().slice(0, 10);
  const season = (SEASONS[now.getMonth()] ?? []).join(', ') || 'any';
  const taken = new Set((await db().query<{ t: string }>('SELECT lower(title) AS t FROM content_ideas')).map((r) => r.t));
  let added = 0;
  for (const id of accounts) {
    const acc = all.find((a) => a.id === id)!;
    let ideas: { title: string; pillar: string; format: string; hook?: string; visual?: string; shotList?: string; caption?: string; cta?: string; hashtags?: string; alsoStory?: boolean }[] = [];
    const ai = aiService();
    if (ai.write) {
      try {
        const text = await ai.write(
          `You plan Instagram content for ${acc.name}. Voice: ${acc.voice} Primary CTA: ${acc.cta}. Pillars: ${acc.pillars.join('; ')}. Reply with ONLY a JSON array.`,
          `Suggest ${perAccount} fresh post ideas for this week (season: ${season}). Mix formats (reel, carousel, story, feed); at least one Reel that also works as a Story (alsoStory: true). Don't repeat these existing titles: ${[...taken].slice(0, 80).join(' | ')}.
Each: {"title","pillar" (one of the pillars),"format" (reel|carousel|story|feed),"hook","visual","shotList","caption","cta","hashtags","alsoStory"}.`, 2500);
        ideas = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1));
      } catch (e) { console.warn('[content] idea suggestions:', (e as Error).message); }
    }
    if (!ideas.length) {
      // Built-in: rotate pillars and angles by week so each week brings different ones.
      const week = Math.floor(now.getTime() / (7 * 86400_000));
      ideas = Array.from({ length: perAccount }, (_, k) => {
        const pillar = acc.pillars[(week * perAccount + k) % acc.pillars.length];
        const [angle, hook, format, story] = ANGLES[(week + k * 3 + id.charCodeAt(1)) % ANGLES.length];
        return { title: `${angle}: ${pillar}`, pillar, format, hook, visual: 'Vertical, natural light, captions on screen', shotList: '1. Hook (2s)\n2. The point, shown\n3. Proof or result\n4. Call to action', caption: `${hook} ${pillar} — our take.`, cta: acc.cta, hashtags: '', alsoStory: story };
      });
    }
    for (const i of ideas.slice(0, perAccount)) {
      if (!i?.title || taken.has(i.title.toLowerCase())) continue;
      taken.add(i.title.toLowerCase());
      const format = ['reel', 'carousel', 'story', 'feed'].includes(i.format) ? i.format : 'reel';
      await db().query(`INSERT INTO content_ideas(accounts, title, pillar, platform, format, hook, visual, shot_list, caption, cta, hashtags, season, effort, also_story, status, suggested_on)
        VALUES ($1,$2,$3,'instagram',$4,$5,$6,$7,$8,$9,$10,$11,'medium',$12,'suggested',$13)`,
        [[id], String(i.title).slice(0, 200), String(i.pillar || acc.pillars[0]).slice(0, 120), format, i.hook ?? null, i.visual ?? null, i.shotList ?? null, i.caption ?? null, i.cta ?? acc.cta, i.hashtags || null, season, format === 'reel' && i.alsoStory !== false, today]);
      added++;
    }
  }
  return added;
}
/** Scheduler: once a week (from Monday), unsaved suggestions from earlier weeks go and new ones are drafted. */
export async function maybeSuggestWeekly(now = new Date()) {
  const monday = new Date(now); monday.setHours(0, 0, 0, 0); monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const week = monday.toISOString().slice(0, 10);
  if ((await getKV<string>('content.ideas.week')) === week) return 0;
  await setKV('content.ideas.week', week);
  await db().query("DELETE FROM content_ideas WHERE status = 'suggested' AND suggested_on < $1 AND id NOT IN (SELECT idea_id FROM content_idea_favorites)", [week]);
  return suggestIdeas(ACCOUNT_IDS, 4, now);
}

export async function favoriteIdea(u: Who, id: string, on: boolean) {
  if (on) await db().query('INSERT INTO content_idea_favorites(staff_id, idea_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [u.id, id]);
  else await db().query('DELETE FROM content_idea_favorites WHERE staff_id = $1 AND idea_id = $2', [u.id, id]);
}

// ---------------- AI drafts ----------------
export interface GenerateInput { account: ContentAccountId; platform: ContentPlatform; format: ContentPostType; pillar: string | null; tone: string | null; objective: string | null; campaign: string | null; brief: string | null; kind?: string | null }
export interface Generated { title: string; headline: string | null; caption: string; cta: string | null; hashtags: string | null; extra: string | null; ai: boolean;
  /** Emails: subject line options (the first is used) and preview text. */
  subjects?: string[]; previewText?: string | null }
const KIND_ASK: Record<string, string> = {
  caption: 'an Instagram caption', reel: 'a Reels script with a shot list (in "extra")', story: 'an Instagram Story sequence, frame by frame (in "extra")',
  carousel: 'a carousel outline with copy for each slide (in "extra")', tiktok: 'a TikTok concept with hook, beats and on-screen text (in "extra")',
  pinterest: 'a Pinterest pin title and description', promo: 'a promotional post', product: 'a product spotlight',
  email: 'an email campaign for Flodesk: 3 subject line options in "subjects", "previewText", the email body in "caption" (short sections with headings), the button text in "cta", and visual direction in "extra"',
};
/** A draft written for the account's voice, audience and CTA — with Claude when set up, else from the closest library idea. Always editable; never posted. */
export async function generate(i: GenerateInput): Promise<Generated> {
  const acc = (await contentAccounts()).find((a) => a.id === i.account)!;
  const kind = i.kind ?? (i.platform === 'email' ? 'email' : i.platform === 'tiktok' ? 'tiktok' : i.platform === 'pinterest' ? 'pinterest' : i.format === 'reel' ? 'reel' : i.format === 'story' ? 'story' : i.format === 'carousel' ? 'carousel' : 'caption');
  const ai = aiService();
  if (ai.write) {
    const salon = (await getSettings()).business.name;
    const system = `You write ${kind === 'email' ? 'email marketing (Flodesk)' : 'social media content'} for ${acc.name} (${acc.brand === 'salon' ? `${salon}, a luxury hair salon` : 'Addendum Hair, a professional hair extension brand'}). Voice: ${acc.voice}${acc.id === 'a1' ? ' Luxury editorial tone.' : acc.id === 'a2' ? ' Product-focused brand voice.' : ' Educational, professional tone for stylists.'} Primary call to action: ${acc.cta}. Content pillars: ${acc.pillars.join('; ')}. Never invent prices, discounts or claims that weren't given. Reply with ONLY a JSON object: {"title": short internal title, "headline": string|null, "caption": string, "cta": string, "hashtags": string (space-separated, 5-12, or "" for email), "extra": string|null${kind === 'email' ? ', "subjects": string[], "previewText": string' : ''}}.`;
    const user = [`Write ${KIND_ASK[kind] ?? KIND_ASK.caption} for ${i.platform} (${i.format}).`, i.pillar && `Pillar: ${i.pillar}.`, i.objective && `Objective: ${i.objective}.`, i.tone && `Tone: ${i.tone}.`, i.campaign && `Campaign: ${i.campaign}.`, i.brief && `Brief:\n${i.brief}`].filter(Boolean).join('\n');
    try {
      const text = await ai.write(system, user, 1500);
      const j = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
      const subjects = Array.isArray(j.subjects) ? j.subjects.map(String).filter(Boolean).slice(0, 5) : undefined;
      return { title: String(j.title ?? '').slice(0, 200) || 'AI draft', headline: subjects?.[0] ?? j.headline ?? null, caption: String(j.caption ?? ''), cta: j.cta ?? acc.cta, hashtags: kind === 'email' ? null : j.hashtags ?? null, extra: j.extra ?? null, ai: true, subjects, previewText: j.previewText ?? null };
    } catch (e) { console.warn('[content] AI draft failed:', (e as Error).message); }
  }
  // Built-in: the closest library idea for this account (pillar and format), with the account's CTA.
  if (kind === 'email') {
    const emails = EMAIL_IDEAS.filter((x) => x.accounts.includes(i.account));
    const e = emails.find((x) => x.pillar === i.pillar) ?? emails[0];
    return { title: e.title, headline: e.subject ?? null, caption: [i.brief?.trim() && !i.brief.startsWith('Repurpose') ? i.brief.trim() : e.caption, '', e.shots].join('\n'), cta: e.cta, hashtags: null,
      extra: `Visual: ${e.visual}\nSend: ${e.timing}`, ai: false, subjects: [e.subject!], previewText: e.preview ?? null };
  }
  const ideas = BUILTIN_IDEAS.filter((x) => x.accounts.includes(i.account));
  const best = ideas.find((x) => x.pillar === i.pillar && x.format === i.format) ?? ideas.find((x) => x.pillar === i.pillar) ?? ideas.find((x) => x.format === i.format) ?? ideas[0];
  const brief = i.brief?.trim();
  return {
    title: best ? best.title : 'Draft', headline: best?.hook ?? null,
    caption: [best?.hook, brief && !brief.startsWith('Repurpose') ? brief : best?.caption].filter(Boolean).join('\n\n'),
    cta: acc.cta, hashtags: best?.hashtags ?? null, extra: best ? `Visual: ${best.visual}\n\nShot list:\n${best.shots}` : null, ai: false,
  };
}

// ---------------- Planning and analytics ----------------
const SEASONS: Record<number, string[]> = { 0: ['new-year'], 1: ['valentines'], 2: ['spring'], 3: ['spring'], 4: ['spring', 'mothers-day'], 5: ['summer'], 6: ['summer'], 7: ['summer', 'back-to-school'], 8: ['fall', 'back-to-school'], 9: ['fall'], 10: ['fall', 'holiday'], 11: ['holiday'] };
/** This week and the next few: planned and published per account and platform against the weekly goals, empty weeks, and ideas for them. */
export async function planning(u: Who, weeks = 5, now = new Date()) {
  const mine = await accountsFor(u);
  const { goals } = await contentSettings();
  const monday = new Date(now); monday.setHours(0, 0, 0, 0); monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const end = new Date(monday.getTime() + weeks * 7 * 86400_000);
  const rows = await db().query<any>(`SELECT account, platform, status, scheduled_at, campaign_id FROM content_posts WHERE account = ANY($1::text[]) AND scheduled_at >= $2 AND scheduled_at < $3`, [mine, monday, end]);
  const out = Array.from({ length: weeks }, (_, w) => {
    const from = new Date(monday.getTime() + w * 7 * 86400_000); const to = new Date(from.getTime() + 7 * 86400_000);
    const inWeek = rows.filter((r) => new Date(r.scheduled_at) >= from && new Date(r.scheduled_at) < to && r.status !== 'idea');
    const accounts = mine.map((a) => {
      const platforms = [...new Set([...Object.keys(goals[a] ?? {}), ...inWeek.filter((r) => r.account === a).map((r) => r.platform)])].map((pl) => ({
        platform: pl, goal: goals[a]?.[pl as ContentPlatform] ?? 0,
        planned: inWeek.filter((r) => r.account === a && r.platform === pl).length, published: inWeek.filter((r) => r.account === a && r.platform === pl && r.status === 'published').length,
      }));
      return { account: a, platforms, empty: !inWeek.some((r) => r.account === a) };
    });
    return { weekOf: from.toISOString().slice(0, 10), accounts };
  });
  // Ideas for what's coming: seasonal ones for the coming weeks' months, and campaigns without posts yet.
  const seasons = new Set([now.getMonth(), new Date(end).getMonth()].flatMap((m) => SEASONS[m]));
  const ideas = (await listIdeas(u)).filter((i) => i.season && seasons.has(i.season)).slice(0, 8);
  const campaigns = (await listCampaigns()).filter((c) => !c.posts && (!c.endsOn || c.endsOn >= now.toISOString().slice(0, 10)));
  return { weeks: out, seasonalIdeas: ideas, campaignsWithoutPosts: campaigns };
}

const ENGAGE = (m: ContentMetrics) => (m.likes ?? 0) + (m.comments ?? 0) + (m.saves ?? 0) + (m.shares ?? 0);
/** Totals per account and platform for published posts in the range, the top posts, and what to make more of. */
export async function analytics(u: Who, from: string, to: string) {
  const mine = await accountsFor(u);
  const posts = await toDTO(await db().query(`${SELECT} WHERE p.account = ANY($3::text[]) AND p.status = 'published' AND COALESCE(p.posted_at, p.scheduled_at) >= $1 AND COALESCE(p.posted_at, p.scheduled_at) < $2`, [from, to, mine]));
  const KEYS: (keyof ContentMetrics)[] = ['reach', 'impressions', 'views', 'likes', 'comments', 'saves', 'shares', 'clicks', 'bookingInquiries', 'productClicks', 'salesCents', 'recipients', 'delivered', 'opens', 'unsubscribes', 'bounces'];
  const sum = (list: ContentPostDTO[]) => Object.fromEntries(KEYS.map((k) => [k, list.reduce((n, p) => n + (p.metrics[k] ?? 0), 0)])) as Required<ContentMetrics>;
  const group = (key: (p: ContentPostDTO) => string, from = posts) => [...new Set(from.map(key))].map((k) => { const l = from.filter((p) => key(p) === k); return { key: k, posts: l.length, withMetrics: l.filter((p) => p.metricsSource).length, totals: sum(l), engagement: l.reduce((n, p) => n + ENGAGE(p.metrics), 0) }; });
  const social = posts.filter((p) => p.platform !== 'email');
  const byAccount = group((p) => p.account, social); const byPlatform = group((p) => p.platform, social);
  // Emails on their own (sent ones, numbers from Flodesk's report entered by hand).
  const emailByAccount = group((p) => p.account, posts.filter((p) => p.platform === 'email'));
  const top = [...social].filter((p) => p.metricsSource).sort((a, b) => ENGAGE(b.metrics) - ENGAGE(a.metrics) || (b.metrics.reach ?? 0) - (a.metrics.reach ?? 0)).slice(0, 5);
  // Suggest more of each account's best pillar and format (by average engagement, 2+ posts with numbers).
  const accs = await contentAccounts();
  const suggestions = mine.flatMap((a) => {
    const withNums = posts.filter((p) => p.account === a && p.metricsSource);
    const best = (key: (p: ContentPostDTO) => string | null) => [...new Set(withNums.map(key).filter(Boolean) as string[])]
      .map((k) => { const l = withNums.filter((p) => key(p) === k); return { k, n: l.length, avg: l.reduce((x, p) => x + ENGAGE(p.metrics), 0) / l.length }; })
      .filter((x) => x.n >= 2).sort((x, y) => y.avg - x.avg)[0];
    const name = accs.find((x) => x.id === a)?.name ?? a;
    const pillar = best((p) => p.pillar); const format = best((p) => p.type);
    return [pillar && `${name}: “${pillar.k}” gets the most engagement (about ${Math.round(pillar.avg)} per post) — plan more of it.`, format && `${name}: ${format.k} posts perform best — use that format more.`].filter(Boolean) as string[];
  });
  return { posts: posts.length, totals: sum(posts), byAccount, byPlatform, emailByAccount, top, suggestions, manual: posts.filter((p) => p.metricsSource === 'manual').length, imported: posts.filter((p) => p.metricsSource === 'imported').length };
}

// ---------------- Scheduler: reminders, auto-posting and metrics ----------------
/** Bell reminders for the creator: the day before and on the day (posts not published yet). */
export async function remindContent(now = new Date()) {
  const tz = (await getSettings()).business.timezone;
  const day = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: tz });
  const today = day(now); const tomorrow = day(new Date(now.getTime() + 86400_000));
  const rows = await db().query<any>(`SELECT id, title, account, post_type, scheduled_at, assigned_staff_id, publisher_staff_id, reminded_day_before, reminded_today FROM content_posts
     WHERE scheduled_at IS NOT NULL AND status NOT IN ('published','publishing','idea') AND scheduled_at > $1::timestamptz - interval '1 day' AND (assigned_staff_id IS NOT NULL OR publisher_staff_id IS NOT NULL)`, [now]);
  const names = new Map((await contentAccounts()).map((a) => [a.id, a.name]));
  let sent = 0;
  for (const r of rows) {
    const d = day(new Date(r.scheduled_at));
    const when = new Date(r.scheduled_at).toLocaleString('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: '2-digit' });
    const who = [...new Set([r.assigned_staff_id, r.publisher_staff_id].filter(Boolean))];
    if (d === tomorrow && !r.reminded_day_before) {
      for (const s of who) await notify(s, `Tomorrow: ${r.title}`, `${names.get(r.account) ?? ''} · ${when}. Make sure it’s ready.`, r.id);
      await db().query('UPDATE content_posts SET reminded_day_before = true WHERE id = $1', [r.id]); sent++;
    } else if (d === today && !r.reminded_today) {
      for (const s of who) await notify(s, `Today: ${r.title}`, `${names.get(r.account) ?? ''} · ${when}.`, r.id);
      await db().query('UPDATE content_posts SET reminded_today = true, reminded_day_before = true WHERE id = $1', [r.id]); sent++;
    }
  }
  return sent;
}

/**
 * "Time to post": at the scheduled time, posts that aren't auto-posted (private accounts, other platforms, or auto-post
 * off) remind the publishing owner — or the creator — to post it by hand and confirm it. Once per post.
 */
export async function remindTimeToPost(now = new Date()) {
  const rows = await db().query<any>(`SELECT id, title, account, platform, publisher_staff_id, assigned_staff_id FROM content_posts
     WHERE status IN ('approved','scheduled') AND NOT auto_post AND NOT reminded_due AND scheduled_at <= $1 AND scheduled_at > $1::timestamptz - interval '1 day'`, [now]);
  const names = new Map((await contentAccounts()).map((a) => [a.id, a.name]));
  for (const r of rows) {
    const who = r.publisher_staff_id ?? r.assigned_staff_id;
    if (who) await notify(who, r.platform === 'email' ? `Email due: ${r.title}` : `Time to post: ${r.title}`, r.platform === 'email' ? 'Check in Flodesk that it went out, then open it and confirm it as sent.' : `Post it on ${names.get(r.account) ?? r.platform} now, then open it and press Confirm published.`, r.id);
    await db().query('UPDATE content_posts SET reminded_due = true WHERE id = $1', [r.id]);
  }
  return rows.length;
}

const PARENT = 'P:';
/**
 * Instagram auto-posting: scheduled, auto-post posts that are due get their containers made (videos are processed
 * first), then published once ready. Only scheduled posts — so approval rules are already met. A problem marks the post
 * Failed with the reason and tells the people on it; nothing is retried on its own.
 */
export async function publishDueContent(now = new Date(), api = (slot: IgSlot) => { const a = instagramAccounts(config()).find((x) => x.slot === slot); return a ? new InstagramApi(a.accountId, a.token) : null; }) {
  const due = await db().query<any>(`SELECT * FROM content_posts WHERE auto_post AND platform = 'instagram' AND ((status = 'scheduled' AND scheduled_at <= $1) OR status = 'publishing') ORDER BY scheduled_at LIMIT 10`, [now]);
  let posted = 0;
  for (const r of due) {
    const ig = api(r.account);
    const fail = async (msg: string) => {
      await db().query("UPDATE content_posts SET status = 'failed', error = $2, updated_at = now() WHERE id = $1", [r.id, msg.slice(0, 500)]);
      await log(r.id, null, 'status', msg.slice(0, 500), r.status, 'failed');
      for (const s of new Set([r.assigned_staff_id, r.publisher_staff_id])) await notify(s, 'Post didn’t go out', `“${r.title}”: ${msg}`, r.id);
    };
    const priv = (await contentAccounts()).find((a) => a.id === r.account)?.privateAccount;
    if (!ig || priv) { await fail(priv ? 'This account is private — Instagram doesn’t let apps post to it. Post it by hand and confirm it as published.' : 'This account isn’t connected for auto-posting — post it by hand and confirm it as published.'); continue; }
    try {
      const media = await db().query<{ id: string; mime: string }>('SELECT id, mime FROM content_media WHERE id = ANY($1::uuid[])', [r.media_ids]);
      const ordered = (r.media_ids as string[]).map((id) => media.find((m) => m.id === id)).filter((m): m is { id: string; mime: string } => !!m);
      const problem = autoPostProblem({ platform: r.platform, type: r.post_type, scheduledAt: iso(r.scheduled_at), media: ordered }, true);
      if (problem) { await fail(problem); continue; }
      let ids: string[] = r.ig_container_ids ?? [];
      if (r.status === 'scheduled') {
        const urls = await Promise.all(ordered.map(async (m) => ({ url: await publicMediaUrl(m.id), video: m.mime.startsWith('video/') })));
        const caption = fullCaption(r);
        ids = r.post_type === 'carousel'
          ? await Promise.all(urls.map((u) => ig.container(u, { kind: 'carousel_item' })))
          : [await ig.container(urls[0], { kind: r.post_type, caption })];
        await db().query("UPDATE content_posts SET status = 'publishing', ig_container_ids = $2, updated_at = now() WHERE id = $1", [r.id, ids]);
      }
      const statuses = await Promise.all(ids.filter((x) => !x.startsWith(PARENT)).map((x) => ig.status(x)));
      if (statuses.some((s) => s === 'ERROR' || s === 'EXPIRED')) { await fail('Instagram couldn’t process the media (check the format and size).'); continue; }
      if (statuses.some((s) => s !== 'FINISHED')) continue;
      let final = ids[0];
      if (r.post_type === 'carousel') {
        const parent = ids.find((x) => x.startsWith(PARENT))?.slice(PARENT.length) ?? await ig.carousel(ids, fullCaption(r));
        if (!ids.some((x) => x.startsWith(PARENT))) await db().query('UPDATE content_posts SET ig_container_ids = $2 WHERE id = $1', [r.id, [...ids, `${PARENT}${parent}`]]);
        if ((await ig.status(parent)) !== 'FINISHED') continue;
        final = parent;
      }
      const out = await ig.publish(final);
      await db().query("UPDATE content_posts SET status = 'published', ig_media_id = $2, permalink = $3, posted_at = now(), error = NULL, updated_at = now() WHERE id = $1", [r.id, out.mediaId, out.permalink]);
      await log(r.id, null, 'status', 'Posted to Instagram', 'publishing', 'published');
      posted++;
    } catch (e) {
      await fail((e as { userMessage?: string }).userMessage ?? (e as Error).message);
    }
  }
  return posted;
}

/** Daily: imports Instagram numbers for posts it published in the last 30 days (manual numbers aren't overwritten). */
export async function importRecentMetrics() {
  const rows = await db().query<{ id: string }>(`SELECT id FROM content_posts WHERE status = 'published' AND ig_media_id IS NOT NULL AND posted_at > now() - interval '30 days'
     AND (metrics_source IS NULL OR metrics_source = 'imported') AND (metrics_updated_at IS NULL OR metrics_updated_at < now() - interval '20 hours')`);
  let n = 0;
  for (const r of rows) { try { await importMetrics(null, r.id); n++; } catch { /* next time */ } }
  return n;
}
