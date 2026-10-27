import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { runSquareSync } from '../src/domain/squareSync.js';
import { setup } from './helpers.js';

let api: Awaited<ReturnType<typeof setup>>['api'];
let app: any;

beforeAll(async () => {
  ({ api, app } = await setup());
  await runSquareSync({ full: false });
});

describe('Stylists’ booking pages', () => {
  it('lists each bookable stylist by first name, and each page links their services to Square’s booking site', async () => {
    const links = (await api.get('/api/settings/booking-links')).body.links;
    expect(links.length).toBeGreaterThan(0);
    const l = links.find((x: any) => x.services > 0);
    expect(l.slug).toBe(l.firstName.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
    const index = await request(app).get('/book');
    expect(index.status).toBe(200);
    expect(index.text).toContain(`/book/${l.slug}`);
    // A stylist's link goes straight to Square with them chosen.
    const page = await request(app).get(`/book/${l.slug}`);
    expect(page.status).toBe(302);
    expect(page.headers.location).toMatch(/^https:\/\/book\.squareup\.com\/appointments\/oerwtgecartjiw\/location\/LE47CFZ0ED4X1\/services\?.*team_member_id=/);
    expect(index.text).not.toMatch(/@|\+1\d{10}/); // no emails or phone numbers
    expect((await request(app).get('/book/nobody-here')).status).toBe(302);
  });
});
