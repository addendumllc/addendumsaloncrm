import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { db } from '../src/db/index.js';
import { setup } from './helpers.js';

let api: Awaited<ReturnType<typeof setup>>['api'];
let app: any;
let agent: any;
const H = { 'X-Requested-With': 'addendum-crm' };
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const base = (over: object = {}) => ({ accounts: ['a1'], title: 'Post', platform: 'instagram', type: 'feed', caption: 'Hello', status: 'draft', ...over });
const day = (n: number) => new Date(Date.now() + n * 86400_000).toISOString();
beforeAll(async () => { ({ api, app, agent } = await setup()); });

describe('Content Calendar sharing with creators', () => {
  it('a share link shows only shared posts — approved (or set to always), never drafts — read-only with notes', async () => {
    const media = (await agent.post('/api/content/media').set(H).set('content-type', 'image/png').set('x-file-name', 'a.png').send(PNG)).body.media;
    const mk = async (title: string, over: object = {}) => (await api.post('/api/content/posts', base({ title, scheduledAt: day(3), ...over }))).body.posts[0];
    const approve = async (p: any) => { for (const s of ['in_review', 'approved']) p = (await api.post(`/api/content/posts/${p.id}/status`, { status: s })).body.post; return p; };
    const draft = await mk('Unfinished draft');
    const approved = await approve(await mk('Approved post', { mediaIds: [media.id] }));
    const alwaysDraft = await mk('Draft to share');
    const neverApproved = await approve(await mk('Approved but private'));
    const proPost = await approve(await mk('Pro only', { accounts: ['a3'] }));
    expect(approved.sharedWithCreators).toBe(true);
    expect(draft.sharedWithCreators).toBe(false);
    expect((await api.put(`/api/content/posts/${alwaysDraft.id}/creator-share`, { mode: 'yes' })).body.post.sharedWithCreators).toBe(true);
    expect((await api.put(`/api/content/posts/${neverApproved.id}/creator-share`, { mode: 'no' })).body.post.sharedWithCreators).toBe(false);

    // A link for the salon's account only.
    const links = (await api.post('/api/content/share-links', { name: 'Maya', accounts: ['a1'] })).body.links;
    const link = links[0];
    expect(link.url).toMatch(/\/share\/[A-Za-z0-9_-]{20,}$/);
    const token = link.url.split('/share/')[1];
    const pub = request(app);
    const r = await pub.get(`/api/public/share/${token}`); // no sign-in
    expect(r.status).toBe(200);
    const titles = r.body.posts.map((p: any) => p.title);
    expect(titles).toEqual(expect.arrayContaining(['Approved post', 'Draft to share']));
    for (const t of ['Unfinished draft', 'Approved but private', 'Pro only']) expect(titles).not.toContain(t);
    const ap = r.body.posts.find((p: any) => p.title === 'Approved post');
    expect(ap).toMatchObject({ account: '@addendum.salon', status: 'Approved', caption: 'Hello' });
    expect(ap.media[0].url).toMatch(/\/content-media\//); // signed, downloadable without signing in
    expect((await pub.get(new URL(ap.media[0].url).pathname)).status).toBe(200);
    expect(ap.assignedStaffId).toBeUndefined(); // nothing internal

    // Notes: a creator's note lands in the post's comments; they can't note on a post that isn't shared.
    const n = await pub.post(`/api/public/share/${token}/notes`).set(H).send({ postId: approved.id, body: 'Can we use the second photo?' });
    expect(n.status).toBe(200);
    expect(n.body.posts.find((p: any) => p.id === approved.id).notes[0]).toMatchObject({ who: 'Maya (creator)', creator: true });
    expect((await api.get(`/api/content/posts/${approved.id}`)).body.comments.some((c: any) => c.body === 'Can we use the second photo?' && c.staffName === 'Maya (creator)')).toBe(true);
    expect((await pub.post(`/api/public/share/${token}/notes`).set(H).send({ postId: draft.id, body: 'x' })).status).toBe(404);
    expect((await pub.post(`/api/public/share/${token}/notes`).set(H).send({ postId: proPost.id, body: 'x' })).status).toBe(404);

    // Turned off, expired or made up: gone.
    await api.patch(`/api/content/share-links/${link.id}`, { active: false });
    expect((await pub.get(`/api/public/share/${token}`)).status).toBe(404);
    await api.patch(`/api/content/share-links/${link.id}`, { active: true, expiresOn: '2020-01-01' });
    expect((await pub.get(`/api/public/share/${token}`)).status).toBe(404);
    expect((await pub.get('/api/public/share/not-a-real-token-at-all')).status).toBe(404);
    // Only people who manage the Content Calendar make links.
    const jen = request.agent(app);
    await jen.post('/api/auth/login').set(H).send({ email: 'jennifer@addendumsalon.com', password: 'addendum-demo' });
    expect((await jen.post('/api/content/share-links').set(H).send({ name: 'x' })).status).toBe(403);
    expect((await db().one<any>('SELECT count(*)::int AS n FROM content_share_links')).n).toBe(1);
  });
});
