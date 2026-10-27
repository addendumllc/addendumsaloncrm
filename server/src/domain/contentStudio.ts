import { z } from 'zod';
import { db } from '../db/index.js';
import { aiService } from '../integrations/registry.js';
import { badRequest, notFound } from '../lib/errors.js';
import { iso } from '../lib/time.js';

/**
 * Content Studio: on-brand copy and photo/video suggestions for one format at a time, written by the AI on the server
 * (the key never reaches the browser). The answer must be JSON in the format's shape and follow its rules; if it
 * doesn't, the AI is asked once more with what was wrong. Nothing is posted or sent.
 */
export const STUDIO_FORMATS = ['story', 'reel', 'carousel', 'feed', 'caption', 'sms', 'email', 'google', 'signage'] as const;
export type StudioFormat = (typeof STUDIO_FORMATS)[number];
export const FORMAT_NAMES: Record<StudioFormat, string> = {
  story: 'Instagram Story', reel: 'Reel', carousel: 'Carousel Post', feed: 'Single Feed Post', caption: 'Caption Only', sms: 'SMS (client text)',
  email: 'Email', google: 'Google Business Post', signage: 'In-Salon Signage/Poster',
};
export const STUDIO_GOALS = { book: 'Book appointments', educate: 'Educate', promote: 'Promote an offer or event', reengage: 'Re-engage past clients' } as const;

export const SYSTEM_PROMPT = `You are the content copywriter for Addendum Salon, a luxury hair salon specializing in extensions, color and restorative treatments. Voice: editorial, quiet luxury, confident and warm, minimal. No emojis, exclamation points, slang, or hype words ("amazing", "obsessed", "game-changer"). Hashtags only where a format below allows them.

Universal rules:
- Only state facts from the service notes or the user's notes. Never invent prices, durations, guarantees, results, or testimonials. Missing details become [PLACEHOLDER].
- Never repeat a phrase within one piece.
- Every piece ends with one clear CTA that matches the goal.
- Suggest a photo or video for every visual block: subject, framing, light, mood.
- Hair Botox does not straighten or permanently change texture.

FORMAT RULES

INSTAGRAM STORY
- Slide 1, HEADER: label "Addendum Salon", the service name as the headline, an italic tagline under 8 words. No "tap/swipe" prompts.
- Middle slides, TEXT OVER PHOTO: one idea each; an eyebrow (2–4 words, uppercase), a body (max 25 words) with one italic accent phrase, optional fine print (max 14 words).
- Last slide, CLOSE: a tagline (under 8 words, italic accent), "Book your [service]", and "[IG link sticker: Book now]". Use stickers for interaction (poll, question box) where they fit.

REEL
- A hook in the first 2 seconds (on-screen text under 7 words), then a shot list with timestamps, on-screen text per shot, an optional voiceover script, a music mood (no specific songs), and a closing CTA frame.
- Caption: 2–4 short lines plus CTA, then 3–5 relevant local/industry hashtags.

CAROUSEL POST
- Slide 1, cover: a headline under 8 words with an italic accent.
- Slides 2 to N-1: one idea each, max 30 words.
- Last slide: tagline plus "Book via link in bio."
- Caption: a 1-line hook, 3–5 lines of value, CTA, 3–5 hashtags.

SINGLE FEED POST
- Image direction, optional overlay text (under 8 words), and a caption (hook, 2–4 lines, CTA, 3–5 hashtags).

CAPTION ONLY
- 3 variations: short (1–2 lines), medium (4–6 lines), long (story-driven, 8–10 lines). Each ends with a CTA and 3–5 hashtags.

SMS (client text)
- Max 300 characters, first name personalization, from "Addendum Salon". Warm and personal, one CTA, booking link placeholder {BOOKING_LINK}. Add "Reply STOP to opt out" on promotional messages. No hashtags.

EMAIL
- 3 subject line options (under 45 characters), preview text (under 90 characters), a headline, a body of 80–150 words in short paragraphs, a button label (2–4 words), and a P.S. line. No hashtags.

GOOGLE BUSINESS POST
- Max 1,500 characters, plain and informative, the service benefit in the first sentence, a "Book" button CTA, no hashtags.

IN-SALON SIGNAGE / POSTER
- A headline (under 6 words), a tagline, 1–3 benefit lines, a CTA ("Scan to book" + [QR CODE]), and layout notes.

SERVICE NOTES
- Hair Botox: restorative deep-conditioning; restores moisture, boosts shine, softens, improves manageability; recommended as 3 consecutive in-salon sessions; packages available.
- Milbon Treatment: customized professional treatment (hydration, repair, strength, smoothness, shine); guest goes home with 4 personalized weekly boosters.
- Keratin Treatment: formaldehyde-free smoothing; seals cuticle, reduces frizz, improves shine, resists humidity, cuts styling time; lasts up to 12 weeks depending on hair type and home care; texture returns gradually.
- Extensions: K-Tips, Tape-ins, Sewn-in Wefts using Addendum Hair; starts with goals (volume, length, or both); color match, personalized plan, questions answered before install; move-up appointments matter as much as the install; same-day color + extensions transformations available.
- Hair Polish: [ADD DETAILS]
- Blowout Membership: [ADD DETAILS]
- Retail available: Addendum Hair brushes, Double Shot Leave-In, Milbon, Oribe.

OUTPUT: return ONLY JSON:
{
  "format": "",
  "service": "",
  "blocks": [
    {
      "number": 1,
      "role": "header | text | close | hook | shot | cover | slide | subject | preview | headline | body | button | ps | sms | caption | overlay | signage",
      "eyebrow": "",
      "headline": "",
      "body": "",
      "accent": "",
      "fine_print": "",
      "on_screen_text": "",
      "voiceover": "",
      "timestamp": "",
      "cta": "",
      "visual_suggestion": ""
    }
  ],
  "caption": "",
  "hashtags": [],
  "subject_lines": [],
  "posting_tips": []
}
Leave out any field that doesn't apply to the format.`;

const opt = z.string().optional().nullable();
export const blockSchema = z.object({
  number: z.number().int().optional(), role: z.string(), eyebrow: opt, headline: opt, body: opt, accent: opt, fine_print: opt, on_screen_text: opt, voiceover: opt, timestamp: opt, cta: opt, visual_suggestion: opt,
});
export const resultSchema = z.object({
  format: z.string().optional(), service: z.string().optional(), blocks: z.array(blockSchema).min(1),
  caption: opt, hashtags: z.array(z.string()).optional().nullable(), subject_lines: z.array(z.string()).optional().nullable(), posting_tips: z.array(z.string()).optional().nullable(),
});
export type StudioResult = z.infer<typeof resultSchema>;
export type StudioBlock = z.infer<typeof blockSchema>;
export interface StudioInput {
  format: StudioFormat; service: string; goal: keyof typeof STUDIO_GOALS; length: string | null;
  notes: { offer?: string | null; eventDate?: string | null; stylist?: string | null; stylistHandle?: string | null; clientFirstName?: string | null; other?: string | null };
}

const words = (s?: string | null) => (s ?? '').trim().split(/\s+/).filter(Boolean).length;
const EMOJI = /\p{Extended_Pictographic}/u;
const HYPE = /\b(amazing|obsessed|game[- ]?changer)\b/i;
/** What breaks the format's rules (empty = fine). */
export function check(input: StudioInput, r: StudioResult): string[] {
  const p: string[] = [];
  const all = [...r.blocks.flatMap((b) => [b.eyebrow, b.headline, b.body, b.accent, b.fine_print, b.on_screen_text, b.voiceover, b.cta]), r.caption, ...(r.subject_lines ?? [])].filter(Boolean).join('\n');
  if (EMOJI.test(all)) p.push('Remove all emojis.');
  if (all.includes('!')) p.push('Remove exclamation points.');
  if (HYPE.test(all)) p.push('Remove hype words (amazing, obsessed, game-changer).');
  const n = Number.parseInt(input.length ?? '', 10);
  const roles = r.blocks.map((b) => b.role);
  const noTags = ['sms', 'email', 'google', 'signage', 'story'];
  if (noTags.includes(input.format) && (r.hashtags?.length || /#\w/.test(all))) p.push('This format takes no hashtags.');
  switch (input.format) {
    case 'story':
      if (n && r.blocks.length !== n) p.push(`Make exactly ${n} slides.`);
      if (roles[0] !== 'header') p.push('Slide 1 must be the header.');
      if (roles.at(-1) !== 'close') p.push('The last slide must be the close.');
      for (const b of r.blocks.filter((x) => x.role === 'text')) {
        if (words(b.body) > 25) p.push(`Slide ${b.number ?? ''} body is over 25 words.`);
        if (b.fine_print && words(b.fine_print) > 14) p.push(`Slide ${b.number ?? ''} fine print is over 14 words.`);
        if (b.eyebrow && (words(b.eyebrow) > 4 || b.eyebrow !== b.eyebrow.toUpperCase())) p.push(`Slide ${b.number ?? ''} eyebrow must be 2–4 words, uppercase.`);
      }
      if (/\b(tap|swipe)\b/i.test(all)) p.push('No “tap” or “swipe” prompts.');
      break;
    case 'carousel':
      if (n && r.blocks.length !== n) p.push(`Make exactly ${n} slides.`);
      if (words(r.blocks[0]?.headline) >= 8) p.push('The cover headline must be under 8 words.');
      for (const b of r.blocks.slice(1, -1)) if (words(b.body) > 30) p.push(`Slide ${b.number ?? ''} is over 30 words.`);
      if (!/link in bio/i.test(JSON.stringify(r.blocks.at(-1)))) p.push('The last slide must say “Book via link in bio.”');
      if (!r.caption) p.push('Add the caption.');
      if ((r.hashtags?.length ?? 0) < 3 || (r.hashtags?.length ?? 0) > 5) p.push('Use 3–5 hashtags.');
      break;
    case 'reel':
      if (roles[0] !== 'hook') p.push('Start with the hook.');
      if (words(r.blocks[0]?.on_screen_text) >= 7) p.push('The hook’s on-screen text must be under 7 words.');
      if (!r.blocks.some((b) => b.role === 'shot' && b.timestamp)) p.push('Add the shot list with timestamps.');
      if (!r.caption) p.push('Add the caption.');
      if ((r.hashtags?.length ?? 0) < 3 || (r.hashtags?.length ?? 0) > 5) p.push('Use 3–5 hashtags.');
      break;
    case 'feed':
      if (!r.caption) p.push('Add the caption.');
      if ((r.hashtags?.length ?? 0) < 3 || (r.hashtags?.length ?? 0) > 5) p.push('Use 3–5 hashtags.');
      break;
    case 'caption':
      if (r.blocks.filter((b) => b.role === 'caption').length !== 3) p.push('Give exactly 3 caption variations (short, medium, long).');
      break;
    case 'sms': {
      const sms = r.blocks.find((b) => b.role === 'sms')?.body ?? '';
      if (!sms) p.push('Write the SMS in one block with role "sms".');
      if (sms.length > 300) p.push(`The SMS is ${sms.length} characters — keep it to 300.`);
      if (!sms.includes('{BOOKING_LINK}')) p.push('Include {BOOKING_LINK}.');
      if (input.goal === 'promote' && !/reply stop to opt out/i.test(sms)) p.push('Add “Reply STOP to opt out”.');
      break;
    }
    case 'email':
      if ((r.subject_lines?.length ?? 0) !== 3) p.push('Give exactly 3 subject lines.');
      for (const s of r.subject_lines ?? []) if (s.length >= 45) p.push(`Subject line “${s}” is 45+ characters.`);
      if ((r.blocks.find((b) => b.role === 'preview')?.body ?? '').length >= 90) p.push('Preview text must be under 90 characters.');
      { const w = words(r.blocks.find((b) => b.role === 'body')?.body); if (w && (w < 80 || w > 150)) p.push(`The body is ${w} words — make it 80–150.`); }
      if (!r.blocks.some((b) => b.role === 'button')) p.push('Add the button label.');
      if (!r.blocks.some((b) => b.role === 'ps')) p.push('Add the P.S. line.');
      break;
    case 'google':
      if (all.length > 1500) p.push('Keep it to 1,500 characters.');
      break;
    case 'signage':
      if (words(r.blocks.find((b) => b.role === 'headline' || b.role === 'signage')?.headline) >= 6) p.push('The headline must be under 6 words.');
      if (!/scan to book/i.test(all)) p.push('The CTA must be “Scan to book” with [QR CODE].');
      break;
  }
  return p;
}

function userMessage(input: StudioInput) {
  const n = input.notes;
  return JSON.stringify({
    format: FORMAT_NAMES[input.format], service: input.service, goal: STUDIO_GOALS[input.goal], length: input.length,
    notes: Object.fromEntries(Object.entries({ offer_details: n.offer, event_date: n.eventDate, stylist_name: n.stylist, stylist_handle: n.stylistHandle, client_first_name: n.clientFirstName, other: n.other }).filter(([, v]) => v)),
  });
}
const parseJson = (text: string) => JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));

/** A piece for one format: the AI's JSON, checked against the format's rules — asked once more if it isn't right. */
export async function generateStudio(input: StudioInput, write = aiService().write?.bind(aiService())): Promise<{ result: StudioResult; warnings: string[] }> {
  if (!write) throw badRequest('Content Studio needs AI writing — add the Gemini API key in Settings → API & Integrations → AI (Google Gemini).');
  const ask = async (extra?: string): Promise<{ r: StudioResult | null; err: string | null }> => {
    const text = await write(SYSTEM_PROMPT, extra ? `${userMessage(input)}\n\n${extra}` : userMessage(input), 3000);
    try { return { r: resultSchema.parse(parseJson(text)), err: null }; } catch (e) { return { r: null, err: `Return ONLY valid JSON in the schema (${(e as Error).message.slice(0, 200)}).` }; }
  };
  let a = await ask();
  let problems = a.r ? check(input, a.r) : [a.err!];
  if (problems.length) {
    const prev = a.r;
    a = await ask(`Your last answer didn't follow the rules: ${problems.join(' ')} Return the whole piece again, fixed, as JSON only.`);
    if (!a.r && !prev) throw badRequest('The AI didn’t return a usable answer — try Generate again.');
    if (!a.r) a = { r: prev, err: null };
    problems = check(input, a.r!);
  }
  return { result: a.r!, warnings: problems };
}

/**
 * Copy & paste with Claude.ai (no API key): the full instructions to paste into Claude, and the answer pasted back —
 * checked the same way as a generated one.
 */
export function studioPrompt(input: StudioInput) {
  return `${SYSTEM_PROMPT}\n\n---\n\nWrite this piece and reply with ONLY the JSON object (no other text):\n${userMessage(input)}`;
}
export function importStudio(input: StudioInput, text: string): { result: StudioResult; warnings: string[] } {
  let raw: unknown;
  try { raw = parseJson(text.replace(/```(?:json)?/g, '')); } catch { throw badRequest('That isn’t the JSON answer — copy Claude’s whole reply (it starts with { and ends with }).'); }
  const r = resultSchema.safeParse(raw);
  if (!r.success) throw badRequest('Claude’s answer is missing parts of the format (it needs “blocks”). Ask Claude to “return only the JSON in the schema” and paste again.');
  return { result: r.data, warnings: check(input, r.data) };
}

/** One block written again (the rest of the piece stays) — or the caption when `index` is "caption". */
export async function regenerateBlock(input: StudioInput, result: StudioResult, index: number | 'caption', write = aiService().write?.bind(aiService())) {
  if (!write) throw badRequest('Content Studio needs AI writing — add the Gemini API key in Settings → API & Integrations → AI (Google Gemini).');
  const target = index === 'caption' ? 'the caption and hashtags' : `block number ${result.blocks[index]?.number ?? index + 1} (role "${result.blocks[index]?.role}")`;
  const ask = `${userMessage(input)}\n\nHere is the current piece:\n${JSON.stringify(result)}\n\nRewrite only ${target} — a fresh take that still follows every rule and doesn't repeat phrases from the other blocks. Return the whole piece as JSON, with everything else unchanged.`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const next = resultSchema.parse(parseJson(await write(SYSTEM_PROMPT, ask, 3000)));
      if (index === 'caption') return { ...result, caption: next.caption ?? result.caption, hashtags: next.hashtags ?? result.hashtags };
      const b = next.blocks[index];
      if (b) return { ...result, blocks: result.blocks.map((x, i) => (i === index ? b : x)) };
    } catch { /* once more */ }
  }
  throw badRequest('The AI didn’t return a usable block — try again.');
}

// ---------------- Saved pieces ----------------
export async function saveStudio(staffId: string, input: StudioInput, result: StudioResult, title: string) {
  const r = (await db().one<{ id: string }>('INSERT INTO content_studio_items(title, format, service, goal, length, notes, result, created_by_staff_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
    [title.slice(0, 200), input.format, input.service, input.goal, input.length, JSON.stringify(input.notes), JSON.stringify(result), staffId]))!;
  return r.id;
}
export async function listStudio() {
  return (await db().query<any>(`SELECT i.*, s.name AS by_name FROM content_studio_items i LEFT JOIN staff s ON s.id = i.created_by_staff_id ORDER BY i.created_at DESC LIMIT 200`))
    .map((i) => ({ id: i.id, title: i.title, format: i.format, service: i.service, goal: i.goal, length: i.length, notes: i.notes, result: i.result, byName: i.by_name ?? null, createdAt: iso(i.created_at)! }));
}
export async function deleteStudio(id: string) { await db().query('DELETE FROM content_studio_items WHERE id = $1', [id]); }

/** The text to send: the SMS, or the email (subject, preview, headline, body, button, P.S.). */
export function studioText(r: StudioResult) {
  const by = (role: string) => r.blocks.find((b) => b.role === role);
  const sms = by('sms')?.body;
  if (sms) return sms;
  return [r.subject_lines?.[0] && `Subject: ${r.subject_lines[0]}`, by('preview')?.body && `Preview: ${by('preview')!.body}`, by('headline')?.headline ?? by('headline')?.body, by('body')?.body, by('button')?.body ?? by('button')?.cta, by('ps')?.body && `P.S. ${by('ps')!.body}`]
    .filter(Boolean).join('\n\n');
}
/** Adds a saved SMS or email to a follow-up's notes, ready to use when it's done. */
export async function attachToTask(id: string, taskId: string) {
  const item = await db().one<any>('SELECT title, format, result FROM content_studio_items WHERE id = $1', [id]);
  if (!item) throw notFound('Saved piece not found');
  const task = await db().one<{ id: string }>('SELECT id FROM tasks WHERE id = $1', [taskId]);
  if (!task) throw notFound('Follow-up not found');
  const text = studioText(item.result);
  await db().query(`UPDATE tasks SET notes = CASE WHEN coalesce(notes, '') = '' THEN $2 ELSE notes || E'\\n\\n' || $2 END, updated_at = now() WHERE id = $1`, [taskId, `${item.format === 'sms' ? 'Suggested text' : 'Suggested email'} (Content Studio — ${item.title}):\n${text}`]);
}
