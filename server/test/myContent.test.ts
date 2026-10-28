import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { setup } from './helpers.js';

const MEDIA = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-media-'));
process.env.MEDIA_DIR = MEDIA;
let app: Awaited<ReturnType<typeof setup>>['app'];
const H = { 'X-Requested-With': 'addendum-crm' };
const jpeg = (seed: string) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`photo-${seed}-`.repeat(40)), Buffer.from([0xff, 0xd9])]);
const binary = (res: any, cb: any) => { const parts: Buffer[] = []; res.on('data', (c: Buffer) => parts.push(c)); res.on('end', () => cb(null, Buffer.concat(parts))); };
async function as(email: string) {
  const agent = request.agent(app);
  await agent.post('/api/auth/login').set(H).send({ email, password: 'addendum-demo' });
  return {
    get: (u: string) => agent.get(u), file: (u: string) => agent.get(u).buffer(true).parse(binary),
    post: (u: string, b: object = {}) => agent.post(u).set(H).send(b), patch: (u: string, b: object = {}) => agent.patch(u).set(H).send(b),
    put: (u: string, b: object = {}) => agent.put(u).set(H).send(b), del: (u: string) => agent.delete(u).set(H),
    upload: (u: string, bytes: Buffer) => agent.post(u).set(H).set('Content-Type', 'image/jpeg').send(bytes),
    raw: agent,
  };
}
let jen: Awaited<ReturnType<typeof as>>, mike: typeof jen, owner: typeof jen, desk: typeof jen;
beforeAll(async () => {
  ({ app } = await setup());
  jen = await as('jennifer@addendumsalon.com'); mike = await as('michael@addendumsalon.com'); owner = await as('owner@addendumsalon.com'); desk = await as('frontdesk@addendumsalon.com');
});
afterAll(() => fs.rmSync(MEDIA, { recursive: true, force: true }));

describe('My Content (a stylist’s own Instagram plan)', () => {
  it('plans posts and ideas, with photos (uploaded or from their transformations), only for themselves', async () => {
    const p = await jen.post('/api/my-content', { date: '2026-11-05', time: '18:30', format: 'reel', title: 'Copper melt', caption: 'Fall copper', hashtags: '#copper' });
    expect(p.status).toBe(201);
    expect(p.body.post).toMatchObject({ date: '2026-11-05', time: '18:30', format: 'reel', status: 'draft' });
    const idea = (await jen.post('/api/my-content', { title: 'Before/after of a K-tip install' })).body.post;
    expect([idea.date, idea.status]).toEqual([null, 'idea']);
    const list = (await jen.get('/api/my-content?from=2026-11-01&to=2026-11-30')).body.posts.map((x: any) => x.id);
    expect(list).toEqual(expect.arrayContaining([p.body.post.id, idea.id]));
    expect((await jen.get('/api/my-content?from=2026-12-01&to=2026-12-31')).body.posts.map((x: any) => x.id)).not.toContain(p.body.post.id);

    // Photos: an upload, and one of her transformation photos (linked, not copied).
    const up = await jen.upload(`/api/my-content/${p.body.post.id}/media`, jpeg('mc'));
    expect(up.status).toBe(201);
    expect((await jen.file(`/api/my-content/media/${up.body.mediaId}/original`)).body.equals(jpeg('mc'))).toBe(true);
    const t = (await jen.post('/api/transformations', { mainService: 'Haircut' })).body.transformation;
    const tp = (await jen.upload(`/api/transformations/${t.id}/photos?kind=after`, jpeg('tf'))).body.photoId;
    expect((await jen.get('/api/my-content/transformation-photos')).body.photos.map((x: any) => x.id)).toContain(tp);
    const linked = await jen.post(`/api/my-content/${p.body.post.id}/media/transformation`, { mediaId: tp });
    expect(linked.body.post.media.map((m: any) => m.fromTransformation)).toEqual([false, true]);
    const viaPost = linked.body.post.media[1].id;
    expect((await jen.file(`/api/my-content/media/${viaPost}/original`)).body.equals(jpeg('tf'))).toBe(true);
    // Someone else's transformation photo can't be attached.
    const mt = (await mike.post('/api/transformations', { mainService: 'Haircut' })).body.transformation;
    const mp = (await mike.upload(`/api/transformations/${mt.id}/photos?kind=after`, jpeg('mike'))).body.photoId;
    expect((await jen.post(`/api/my-content/${p.body.post.id}/media/transformation`, { mediaId: mp })).status).toBe(404);

    // Private: nobody else sees or changes it — administrators included.
    for (const other of [mike, owner]) {
      expect((await other.get('/api/my-content?from=2026-11-01&to=2026-11-30')).body.posts.map((x: any) => x.id)).not.toContain(p.body.post.id);
      expect((await other.get(`/api/my-content/${p.body.post.id}`)).status).toBe(404);
      expect((await other.patch(`/api/my-content/${p.body.post.id}`, { title: 'x' })).status).toBe(404);
      expect((await other.get(`/api/my-content/media/${up.body.mediaId}/original`)).status).toBe(404);
    }
    expect((await desk.get('/api/my-content?from=2026-11-01&to=2026-11-30')).status).toBe(403); // not given My Content

    // Mark posted, edit, remove a photo, delete.
    expect((await jen.patch(`/api/my-content/${p.body.post.id}`, { status: 'posted', date: '2026-11-06' })).body.post).toMatchObject({ status: 'posted', date: '2026-11-06' });
    expect((await jen.del(`/api/my-content/media/${up.body.mediaId}`)).body.post.media).toHaveLength(1);
    expect((await jen.del(`/api/my-content/${p.body.post.id}`)).status).toBe(200);
    expect((await jen.get(`/api/my-content/${p.body.post.id}`)).status).toBe(404);
    // The transformation photo itself is untouched.
    expect((await jen.file(`/api/transformations/media/${tp}/original`)).body.equals(jpeg('tf'))).toBe(true);
  });

  it('remembers their Instagram username', async () => {
    expect((await jen.put('/api/my-content/instagram', { handle: 'https://www.instagram.com/jenstyles/' })).body.instagram).toBe('jenstyles');
    expect((await jen.get('/api/my-content?from=2026-11-01&to=2026-11-30')).body.instagram).toBe('jenstyles');
    expect((await mike.get('/api/my-content?from=2026-11-01&to=2026-11-30')).body.instagram).toBeNull();
    expect((await jen.put('/api/my-content/instagram', { handle: 'not a name!' })).status).toBe(400);
  });

  it('salon downloads: posts and stories the salon shares, for every stylist to download', async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 1)]);
    const up = async (name: string) => (await (owner as any).raw.post('/api/content/media').set(H).set('content-type', 'image/png').set('x-file-name', name).send(png)).body.media;
    const a = await up('Fall promo.png');
    const b = await up('Story - holiday.png');
    const hidden = await up('Not shared.png');
    expect((await owner.patch(`/api/content/assets/${a.id}`, { stylistShare: 'post' })).status).toBe(200);
    await owner.patch(`/api/content/assets/${b.id}`, { stylistShare: 'story' });
    expect((await jen.patch(`/api/content/assets/${a.id}`, { stylistShare: null })).status).toBe(403); // stylists can't share or unshare
    const d = (await jen.get('/api/my-content/downloads')).body.downloads;
    expect(d.map((x: any) => [x.title, x.kind])).toEqual(expect.arrayContaining([['Fall promo', 'post'], ['Story - holiday', 'story']]));
    expect(d.map((x: any) => x.id)).not.toContain(hidden.id);
    const f = await jen.file(`/api/my-content/downloads/${a.id}?download`);
    expect([f.status, f.headers['content-disposition']]).toEqual([200, expect.stringContaining('attachment')]);
    expect((await jen.get(`/api/my-content/downloads/${hidden.id}`)).status).toBe(404); // only shared ones
    expect((await desk.get('/api/my-content/downloads')).status).toBe(403);
  });
});
