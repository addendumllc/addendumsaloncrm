import { addSharedLink, removeSharedLink, sharedLinks, updateSharedLink } from '../domain/myContent.js';
import express, { Router } from 'express';
import { z } from 'zod';
import { CONTENT_PLATFORMS, CONTENT_FORMATS } from '@addendum/shared';
import {
  accountsFor, addComment, analytics, campaignTimeline, companionBlog, createLaunch, crossPost, comments, contentAccounts, contentSettings, createPosts, deleteAsset, deleteCampaign, deleteIdea, deletePost, favoriteIdea, generate,
  getPost, importMetrics, keepIdea, suggestIdeas, linkOptions, listAssets, listCampaigns, listIdeas, listPosts, MEDIA_LIMITS, planning, readMedia, repurpose, reschedule, saveCampaign,
  saveContentAccounts, saveContentSettings, saveIdea, saveMedia, setMetrics, transition, updateAsset, updatePost,
  assetGroupZip, orderAssets,
} from '../domain/content.js';
import { can } from '../auth/permissions.js';
import { forbidden, notFound } from '../lib/errors.js';
import { ah, logAction, parse } from './util.js';

/** Content calendar — needs "Content calendar" (permissions.ts); approving and publishing need their own permissions (checked in the domain). */
export const contentRouter = Router();
const who = (req: express.Request) => req.user!;
const admin = (req: express.Request) => { if (!can(req.user, 'settings:write') && !can(req.user, '*')) throw forbidden('Only administrators can change content settings.'); };

const account = z.enum(['a1', 'a2', 'a3']);
const platform = z.enum(CONTENT_PLATFORMS.map((p) => p.value) as [string, ...string[]]);
const format = z.enum(CONTENT_FORMATS.map((f) => f.value) as [string, ...string[]]);
const status = z.enum(['idea', 'draft', 'in_review', 'changes_requested', 'approved', 'scheduled', 'published']);
const when = z.string().datetime({ offset: true }).nullable();
const text = (n: number) => z.string().max(n).nullable().default(null);

contentRouter.get('/accounts', ah(async (req, res) => res.json({ accounts: await contentAccounts(), mine: await accountsFor(who(req)) })));
contentRouter.put('/accounts', ah(async (req, res) => {
  admin(req);
  const b = parse(z.object({ accounts: z.array(z.object({ id: account, name: z.string().trim().min(1).max(60), handle: z.string().trim().max(60), color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    cta: z.string().trim().max(200).optional(), voice: z.string().trim().max(500).optional(), pillars: z.array(z.string().trim().min(1).max(80)).max(20).optional(), privateAccount: z.boolean().optional() })).max(3) }), req.body);
  res.json({ accounts: await saveContentAccounts(b.accounts as any) });
}));
contentRouter.get('/settings', ah(async (_req, res) => res.json({ settings: await contentSettings() })));
contentRouter.put('/settings', ah(async (req, res) => {
  admin(req);
  const b = parse(z.object({ requireApproval: z.boolean(), goals: z.record(account, z.record(platform, z.number().int().min(0).max(100))), access: z.record(account, z.array(z.string().uuid()).max(200)),
    emailAudiences: z.record(account, z.array(z.object({ id: z.string().max(100), name: z.string().max(200) })).max(20)).default({}) }), req.body);
  await logAction(req, 'content.settings', undefined, undefined, { requireApproval: b.requireApproval });
  res.json({ settings: await saveContentSettings(b as any) });
}));

const fields = z.object({
  platform: platform.default('instagram'), type: format.default('feed'), title: z.string().trim().min(1).max(200), scheduledAt: when.default(null), dueAt: when.default(null),
  headline: text(300), caption: z.string().max(10_000).default(''), cta: text(300), hashtags: text(1000), pillar: text(120), autoPost: z.boolean().default(false),
  mediaIds: z.array(z.string().uuid()).max(10).default([]), externalLinks: z.array(z.string().url().max(500)).max(10).default([]),
  link: z.object({ kind: z.enum(['product', 'service']), ref: z.string().min(1).max(200), label: z.string().max(200) }).nullable().default(null),
  campaignId: z.string().uuid().nullable().default(null), assignedStaffId: z.string().uuid().nullable().default(null), reviewerStaffId: z.string().uuid().nullable().default(null),
  publisherStaffId: z.string().uuid().nullable().default(null), notes: text(4000), ideaId: z.string().uuid().nullable().optional(),
  email: z.object({ subject: text(300), previewText: text(300), audience: z.array(z.object({ id: z.string().max(100), name: z.string().max(200) })).max(20).default([]),
    objective: text(300), destinationUrl: z.string().url().max(500).nullable().default(null), draftUrl: z.string().url().max(500).nullable().default(null), flodeskUrl: z.string().trim().max(500).nullable().default(null) }).nullable().optional(),
});
contentRouter.get('/posts', ah(async (req, res) => {
  const q = parse(z.object({ from: z.string().datetime({ offset: true }), to: z.string().datetime({ offset: true }) }), req.query);
  res.json({ posts: await listPosts(who(req), q.from, q.to) });
}));
contentRouter.get('/posts/:id', ah(async (req, res) => res.json({ post: await getPost(who(req), req.params.id), comments: await comments(who(req), req.params.id) })));
// One post per chosen account (each its own entry, linked by a group).
contentRouter.post('/posts', ah(async (req, res) => {
  const b = parse(fields.extend({ accounts: z.array(account).min(1).max(3), status: z.enum(['idea', 'draft']).default('draft'), schedules: z.record(account, when).default({}) }), req.body);
  const { accounts, status: st, schedules, ...f } = b;
  const posts = await createPosts(who(req), accounts as any, f as any, st, null, schedules as any);
  await logAction(req, 'content.create', 'content_post', posts[0].id, { accounts });
  res.status(201).json({ posts });
}));
contentRouter.put('/posts/:id', ah(async (req, res) => res.json({ post: await updatePost(who(req), req.params.id, parse(fields, req.body) as any) })));
contentRouter.post('/posts/:id/status', ah(async (req, res) => {
  const b = parse(z.object({ status, comment: text(2000) }), req.body);
  const post = await transition(who(req), req.params.id, b.status, b.comment);
  await logAction(req, 'content.status', 'content_post', post.id, { status: b.status });
  res.json({ post });
}));
contentRouter.post('/posts/:id/reschedule', ah(async (req, res) => res.json({ post: await reschedule(who(req), req.params.id, parse(z.object({ scheduledAt: when }), req.body).scheduledAt) })));
contentRouter.post('/posts/:id/comments', ah(async (req, res) => {
  await addComment(who(req), req.params.id, parse(z.object({ body: z.string().trim().min(1).max(2000) }), req.body).body);
  res.json({ comments: await comments(who(req), req.params.id) });
}));
contentRouter.post('/posts/:id/crosspost', ah(async (req, res) => {
  const b = parse(z.object({ targets: z.array(z.object({ account, scheduledAt: when })).min(1).max(2) }), req.body);
  res.status(201).json({ posts: await crossPost(who(req), req.params.id, b.targets as any) });
}));
contentRouter.post('/posts/:id/blog', ah(async (req, res) => res.status(201).json({ post: await companionBlog(who(req), req.params.id) })));
contentRouter.post('/posts/:id/repurpose', ah(async (req, res) => {
  const b = parse(z.object({ targets: z.array(z.object({ account, platform, type: format })).min(1).max(6) }), req.body);
  res.status(201).json({ posts: await repurpose(who(req), req.params.id, b.targets as any) });
}));
const metric = z.number().min(0).max(1e10).optional();
contentRouter.put('/posts/:id/metrics', ah(async (req, res) => {
  const m = parse(z.object({ reach: metric, impressions: metric, views: metric, likes: metric, comments: metric, saves: metric, shares: metric, clicks: metric, bookingInquiries: metric, productClicks: metric, salesCents: metric,
    recipients: metric, delivered: metric, opens: metric, unsubscribes: metric, bounces: metric }), req.body);
  res.json({ post: await setMetrics(who(req), req.params.id, m) });
}));
contentRouter.post('/posts/:id/metrics/import', ah(async (req, res) => { await importMetrics(who(req), req.params.id); res.json({ post: await getPost(who(req), req.params.id) }); }));
contentRouter.delete('/posts/:id', ah(async (req, res) => {
  await deletePost(who(req), req.params.id);
  await logAction(req, 'content.delete', 'content_post', req.params.id);
  res.json({ ok: true });
}));
contentRouter.get('/links', ah(async (req, res) => res.json({ options: await linkOptions(String(req.query.q ?? '')) })));

// AI drafts: always returned for editing — nothing is saved or posted.
contentRouter.post('/generate', ah(async (req, res) => {
  const b = parse(z.object({ account, platform, format, pillar: text(120), tone: text(120), objective: text(300), campaign: text(120), brief: text(4000), kind: text(40) }), req.body);
  await (async () => { if (!(await accountsFor(who(req))).includes(b.account as any)) throw forbidden('You don’t have access to that account.'); })();
  res.json({ draft: await generate(b as any) });
}));

contentRouter.get('/campaigns', ah(async (_req, res) => res.json({ campaigns: await listCampaigns() })));
const campaign = z.object({ id: z.string().uuid().optional(), name: z.string().trim().min(1).max(120), accounts: z.array(account).max(3).default([]), startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null), endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null), notes: text(2000) });
contentRouter.post('/campaigns', ah(async (req, res) => res.json({ campaigns: await saveCampaign(parse(campaign, req.body) as any) })));
// A product launch: its campaign plus promotion drafts around the release date (moved when the date changes).
contentRouter.post('/launches', ah(async (req, res) => {
  const b = parse(z.object({ product: z.string().trim().min(1).max(120), releaseOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null), accounts: z.array(account).min(1).max(3), notes: text(2000) }), req.body);
  const campaign = await createLaunch(who(req), b as any);
  await logAction(req, 'content.launch', 'content_campaign', campaign.id, { product: b.product, posts: campaign.posts });
  res.status(201).json({ campaign, campaigns: await listCampaigns() });
}));
contentRouter.get('/campaigns/:id/timeline', ah(async (req, res) => res.json(await campaignTimeline(who(req), req.params.id))));
// Flodesk segments (names only — never subscribers) for mapping accounts and choosing an email's audience.
contentRouter.get('/email/segments', ah(async (_req, res) => {
  const { config } = await import('../config.js');
  const key = config().FLODESK_API_KEY;
  if (!key) return res.json({ connected: false, segments: [] });
  const { FlodeskApi } = await import('../integrations/flodesk.js');
  try { res.json({ connected: true, segments: await new FlodeskApi(key).segments() }); }
  catch (e) { res.json({ connected: true, segments: [], error: (e as { userMessage?: string }).userMessage ?? (e as Error).message }); }
}));
contentRouter.delete('/campaigns/:id', ah(async (req, res) => res.json({ campaigns: await deleteCampaign(req.params.id) })));

contentRouter.get('/ideas', ah(async (req, res) => res.json({ ideas: await listIdeas(who(req)) })));
const idea = z.object({ id: z.string().uuid().optional(), accounts: z.array(account).min(1).max(3), title: z.string().trim().min(1).max(200), pillar: z.string().trim().min(1).max(120), audience: text(300),
  platform, format, hook: text(500), visual: text(1000), shotList: text(2000), caption: text(4000), cta: text(300), hashtags: text(1000), season: text(40), effort: z.enum(['low', 'medium', 'high']).default('medium'), alsoStory: z.boolean().default(false),
  subject: text(300), previewText: text(300), sendTiming: text(200) });
contentRouter.post('/ideas', ah(async (req, res) => res.json({ ideas: await saveIdea(who(req), parse(idea, req.body) as any) })));
contentRouter.delete('/ideas/:id', ah(async (req, res) => res.json({ ideas: await deleteIdea(who(req), req.params.id) })));
contentRouter.put('/ideas/:id/keep', ah(async (req, res) => res.json({ ideas: await keepIdea(who(req), req.params.id) })));
contentRouter.post('/ideas/suggest', ah(async (req, res) => {
  const b = parse(z.object({ accounts: z.array(account).max(3).optional(), count: z.number().int().min(1).max(8).default(4) }), req.body ?? {});
  const mine = await accountsFor(who(req));
  const added = await suggestIdeas((b.accounts?.length ? b.accounts : mine).filter((a) => mine.includes(a as any)) as any, b.count);
  res.json({ added, ideas: await listIdeas(who(req)) });
}));
contentRouter.put('/ideas/:id/favorite', ah(async (req, res) => { await favoriteIdea(who(req), req.params.id, parse(z.object({ on: z.boolean() }), req.body).on); res.json({ ok: true }); }));

contentRouter.get('/planning', ah(async (req, res) => res.json(await planning(who(req)))));
contentRouter.get('/analytics', ah(async (req, res) => {
  const q = parse(z.object({ from: z.string().datetime({ offset: true }), to: z.string().datetime({ offset: true }) }), req.query);
  res.json(await analytics(who(req), q.from, q.to));
}));

// Assets: uploads (the file as the body; photos up to 15 MB, videos up to 100 MB) and the library.
contentRouter.post('/media', express.raw({ type: () => true, limit: MEDIA_LIMITS.video + 1024 }), ah(async (req, res) => {
  const name = req.get('x-file-name') ? decodeURIComponent(req.get('x-file-name')!) : null;
  const acc = req.get('x-account') ?? null;
  res.status(201).json({ media: await saveMedia(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), req.get('content-type') ?? '', name, req.user!.id, acc) });
}));
contentRouter.get('/media/:id', ah(async (req, res) => {
  const m = await readMedia(req.params.id);
  if (!m) throw notFound('File not found');
  res.setHeader('Content-Type', m.mime);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  // ?download: saved under its title (or its file name).
  if ('download' in req.query) {
    const ext = m.name?.match(/\.[A-Za-z0-9]+$/)?.[0] ?? `.${m.mime.split('/')[1]?.replace('jpeg', 'jpg').replace('quicktime', 'mov') ?? 'bin'}`;
    res.attachment(m.title ? `${m.title.replace(/[^A-Za-z0-9 ._-]+/g, '').trim() || 'asset'}${ext}` : m.name ?? `asset${ext}`);
  }
  res.send(m.bytes);
}));
contentRouter.get('/assets', ah(async (req, res) => {
  const q = parse(z.object({ q: z.string().max(100).optional(), account: account.optional(), tag: z.string().max(60).optional(), approved: z.enum(['true', 'false']).optional() }), req.query);
  res.json({ assets: await listAssets(who(req), { ...q, approved: q.approved == null ? undefined : q.approved === 'true' }) });
}));
// Links as assets (Canva designs and templates…), organised like files; shared with stylists unless turned off.
const linkBody = z.object({ title: z.string().max(120).optional(), postType: z.enum(['post', 'story', 'reel', 'carousel']).nullable().optional(), group: z.string().max(80).nullable().optional(), stylists: z.boolean().optional() });
// A whole asset group as a ZIP (photos and videos, plus its links in Links.txt).
contentRouter.post('/assets/order', ah(async (req, res) => { await orderAssets(parse(z.object({ ids: z.array(z.string().uuid()).min(1).max(200) }), req.body).ids); res.json({ ok: true }); }));
contentRouter.get('/assets/group-download', ah(async (req, res) => {
  const z1 = await assetGroupZip(String(req.query.group ?? '').slice(0, 80));
  await logAction(req, 'content.asset_group_download', undefined, undefined, { group: req.query.group });
  res.setHeader('Cache-Control', 'no-store');
  res.attachment(z1.name);
  res.sendFile(z1.file, () => void z1.remove());
}));
contentRouter.get('/asset-links', ah(async (_req, res) => res.json({ links: await sharedLinks() })));
contentRouter.post('/asset-links', ah(async (req, res) => res.status(201).json({ links: await addSharedLink({ title: '', ...parse(linkBody.extend({ url: z.string().max(1000) }), req.body) }) })));
contentRouter.patch('/asset-links/:lid', ah(async (req, res) => res.json({ links: await updateSharedLink(req.params.lid, parse(linkBody, req.body)) })));
contentRouter.delete('/asset-links/:lid', ah(async (req, res) => res.json({ links: await removeSharedLink(req.params.lid) })));
contentRouter.patch('/assets/:id', ah(async (req, res) => {
  await updateAsset(who(req), req.params.id, parse(z.object({ title: text(200).optional(), tags: z.array(z.string().max(40)).max(30).optional(), account: account.nullable().optional(), approved: z.boolean().optional(), stylistShare: z.enum(['post', 'story']).nullable().optional(),
    postType: z.enum(['post', 'story', 'reel', 'carousel']).nullable().optional(), group: z.string().max(80).nullable().optional(), description: z.string().max(2000).nullable().optional() }), req.body) as any);
  res.json({ ok: true });
}));
contentRouter.delete('/assets/:id', ah(async (req, res) => { await deleteAsset(req.params.id); res.json({ ok: true }); }));
