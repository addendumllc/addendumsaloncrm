import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/index.js';
import { check, generateStudio } from '../src/domain/contentStudio.js';
import { setIntegrationOverride } from '../src/integrations/registry.js';
import { setup } from './helpers.js';

let api: Awaited<ReturnType<typeof setup>>['api'];
const sms = (body: string) => JSON.stringify({ format: 'SMS', service: 'Hair Botox', blocks: [{ number: 1, role: 'sms', body }] });
const story = (n: number, extra = '') => JSON.stringify({ format: 'Instagram Story', service: 'Milbon Treatment', blocks: [
  { number: 1, role: 'header', eyebrow: 'Addendum Salon', headline: 'Milbon Treatment', accent: 'Quietly restorative', visual_suggestion: 'Close-up of glossy hair, window light' },
  ...Array.from({ length: n - 2 }, (_, i) => ({ number: i + 2, role: 'text', eyebrow: 'MADE FOR YOU', body: `Idea ${i + 2}${extra}, with a calm accent`, accent: 'calm accent', visual_suggestion: 'Hands applying treatment, soft light' })),
  { number: n, role: 'close', body: 'Book your Milbon Treatment', accent: 'Hair, restored', cta: '[IG link sticker: Book now]', visual_suggestion: 'Finished hair, warm light' },
] });

beforeAll(async () => { ({ api } = await setup()); });
afterAll(() => setIntegrationOverride({ ai: undefined }));

describe('Content Studio', () => {
  it('without AI writing it says what to set up (nothing invented)', async () => {
    setIntegrationOverride({ ai: undefined });
    const r = await api.post('/api/content/studio/generate', { format: 'sms', service: 'Hair Botox', goal: 'book', notes: { clientFirstName: 'Ava' } });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/Anthropic/);
  });

  it('checks the format’s rules and asks once more when they’re broken', async () => {
    const answers = [story(4, '!'), story(5)]; // first: wrong slide count and an exclamation point
    const prompts: string[] = [];
    const out = await generateStudio({ format: 'story', service: 'Milbon Treatment', goal: 'book', length: '5', notes: {} }, async (system, user) => { prompts.push(user); expect(system).toMatch(/quiet luxury/); return answers.shift()!; });
    expect(out.warnings).toEqual([]);
    expect(out.result.blocks).toHaveLength(5);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toMatch(/Make exactly 5 slides/);
    expect(prompts[1]).toMatch(/exclamation/);
  });

  it('SMS: 300 characters, the booking link and opt-out on promotions', () => {
    const input = { format: 'sms' as const, service: 'Hair Botox', goal: 'promote' as const, length: null, notes: {} };
    expect(check(input, JSON.parse(sms('Hi Ava, Hair Botox packages are here. {BOOKING_LINK}')))).toContain('Add “Reply STOP to opt out”.');
    expect(check(input, JSON.parse(sms('x'.repeat(301) + ' {BOOKING_LINK} Reply STOP to opt out'))).some((p) => /300/.test(p))).toBe(true);
    expect(check(input, JSON.parse(sms('Hi Ava, Hair Botox packages are here. {BOOKING_LINK} Reply STOP to opt out')))).toEqual([]);
  });

  it('generates through the API, saves, and attaches an SMS to a follow-up', async () => {
    setIntegrationOverride({ ai: { provider: 'anthropic', analyze: async () => ({}) as any, draft: async () => '', write: async () => sms('Hi Ava, a quiet hour of Hair Botox is waiting for you. {BOOKING_LINK}') } as any });
    const input = { format: 'sms', service: 'Hair Botox', goal: 'book', notes: { clientFirstName: 'Ava' } };
    const g = (await api.post('/api/content/studio/generate', input)).body;
    expect(g.result.blocks[0].body).toMatch(/Ava/);
    const saved = (await api.post('/api/content/studio/saved', { input, result: g.result, title: 'Botox — Ava' })).body;
    expect(saved.items[0].title).toBe('Botox — Ava');
    const task = await db().one<any>(`INSERT INTO tasks(type, title, status, priority, due_at) VALUES ('follow_up','Call Ava','due','medium', now()) RETURNING id`);
    expect((await api.post(`/api/content/studio/saved/${saved.id}/attach`, { taskId: task.id })).status).toBe(200);
    expect((await db().one<any>('SELECT notes FROM tasks WHERE id = $1', [task.id])).notes).toMatch(/Suggested text[\s\S]*Hair Botox/);
  });
});
