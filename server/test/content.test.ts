import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { db } from '../src/db/index.js';
import { publicMediaUrl, publishDueContent, remindContent } from '../src/domain/content.js';
import { setup } from './helpers.js';

let api: Awaited<ReturnType<typeof setup>>['api'];
let app: any;
let agent: any;
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

beforeAll(async () => { ({ api, app, agent } = await setup()); });

const upload = async (mime = 'image/png', bytes = PNG) =>
  (await agent.post('/api/content/media').set('x-requested-with', 'addendum-crm').set('content-type', mime).set('x-file-name', 'a.png').send(bytes)).body.media;
const base = (over: object = {}) => ({ accounts: ['a1'], title: 'Balayage reveal', platform: 'instagram', type: 'feed', caption: 'Hello', status: 'draft', ...over });

describe('Content calendar', () => {
  it('has the three accounts, and one idea for several accounts makes separate linked posts', async () => {
    const acc = (await api.get('/api/content/accounts')).body.accounts;
    expect(acc.map((a: any) => a.name)).toEqual(['@addendum.salon', '@addendumhair', '@addendumhairpro']);
    expect(acc[0].cta).toMatch(/Book/);
    const r = await api.post('/api/content/posts', base({ accounts: ['a2', 'a3'], title: 'Heat shields' }));
    expect(r.status).toBe(201);
    expect(r.body.posts.map((p: any) => p.account)).toEqual(['a2', 'a3']);
    expect(r.body.posts[0].groupId).toBeTruthy();
    expect(r.body.posts[0].groupId).toBe(r.body.posts[1].groupId);
    // Each is edited on its own.
    const [a, b] = r.body.posts;
    await api.put(`/api/content/posts/${a.id}`, { ...a, caption: 'Only for @addendumhair', mediaIds: [], link: null });
    expect((await api.get(`/api/content/posts/${b.id}`)).body.post.caption).toBe('Hello');
  });

  it('workflow: review → changes requested → approved → scheduled → published by someone allowed, with history', async () => {
    const p = (await api.post('/api/content/posts', base({ scheduledAt: new Date(Date.now() + 86400_000).toISOString() }))).body.posts[0];
    // Approval required: can't schedule a draft.
    expect((await api.post(`/api/content/posts/${p.id}/status`, { status: 'scheduled' })).status).toBe(400);
    expect((await api.post(`/api/content/posts/${p.id}/status`, { status: 'in_review' })).status).toBe(200);
    expect((await api.post(`/api/content/posts/${p.id}/status`, { status: 'changes_requested' })).status).toBe(400); // needs a comment
    expect((await api.post(`/api/content/posts/${p.id}/status`, { status: 'changes_requested', comment: 'Shorter caption' })).status).toBe(200);
    await api.post(`/api/content/posts/${p.id}/status`, { status: 'in_review' });
    expect((await api.post(`/api/content/posts/${p.id}/status`, { status: 'approved' })).body.post.status).toBe('approved');
    expect((await api.post(`/api/content/posts/${p.id}/status`, { status: 'scheduled' })).body.post.status).toBe('scheduled');
    expect((await api.post(`/api/content/posts/${p.id}/status`, { status: 'published' })).body.post.status).toBe('published');
    const hist = (await api.get(`/api/content/posts/${p.id}`)).body.comments.filter((c: any) => c.kind === 'status').map((c: any) => c.toStatus);
    expect(hist).toEqual(['draft', 'in_review', 'changes_requested', 'in_review', 'approved', 'scheduled', 'published']);
  });

  it('editing approved copy keeps the old version and sends it back to review; repurposing makes a new linked draft', async () => {
    let p = (await api.post('/api/content/posts', base())).body.posts[0];
    for (const s of ['in_review', 'approved']) p = (await api.post(`/api/content/posts/${p.id}/status`, { status: s })).body.post;
    const after = (await api.put(`/api/content/posts/${p.id}`, { ...p, caption: 'New copy', mediaIds: [] })).body.post;
    expect(after).toMatchObject({ status: 'in_review', revision: 2 });
    const rev = (await api.get(`/api/content/posts/${p.id}`)).body.comments.find((c: any) => c.kind === 'revision');
    expect(JSON.parse(rev.body).caption).toBe('Hello');
    const copies = (await api.post(`/api/content/posts/${p.id}/repurpose`, { targets: [{ account: 'a3', platform: 'tiktok', type: 'video' }] })).body.posts;
    expect(copies[0]).toMatchObject({ account: 'a3', platform: 'tiktok', status: 'draft', sourcePostId: p.id });
    expect((await api.get(`/api/content/posts/${p.id}`)).body.post.caption).toBe('New copy'); // original untouched
  });

  it('ideas library is preloaded per account; AI drafts are returned for editing (built-in without a key)', async () => {
    const ideas = (await api.get('/api/content/ideas')).body.ideas;
    expect(ideas.length).toBeGreaterThan(20);
    for (const a of ['a1', 'a2', 'a3']) expect(ideas.some((i: any) => i.accounts.includes(a))).toBe(true);
    await api.put(`/api/content/ideas/${ideas[0].id}/favorite`, { on: true });
    expect((await api.get('/api/content/ideas')).body.ideas.find((i: any) => i.id === ideas[0].id).favorite).toBe(true);
    const d = (await api.post('/api/content/generate', { account: 'a3', platform: 'instagram', format: 'reel', pillar: 'Installation education' })).body.draft;
    expect(d.caption.length).toBeGreaterThan(10);
    expect(d.cta).toMatch(/Learn more|professional/i);
  });

  it('media for Instagram is public only with its signed link', async () => {
    const m = await upload();
    const url = new URL(await publicMediaUrl(m.id));
    expect((await request(app).get(url.pathname)).status).toBe(200);
    expect((await request(app).get(`/content-media/${m.id}/wrong-signature-wrong-signature0`)).status).toBe(404);
    expect((await request(app).get(`/api/content/media/${m.id}`)).status).toBe(401);
    expect((await agent.post('/api/content/media').set('x-requested-with', 'addendum-crm').set('content-type', 'application/pdf').send(Buffer.from('x'))).status).toBe(400);
  });

  it('auto-posting posts only scheduled posts when due (videos wait until processed), and marks them published', async () => {
    const m = await upload();
    const due = new Date(Date.now() - 60_000).toISOString();
    const id = (await db().one<any>(`INSERT INTO content_posts(account, platform, post_type, title, scheduled_at, caption, status, auto_post, media_ids) VALUES ('a2','instagram','feed','x',$1,'Hi','scheduled',true,$2::uuid[]) RETURNING id`, [due, [m.id]])).id;
    let ready = false;
    const fake = { container: async () => 'c1', carousel: async () => 'p1', status: async () => (ready ? 'FINISHED' : 'IN_PROGRESS'), publish: async () => ({ mediaId: 'm1', permalink: 'https://instagram.com/p/x' }) };
    expect(await publishDueContent(new Date(), () => fake as any)).toBe(0);
    ready = true;
    expect(await publishDueContent(new Date(), () => fake as any)).toBe(1);
    expect(await db().one<any>('SELECT status, permalink FROM content_posts WHERE id = $1', [id])).toEqual({ status: 'published', permalink: 'https://instagram.com/p/x' });
  });

  it('planning shows goals vs planned; analytics totals manual numbers and marks them manual', async () => {
    await api.put('/api/content/settings', { requireApproval: true, goals: { a1: { instagram: 3 } }, access: {} });
    const plan = (await api.get('/api/content/planning')).body;
    expect(plan.weeks[0].accounts.find((a: any) => a.account === 'a1').platforms.find((p: any) => p.platform === 'instagram').goal).toBe(3);
    const p = (await api.post('/api/content/posts', base({ scheduledAt: new Date().toISOString() }))).body.posts[0];
    for (const s of ['in_review', 'approved', 'published']) await api.post(`/api/content/posts/${p.id}/status`, { status: s });
    await api.put(`/api/content/posts/${p.id}/metrics`, { reach: 1000, likes: 50, saves: 10 });
    const a = (await api.get(`/api/content/analytics?from=${encodeURIComponent(new Date(Date.now() - 7 * 86400_000).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 86400_000).toISOString())}`)).body;
    expect(a.totals.reach).toBeGreaterThanOrEqual(1000);
    expect(a.manual).toBeGreaterThanOrEqual(1);
    await remindContent();
  });

  it('cross-posts to other accounts on different days, linked to the original, with each account’s CTA', async () => {
    const day = (n: number) => new Date(Date.now() + n * 86400_000).toISOString();
    const src = (await api.post('/api/content/posts', base({ accounts: ['a2'], title: 'Bond Applicator demo', scheduledAt: day(1), cta: 'Shop the collection' }))).body.posts[0];
    const copies = (await api.post(`/api/content/posts/${src.id}/crosspost`, { targets: [{ account: 'a3', scheduledAt: day(3) }, { account: 'a1', scheduledAt: day(5) }] })).body.posts;
    expect(copies.map((p: any) => p.account)).toEqual(['a3', 'a1']);
    expect(new Set([src.scheduledAt, ...copies.map((p: any) => p.scheduledAt)]).size).toBe(3); // three different days
    const orig = (await api.get(`/api/content/posts/${src.id}`)).body.post;
    expect(copies.every((p: any) => p.groupId === orig.groupId && p.sourcePostId === src.id && p.status === 'draft')).toBe(true);
    expect(copies[0].cta).toMatch(/Learn more|professional/i);
    // A new post for several accounts can give each its own day too.
    const multi = (await api.post('/api/content/posts', base({ accounts: ['a1', 'a2'], schedules: { a1: day(2), a2: day(4) } }))).body.posts;
    expect(multi[0].scheduledAt).not.toBe(multi[1].scheduledAt);
  });

  it('drafts new ideas each week as suggestions (kept only when saved); Reel ideas can work as Stories', async () => {
    const { maybeSuggestWeekly } = await import('../src/domain/content.js');
    const n = await maybeSuggestWeekly(new Date());
    expect(n).toBeGreaterThan(0);
    expect(await maybeSuggestWeekly(new Date())).toBe(0); // once a week
    let ideas = (await api.get('/api/content/ideas')).body.ideas;
    const fresh = ideas.filter((i: any) => i.suggested);
    expect(fresh.length).toBeGreaterThan(0);
    for (const a of ['a1', 'a2', 'a3']) expect(fresh.some((i: any) => i.accounts.includes(a))).toBe(true);
    ideas = (await api.put(`/api/content/ideas/${fresh[0].id}/keep`)).body.ideas;
    expect(ideas.find((i: any) => i.id === fresh[0].id).suggested).toBe(false);
    // Next week the unsaved ones are replaced; the saved one stays.
    await maybeSuggestWeekly(new Date(Date.now() + 8 * 86400_000));
    ideas = (await api.get('/api/content/ideas')).body.ideas;
    expect(ideas.some((i: any) => i.id === fresh[0].id)).toBe(true);
    expect(ideas.some((i: any) => i.id === fresh[1]?.id)).toBe(false);
    expect(ideas.filter((i: any) => i.alsoStory && i.format === 'reel').length).toBeGreaterThan(5);
    expect(ideas.filter((i: any) => !i.suggested && i.accounts.includes('a2')).length).toBeGreaterThan(20);
  });

  it('@addendumhairpro is private: no auto-posting, but ideas, cross-posting and a “Time to post” reminder', async () => {
    const acc = (await api.get('/api/content/accounts')).body.accounts;
    expect(acc.find((a: any) => a.id === 'a3')).toMatchObject({ privateAccount: true, connected: false });
    expect((await api.get('/api/content/ideas')).body.ideas.some((i: any) => i.accounts.includes('a3'))).toBe(true);
    const staff = (await db().one<any>('SELECT id FROM staff WHERE active LIMIT 1')).id;
    const src = (await api.post('/api/content/posts', base({ accounts: ['a2'], title: 'Pro install tip', publisherStaffId: staff }))).body.posts[0];
    const [pro] = (await api.post(`/api/content/posts/${src.id}/crosspost`, { targets: [{ account: 'a3', scheduledAt: new Date(Date.now() - 60_000).toISOString() }] })).body.posts;
    expect(pro.account).toBe('a3');
    expect((await api.put(`/api/content/posts/${pro.id}`, { ...pro, autoPost: true, mediaIds: [] })).status).toBe(400); // can't auto-post a private account
    for (const st of ['in_review', 'approved', 'scheduled']) await api.post(`/api/content/posts/${pro.id}/status`, { status: st });
    const { remindTimeToPost } = await import('../src/domain/content.js');
    expect(await remindTimeToPost()).toBeGreaterThanOrEqual(1);
    expect((await db().query<any>("SELECT 1 FROM notifications WHERE staff_id = $1 AND title LIKE 'Time to post%' AND link LIKE $2", [staff, `%${pro.id}`])).length).toBe(1);
    expect(await remindTimeToPost()).toBe(0); // once
  });

  it('a product launch drafts the promotion; posts wait without a date, then move with the release date', async () => {
    const r = await api.post('/api/content/launches', { product: 'The Bond – Keratin Application Tool Pro', releaseOn: null, accounts: ['a2', 'a3'] });
    expect(r.status).toBe(201);
    const c = r.body.campaign;
    expect(c).toMatchObject({ kind: 'launch', product: 'The Bond – Keratin Application Tool Pro', posts: 15, startsOn: null });
    const all = async () => (await db().query<any>('SELECT id, account, title, scheduled_at, launch_offset, status FROM content_posts WHERE campaign_id = $1 ORDER BY launch_offset', [c.id]));
    let posts = await all();
    expect(posts.every((p: any) => p.scheduled_at === null)).toBe(true);
    expect(posts.some((p: any) => p.title.includes('The Bond'))).toBe(true);
    // Release date set: each post at release + its offset.
    await api.post('/api/content/campaigns', { id: c.id, name: c.name, accounts: c.accounts, startsOn: '2026-12-01', endsOn: null, notes: null });
    posts = await all();
    const day = (p: any) => new Date(p.scheduled_at).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    expect(day(posts.find((p: any) => p.launch_offset === -14))).toBe('2026-11-17');
    expect(day(posts.find((p: any) => p.launch_offset === 0))).toBe('2026-12-01');
    // One already published stays put when the date moves.
    const pub = posts.find((p: any) => p.launch_offset === -14);
    await db().query("UPDATE content_posts SET status = 'published' WHERE id = $1", [pub.id]);
    await api.post('/api/content/campaigns', { id: c.id, name: c.name, accounts: c.accounts, startsOn: '2026-12-08', endsOn: null, notes: null });
    posts = await all();
    expect(day(posts.find((p: any) => p.id === pub.id))).toBe('2026-11-17');
    expect(day(posts.find((p: any) => p.launch_offset === 0))).toBe('2026-12-08');
  });
});
