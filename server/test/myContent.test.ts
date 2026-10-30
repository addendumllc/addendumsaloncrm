import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { setup } from './helpers.js';
import { db } from '../src/db/index.js';

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
    expect(hidden.stylistShare).toBe('post'); // shared with stylists by default…
    await owner.patch(`/api/content/assets/${hidden.id}`, { stylistShare: null }); // …unless turned off
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

  it('shows the Content Calendar’s saved Instagram ideas for the salon (not suggestions, emails or other accounts)', async () => {
    const { db } = await import('../src/db/index.js');
    const add = (title: string, extra: string, args: unknown[] = []) => db().query(`INSERT INTO content_ideas(title, pillar, platform, format, accounts, status, caption, hashtags${extra ? ', ' + extra.split('=')[0] : ''}) VALUES ($1,'Education',$2,$3,$4,$5,'A caption','#tag'${extra ? ', $6' : ''})`, [title, ...args]);
    await add('Salon reel idea', '', ['instagram', 'reel', ['a1'], 'library']);
    await add('Everyone idea', '', ['instagram', 'feed', [], 'library']);
    await add('Pro-only idea', '', ['instagram', 'feed', ['a3'], 'library']);
    await add('Unsaved suggestion', '', ['instagram', 'feed', ['a1'], 'suggested']);
    await add('Email idea', '', ['email', 'feed', ['a1'], 'library']);
    const ideas = (await jen.get('/api/my-content/ideas')).body.ideas;
    const titles = ideas.map((i: any) => i.title);
    expect(titles).toEqual(expect.arrayContaining(['Salon reel idea', 'Everyone idea']));
    for (const t of ['Pro-only idea', 'Unsaved suggestion', 'Email idea']) expect(titles).not.toContain(t);
    expect(ideas.find((i: any) => i.title === 'Everyone idea').format).toBe('post');
    expect((await desk.get('/api/my-content/ideas')).status).toBe(403);
  });

  it('Canva links the salon shares: added and removed by Content Calendar managers, seen by stylists', async () => {
    expect((await jen.post('/api/my-content/links', { title: 'x', url: 'https://www.canva.com/design/abc/view', kind: 'story' })).status).toBe(403);
    expect((await owner.post('/api/my-content/links', { title: 'x', url: 'javascript:alert(1)' })).status).toBe(400);
    const r = await owner.post('/api/my-content/links', { title: 'Holiday stories', url: 'https://www.canva.com/design/DAF123/view?utm_content=x', kind: 'story' });
    expect(r.status).toBe(201);
    const links = (await jen.get('/api/my-content/links')).body.links;
    expect(links[0]).toMatchObject({ title: 'Holiday stories', kind: 'story', url: 'https://www.canva.com/design/DAF123/view?utm_content=x' });
    expect((await jen.del(`/api/my-content/links/${links[0].id}`)).status).toBe(403);
    expect((await owner.del(`/api/my-content/links/${links[0].id}`)).body.links).toEqual([]);
  });

  it('assets by type of post and group; Canva links kept with the assets; a whole group downloads as a ZIP', async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(80, 2)]);
    const up = async (name: string) => (await (owner as any).raw.post('/api/content/media').set(H).set('content-type', 'image/png').set('x-file-name', name).send(png)).body.media;
    const a = await up('Slide 1.png'), b = await up('Slide 2.png');
    for (const m of [a, b]) expect((await owner.patch(`/api/content/assets/${m.id}`, { postType: 'carousel', group: 'Holiday 2026', stylistShare: 'post' })).status).toBe(200);
    const assets = (await owner.get('/api/content/assets')).body.assets.filter((m: any) => m.group === 'Holiday 2026');
    expect(assets.map((m: any) => m.postType)).toEqual(['carousel', 'carousel']);
    // A Canva link with the assets, shared with stylists; one kept for the salon only.
    await owner.post('/api/content/asset-links', { url: 'https://www.canva.com/design/HOL/view', title: 'Holiday story template', postType: 'story', group: 'Holiday 2026' });
    await owner.post('/api/content/asset-links', { url: 'https://www.canva.com/design/INT/view', title: 'Internal only', group: 'Holiday 2026', stylists: false });
    expect((await jen.get('/api/content/asset-links')).status).toBe(403); // Content Calendar only
    const forStylists = (await jen.get('/api/my-content/links')).body.links.map((l: any) => [l.title, l.kind]);
    expect(forStylists).toContainEqual(['Holiday story template', 'story']);
    expect(forStylists.map((x: any) => x[0])).not.toContain('Internal only');
    expect((await jen.get('/api/my-content/salon-posts')).body.posts.find((p: any) => p.name === 'Holiday 2026').files).toHaveLength(2);
    // The group as a ZIP: both files and the links.
    const zip = await owner.file(`/api/content/assets/group-download?group=${encodeURIComponent('Holiday 2026')}`);
    expect(zip.status).toBe(200);
    const text = zip.body.toString('latin1');
    expect(text).toContain('Holiday_2026/01_Slide_1.png');
    expect(text).toContain('Holiday_2026/02_Slide_2.png');
    expect(text).toContain('https://www.canva.com/design/HOL/view');
    expect((await jen.get(`/api/content/assets/group-download?group=x`)).status).toBe(403);
  });

  it('Plan a post from a transformation (its photos linked), and ideas shared with the team (text only)', async () => {
    const t = (await jen.post('/api/transformations', { mainService: 'Balayage / lightening' })).body.transformation;
    await jen.upload(`/api/transformations/${t.id}/photos?kind=after`, jpeg('p1'));
    await jen.upload(`/api/transformations/${t.id}/photos?kind=after`, jpeg('p2'));
    const p = await jen.post('/api/my-content/from-transformation', { transformationId: t.id });
    expect(p.status).toBe(201);
    expect(p.body.post).toMatchObject({ format: 'carousel', status: 'idea' });
    expect(p.body.post.media.map((m: any) => m.fromTransformation)).toEqual([true, true]);
    expect((await mike.post('/api/my-content/from-transformation', { transformationId: t.id })).status).toBe(404); // not his
    // Share it as an idea: others see the text, not the photos; turning it off hides it again.
    await jen.patch(`/api/my-content/${p.body.post.id}`, { caption: 'Sun-kissed', sharedWithTeam: true });
    const seen = (await mike.get('/api/my-content/team-ideas')).body.ideas.find((i: any) => i.id === p.body.post.id);
    expect(seen).toMatchObject({ caption: 'Sun-kissed', author: 'Jennifer', mine: false });
    expect(seen.media).toBeUndefined();
    expect((await mike.get(`/api/my-content/${p.body.post.id}`)).status).toBe(404); // the post itself stays private
    await jen.patch(`/api/my-content/${p.body.post.id}`, { sharedWithTeam: false });
    expect((await mike.get('/api/my-content/team-ideas')).body.ideas.map((i: any) => i.id)).not.toContain(p.body.post.id);
  });

  it('a carousel downloads in the order set (admins and stylists), with descriptions; single files download with their title', async () => {
    const png = (n: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(60, n)]);
    const up = async (name: string, n: number) => (await (owner as any).raw.post('/api/content/media').set(H).set('content-type', 'image/png').set('x-file-name', name).send(png(n))).body.media;
    const [a, b, c] = [await up('First.png', 3), await up('Second.png', 4), await up('Third.png', 5)];
    for (const m of [a, b, c]) await owner.patch(`/api/content/assets/${m.id}`, { group: 'Spring carousel', postType: 'carousel', stylistShare: 'post', description: `Slide ${m.title}` });
    // Order: Third, First, Second.
    expect((await owner.post('/api/content/assets/order', { ids: [c.id, a.id, b.id] })).status).toBe(200);
    const listed = (await owner.get('/api/content/assets')).body.assets.filter((m: any) => m.group === 'Spring carousel');
    expect(listed.map((m: any) => [m.title, m.position, m.description])).toEqual([['Third', 1, 'Slide Third'], ['First', 2, 'Slide First'], ['Second', 3, 'Slide Second']]);
    const zip = (await owner.file(`/api/content/assets/group-download?group=${encodeURIComponent('Spring carousel')}`)).body.toString('latin1');
    expect(zip.indexOf('01_Third.png')).toBeGreaterThan(-1);
    expect(zip.indexOf('01_Third.png')).toBeLessThan(zip.indexOf('02_First.png'));
    expect(zip.indexOf('02_First.png')).toBeLessThan(zip.indexOf('03_Second.png'));
    const forJen = (await jen.file(`/api/my-content/downloads/group?group=${encodeURIComponent('Spring carousel')}`)).body.toString('latin1');
    expect(forJen).toContain('01_Third.png');
    const post = (await jen.get('/api/my-content/salon-posts')).body.posts.find((p: any) => p.name === 'Spring carousel');
    expect(post.files.map((f: any) => f.id)).toEqual([c.id, a.id, b.id]);
    // A ready-made post: its caption travels with the download, and Plan this post puts it in her plan with the photos.
    await owner.put('/api/content/asset-sets', { name: 'Spring carousel', caption: 'Spring is here', hashtags: '#spring', notes: 'Post on a Friday' });
    expect((await jen.get('/api/my-content/salon-posts')).body.posts.find((p: any) => p.name === 'Spring carousel')).toMatchObject({ caption: 'Spring is here', hashtags: '#spring', notes: 'Post on a Friday' });
    expect((await jen.file(`/api/my-content/downloads/group?group=${encodeURIComponent('Spring carousel')}`)).body.toString('latin1')).toContain('Caption.txt');
    const planned = await jen.post('/api/my-content/salon-posts/plan', { name: 'Spring carousel' });
    expect(planned.status).toBe(201);
    expect(planned.body.post).toMatchObject({ format: 'carousel', caption: 'Spring is here', hashtags: '#spring' });
    expect(planned.body.post.media).toHaveLength(3);
    expect((await jen.file(planned.body.post.media[0].originalUrl)).body.equals(png(5))).toBe(true); // Third first
    // Renaming the set keeps its photos and caption together.
    expect((await owner.post('/api/content/asset-sets/rename', { from: 'Spring carousel', to: 'Spring 2027' })).status).toBe(200);
    expect((await owner.get(`/api/content/asset-sets?name=${encodeURIComponent('Spring 2027')}`)).body.set.caption).toBe('Spring is here');
    expect((await jen.put('/api/content/asset-sets', { name: 'x', caption: 'y' })).status).toBe(403);
    const one = await owner.file(`/api/content/media/${a.id}?download`);
    expect(one.headers['content-disposition']).toContain('First.png');
    // Deleting a set: stylists can't; keeping the photos ungroups them; the photos-too delete removes them.
    expect((await jen.del(`/api/content/asset-sets?name=${encodeURIComponent('Spring 2027')}`)).status).toBe(403);
    expect((await owner.del(`/api/content/asset-sets?name=${encodeURIComponent('Spring 2027')}&photos=0`)).status).toBe(200);
    expect((await owner.get(`/api/content/asset-sets?name=${encodeURIComponent('Spring 2027')}`)).body.set.caption).toBeNull();
    const kept = await db().query<any>('SELECT group_name FROM content_media WHERE id = ANY($1)', [[a.id, b.id, c.id]]);
    expect(kept.map((r) => r.group_name)).toEqual([null, null, null]);
    await db().query("UPDATE content_media SET group_name = 'Gone' WHERE id = ANY($1)", [[a.id, b.id]]);
    expect((await owner.del('/api/content/asset-sets?name=Gone&photos=1')).status).toBe(200);
    expect(await db().query('SELECT 1 FROM content_media WHERE id = ANY($1)', [[a.id, b.id]])).toHaveLength(0);
  });
});
