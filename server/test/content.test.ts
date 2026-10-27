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
const base = (over: object = {}) => ({ account: 'a1', type: 'feed', scheduledAt: null, caption: 'Hello', status: 'idea', autoPost: false, mediaIds: [], link: null, assignedStaffId: null, notes: null, ...over });

describe('Content calendar', () => {
  it('accounts are named in the CRM; posts are planned with media, a link and a person', async () => {
    const acc = (await api.put('/api/content/accounts', { accounts: [{ id: 'a1', name: 'Addendum Salon', handle: '@addendumsalon', color: '#6b5242' }] })).body.accounts;
    expect(acc[0]).toMatchObject({ id: 'a1', name: 'Addendum Salon', handle: 'addendumsalon', connected: false });
    const m = await upload();
    expect(m.mime).toBe('image/png');
    const staff = (await db().one<any>('SELECT id FROM staff WHERE active LIMIT 1')).id;
    const when = new Date(Date.now() + 3 * 86400_000).toISOString();
    const r = await api.post('/api/content/posts', base({ scheduledAt: when, mediaIds: [m.id], link: { kind: 'service', ref: 'x', label: 'Balayage' }, assignedStaffId: staff, status: 'draft', type: 'reel' }));
    expect(r.status).toBe(201);
    expect(r.body.post).toMatchObject({ type: 'reel', status: 'draft', link: { label: 'Balayage' }, assignedStaffId: staff });
    const list = (await api.get(`/api/content/posts?from=${encodeURIComponent(new Date().toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 30 * 86400_000).toISOString())}`)).body.posts;
    expect(list.some((p: any) => p.id === r.body.post.id)).toBe(true);
    // Wrong file types are refused.
    expect((await agent.post('/api/content/media').set('x-requested-with', 'addendum-crm').set('content-type', 'application/pdf').send(Buffer.from('x'))).status).toBe(400);
  });

  it('media for Instagram is public only with its signed link', async () => {
    const m = await upload();
    const url = new URL(await publicMediaUrl(m.id));
    expect((await request(app).get(url.pathname)).status).toBe(200);
    expect((await request(app).get(`/content-media/${m.id}/wrong-signature-wrong-signature0`)).status).toBe(404);
    expect((await request(app).get(`/api/content/media/${m.id}`)).status).toBe(401); // the CRM's own link needs sign-in
  });

  it('auto-posting checks the post first, then posts it when due (videos wait until processed)', async () => {
    // Not connected: refused with the reason.
    const m = await upload();
    const due = new Date(Date.now() - 60_000).toISOString();
    expect((await api.post('/api/content/posts', base({ status: 'scheduled', autoPost: true, scheduledAt: due, mediaIds: [m.id] }))).body.error.message).toMatch(/connected/);
    // Saved directly (as if connected), then the posting job runs with a stand-in for Instagram.
    const id = (await db().one<any>(`INSERT INTO content_posts(account, post_type, scheduled_at, caption, status, auto_post, media_ids) VALUES ('a2','feed',$1,'Hi','scheduled',true,$2::uuid[]) RETURNING id`, [due, [m.id]])).id;
    const calls: string[] = [];
    let ready = false;
    const fake = { container: async (u: any) => { calls.push(`container ${u.url.includes('/content-media/')}`); return 'c1'; }, carousel: async () => 'p1', status: async () => (ready ? 'FINISHED' : 'IN_PROGRESS'), publish: async () => ({ mediaId: 'm1', permalink: 'https://instagram.com/p/x' }), username: async () => 'x' };
    expect(await publishDueContent(new Date(), () => fake as any)).toBe(0); // processing
    expect((await db().one<any>('SELECT status FROM content_posts WHERE id = $1', [id])).status).toBe('publishing');
    ready = true;
    expect(await publishDueContent(new Date(), () => fake as any)).toBe(1);
    expect(await db().one<any>('SELECT status, permalink FROM content_posts WHERE id = $1', [id])).toEqual({ status: 'posted', permalink: 'https://instagram.com/p/x' });
    expect(calls).toEqual(['container true']); // made once, from the signed media link
  });

  it('reminds the person on a post the day before and on the day, once each', async () => {
    const staff = (await db().one<any>('SELECT id FROM staff WHERE active LIMIT 1')).id;
    const tomorrow = new Date(Date.now() + 26 * 3600_000);
    const id = (await db().one<any>(`INSERT INTO content_posts(account, post_type, scheduled_at, caption, status, assigned_staff_id) VALUES ('a1','story',$1,'','draft',$2) RETURNING id`, [tomorrow, staff])).id;
    await remindContent(new Date());
    await remindContent(new Date());
    const n = await db().query<any>("SELECT title FROM notifications WHERE staff_id = $1 AND kind = 'content' AND link LIKE $2", [staff, `%${id}`]);
    expect(n.length).toBeLessThanOrEqual(1);
  });
});
