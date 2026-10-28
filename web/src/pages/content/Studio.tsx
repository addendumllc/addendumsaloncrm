import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ClipboardPaste, Copy, ExternalLink, Link2, RefreshCw, Save, Sparkles, Trash2 } from 'lucide-react';
import type { TaskDTO } from '@addendum/shared';
import { api } from '../../api/client';
import { useTasks } from '../../api/hooks';
import { Badge, Button, EmptyState, Field, Modal, Segmented, cx, useToast, chipClass } from '../../components/ui';

type Format = 'story' | 'reel' | 'carousel' | 'feed' | 'caption' | 'sms' | 'email' | 'google' | 'signage';
type Goal = 'book' | 'educate' | 'promote' | 'reengage';
type Block = { number?: number; role: string; eyebrow?: string | null; headline?: string | null; body?: string | null; accent?: string | null; fine_print?: string | null; on_screen_text?: string | null; voiceover?: string | null; timestamp?: string | null; cta?: string | null; visual_suggestion?: string | null };
type Result = { format?: string; service?: string; blocks: Block[]; caption?: string | null; hashtags?: string[] | null; subject_lines?: string[] | null; posting_tips?: string[] | null };
type Input = { format: Format; service: string; goal: Goal; length: string | null; notes: { offer?: string; eventDate?: string; stylist?: string; stylistHandle?: string; clientFirstName?: string; other?: string } };
type Saved = { id: string; title: string; format: Format; service: string; goal: Goal; length: string | null; notes: Input['notes']; result: Result; byName: string | null; createdAt: string };

const FORMATS: [Format, string][] = [['story', 'Instagram Story'], ['reel', 'Reel'], ['carousel', 'Carousel Post'], ['feed', 'Single Feed Post'], ['caption', 'Caption Only'], ['sms', 'SMS (client text)'], ['email', 'Email'], ['google', 'Google Business Post'], ['signage', 'In-Salon Signage/Poster']];
const SERVICES = ['Hair Botox', 'Milbon Treatment', 'Keratin Treatment', 'Hair Polish', 'Extensions (K-Tips / Tape-ins / Sewn-in Wefts)', 'Blowout Membership', 'Color', 'Stylist Spotlight', 'Event'];
const GOALS: [Goal, string][] = [['book', 'Book appointments'], ['educate', 'Educate'], ['promote', 'Promote an offer or event'], ['reengage', 'Re-engage past clients']];
const LENGTHS: Partial<Record<Format, { options: string[]; label: (v: string) => string; def: string }>> = {
  story: { options: ['4', '5', '6', '7', '8', '9', '10'], label: (v) => `${v} slides`, def: '6' },
  carousel: { options: ['5', '6', '7', '8', '9', '10'], label: (v) => `${v} slides`, def: '7' },
  reel: { options: ['15', '30', '60'], label: (v) => `${v} sec`, def: '30' },
};
const formatName = (f: Format) => FORMATS.find(([v]) => v === f)?.[1] ?? f;

/** Body text with the accent phrase in italics (where the phrase appears). */
function Accented({ text, accent }: { text?: string | null; accent?: string | null }) {
  if (!text) return null;
  const at = accent ? text.toLowerCase().indexOf(accent.toLowerCase()) : -1;
  if (at < 0) return <>{text}</>;
  return <>{text.slice(0, at)}<em className="font-display italic">{text.slice(at, at + accent!.length)}</em>{text.slice(at + accent!.length)}</>;
}
const blockText = (b: Block) => [b.timestamp && `[${b.timestamp}]`, b.eyebrow, b.headline, b.body, b.on_screen_text && `On screen: ${b.on_screen_text}`, b.voiceover && `Voiceover: ${b.voiceover}`,
  b.fine_print, b.cta, b.visual_suggestion && `Visual: ${b.visual_suggestion}`].filter(Boolean).join('\n');
function allText(r: Result) {
  return [r.subject_lines?.length && `Subject lines:\n${r.subject_lines.map((s) => `- ${s}`).join('\n')}`, ...r.blocks.map((b, i) => `${b.number ?? i + 1}. ${b.role.toUpperCase()}\n${blockText(b)}`),
    r.caption && `Caption:\n${r.caption}`, r.hashtags?.length && r.hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)).join(' '), r.posting_tips?.length && `Posting tips:\n${r.posting_tips.map((t) => `- ${t}`).join('\n')}`].filter(Boolean).join('\n\n');
}

/**
 * Content Studio: pick a format, service, goal and length, add notes, and the AI writes the piece on the server in
 * Addendum Salon's voice — shown the way it will look, with a copy and regenerate button on each block. Save to reuse
 * (e.g. attach an SMS to a follow-up).
 */
export function StudioTab() {
  const toast = useToast();
  const qc = useQueryClient();
  const [input, setInput] = useState<Input>({ format: 'story', service: SERVICES[0], goal: 'book', length: '6', notes: {} });
  const [custom, setCustom] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [used, setUsed] = useState<Input | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [regen, setRegen] = useState<number | 'caption' | null>(null);
  const [subject, setSubject] = useState(0);
  const [attaching, setAttaching] = useState<string | null>(null);
  // AI in the CRM (Gemini), or copy & paste with Claude.ai (no key) — remembered on this device.
  const [mode, setModeState] = useState<'ai' | 'claude'>(() => { try { return localStorage.getItem('studio-mode') === 'ai' ? 'ai' : 'claude'; } catch { return 'claude'; } });
  const setMode = (m: 'ai' | 'claude') => { setModeState(m); try { localStorage.setItem('studio-mode', m); } catch { /* private */ } };
  const [pasted, setPasted] = useState('');
  const [prompted, setPrompted] = useState<Input | null>(null);
  const { data: saved } = useQuery({ queryKey: ['studio-saved'], queryFn: () => api.get<{ items: Saved[] }>('/content/studio/saved').then((r) => r.items) });
  const len = LENGTHS[input.format];
  const service = input.service === 'Custom' ? custom.trim() : input.service;
  const setN = (k: keyof Input['notes'], v: string) => setInput({ ...input, notes: { ...input.notes, [k]: v } });
  const copy = async (t: string) => { try { await navigator.clipboard.writeText(t); toast('Copied'); } catch { window.prompt('Copy', t); } };
  const generate = async () => {
    if (!service) { toast('Describe the custom service.', 'error'); return; }
    const body: Input = { ...input, service, length: len ? input.length ?? len.def : null };
    setBusy(true);
    try {
      const r = await api.post<{ result: Result; warnings: string[] }>('/content/studio/generate', body);
      setResult(r.result); setWarnings(r.warnings); setUsed(body); setSubject(0);
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  const request = (): Input | null => {
    if (!service) { toast('Describe the custom service.', 'error'); return null; }
    return { ...input, service, length: len ? input.length ?? len.def : null };
  };
  const copyPrompt = async () => {
    const body = request(); if (!body) return;
    try {
      const { prompt } = await api.post<{ prompt: string }>('/content/studio/prompt', body);
      await copy(prompt); setPrompted(body); setPasted('');
      toast('Prompt copied — paste it into Claude, then paste Claude’s answer here');
    } catch (e) { toast((e as Error).message, 'error'); }
  };
  const importAnswer = async () => {
    const body = prompted ?? request(); if (!body) return;
    setBusy(true);
    try {
      const r = await api.post<{ result: Result; warnings: string[] }>('/content/studio/import', { input: body, text: pasted });
      setResult(r.result); setWarnings(r.warnings); setUsed(body); setSubject(0); setPasted('');
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  const regenerate = async (index: number | 'caption') => {
    if (!result || !used) return;
    setRegen(index);
    try { setResult((await api.post<{ result: Result }>('/content/studio/regenerate', { input: used, result, index })).result); }
    catch (e) { toast((e as Error).message, 'error'); } finally { setRegen(null); }
  };
  const save = async () => {
    if (!result || !used) return;
    const title = window.prompt('Name it (to find it later)', `${formatName(used.format)} — ${used.service}${used.notes.clientFirstName ? ` — ${used.notes.clientFirstName}` : ''}`);
    if (!title) return;
    try { qc.setQueryData(['studio-saved'], (await api.post<{ items: Saved[] }>('/content/studio/saved', { input: used, result, title })).items); toast('Saved'); }
    catch (e) { toast((e as Error).message, 'error'); }
  };
  const open = (s: Saved) => { setResult(s.result); setUsed({ format: s.format, service: s.service, goal: s.goal, length: s.length, notes: s.notes }); setWarnings([]); setSubject(0); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  const del = async (s: Saved) => { if (!window.confirm(`Delete “${s.title}”?`)) return; qc.setQueryData(['studio-saved'], (await api.del<{ items: Saved[] }>(`/content/studio/saved/${s.id}`)).items); };

  const BlockTools = ({ i, text }: { i: number | 'caption'; text: string }) => (
    <span className="flex gap-1">
      <button type="button" className="rounded p-1 text-stone hover:bg-mist hover:text-ink" onClick={() => copy(text)} aria-label="Copy"><Copy className="h-3.5 w-3.5" /></button>
      {mode === 'ai' && <button type="button" className="rounded p-1 text-stone hover:bg-mist hover:text-ink disabled:opacity-40" disabled={regen !== null} onClick={() => regenerate(i)} aria-label="Regenerate"><RefreshCw className={cx('h-3.5 w-3.5', regen === i && 'animate-spin')} /></button>}
    </span>
  );
  const fmt = used?.format;
  const visualCards = fmt === 'story' || fmt === 'reel' || fmt === 'carousel';
  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_300px]">
      <div className="space-y-5">
        <section className="panel space-y-4 p-4 text-[14px]">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Format"><select className="field" value={input.format} onChange={(e) => { const f = e.target.value as Format; setInput({ ...input, format: f, length: LENGTHS[f]?.def ?? null }); }}>{FORMATS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
            <Field label="Service"><select className="field" value={input.service} onChange={(e) => setInput({ ...input, service: e.target.value })}>{[...SERVICES, 'Custom'].map((s) => <option key={s}>{s}</option>)}</select></Field>
            <Field label="Goal"><select className="field" value={input.goal} onChange={(e) => setInput({ ...input, goal: e.target.value as Goal })}>{GOALS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
            {len && <Field label="Length"><select className="field" value={input.length ?? len.def} onChange={(e) => setInput({ ...input, length: e.target.value })}>{len.options.map((o) => <option key={o} value={o}>{len.label(o)}</option>)}</select></Field>}
          </div>
          {input.service === 'Custom' && <Field label="Custom service"><input className="field" value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="Describe it (only facts — nothing is invented)" /></Field>}
          <details className="rounded-lg border border-line px-3 py-2" open={!!Object.values(input.notes).some(Boolean)}>
            <summary className="cursor-pointer text-[13px] text-ink-soft">Notes (optional): offer, event date, stylist, client first name</summary>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <Field label="Offer details" className="sm:col-span-2"><textarea className="field min-h-[56px]" value={input.notes.offer ?? ''} onChange={(e) => setN('offer', e.target.value)} placeholder="Only what’s true — prices, dates and terms are never invented" /></Field>
              <Field label="Event date"><input className="field" value={input.notes.eventDate ?? ''} onChange={(e) => setN('eventDate', e.target.value)} /></Field>
              <Field label="Stylist name and handle"><span className="grid grid-cols-2 gap-2"><input className="field" placeholder="Name" value={input.notes.stylist ?? ''} onChange={(e) => setN('stylist', e.target.value)} /><input className="field" placeholder="@handle" value={input.notes.stylistHandle ?? ''} onChange={(e) => setN('stylistHandle', e.target.value)} /></span></Field>
              {(input.format === 'sms' || input.format === 'email') && <Field label="Client first name"><input className="field" value={input.notes.clientFirstName ?? ''} onChange={(e) => setN('clientFirstName', e.target.value)} /></Field>}
              <Field label="Anything else" className={input.format === 'sms' || input.format === 'email' ? '' : 'sm:col-span-2'}><input className="field" value={input.notes.other ?? ''} onChange={(e) => setN('other', e.target.value)} /></Field>
            </div>
          </details>
          <Segmented size="sm" value={mode} onChange={setMode} options={[{ value: 'claude', label: 'Claude.ai (copy & paste)' }, { value: 'ai', label: 'AI in the CRM (Gemini)' }]} />
          {mode === 'claude' ? (
            <div className="space-y-2 rounded-lg border border-line bg-mist/30 p-3 text-[13px]">
              <p className="text-ink-soft"><b className="font-medium text-ink">1.</b> Copy the prompt <b className="font-medium text-ink">2.</b> Paste it into Claude <b className="font-medium text-ink">3.</b> Copy Claude’s whole answer and paste it below.</p>
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" icon={<Copy className="h-4 w-4" />} onClick={copyPrompt}>Copy prompt for Claude</Button>
                <a className="inline-flex items-center gap-1 px-2 text-plum hover:underline" href="https://claude.ai/new" target="_blank" rel="noreferrer">Open Claude.ai <ExternalLink className="h-3.5 w-3.5" /></a>
              </div>
              <textarea className="field min-h-[90px] font-mono text-[12px]" placeholder="Paste Claude’s answer here (it starts with { and ends with })" value={pasted} onChange={(e) => setPasted(e.target.value)} />
              <Button icon={<ClipboardPaste className="h-4 w-4" />} loading={busy} disabled={!pasted.trim()} onClick={importAnswer}>Show it</Button>
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            {mode === 'ai' && <Button variant="primary" icon={<Sparkles className="h-4 w-4" />} loading={busy} onClick={generate}>Generate</Button>}
            {result && <><Button icon={<Copy className="h-4 w-4" />} onClick={() => copy(allText(result))}>Copy all</Button><Button icon={<Save className="h-4 w-4" />} onClick={save}>Save</Button></>}
            <span className="text-[12px] text-stone">{mode === 'ai' ? 'Written on the server with Gemini (key in API & Integrations). Nothing is posted or sent.' : 'Uses your Claude.ai account — no key needed. Checked against the same format rules.'}</span>
          </div>
        </section>

        {result && used && (
          <section className="space-y-4">
            <div className="flex flex-wrap items-baseline gap-2"><h2 className="text-[15px] font-medium text-ink">{formatName(used.format)} · {used.service}</h2>{used.length && <span className="text-[13px] text-stone">{LENGTHS[used.format]?.label(used.length)}</span>}</div>
            {warnings.length > 0 && <div className="rounded-lg border border-amber/40 bg-amber-tint px-3 py-2 text-[13px] text-ink-soft"><b className="font-medium text-ink">Check before using:</b> {warnings.join(' ')}</div>}

            {fmt === 'email' && !!result.subject_lines?.length && (
              <div className="flex flex-wrap items-center gap-2"><span className="text-[12px] uppercase tracking-wide text-stone">Subject</span>
                {result.subject_lines.map((s, i) => <button key={s} type="button" onClick={() => setSubject(i)} className={chipClass(subject === i)}>{subject === i && <Check className="mr-1 inline h-3.5 w-3.5" />}{s} <span className="opacity-60">({s.length})</span></button>)}
              </div>
            )}

            {visualCards ? (
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                {result.blocks.map((b, i) => (
                  <div key={i} className="space-y-1.5">
                    <div className={cx('flex flex-col justify-between overflow-hidden rounded-xl bg-[#1B1714] p-4 text-[#F3EEE7]', fmt === 'carousel' ? 'aspect-[4/5]' : 'aspect-[9/16]')}>
                      <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.2em] text-[#F3EEE7]/60"><span>{b.timestamp ?? `${b.number ?? i + 1} · ${b.role}`}</span></div>
                      <div className="space-y-2">
                        {b.eyebrow && <p className="text-[10px] uppercase tracking-[0.25em] text-[#F3EEE7]/70">{b.eyebrow}</p>}
                        {b.headline && <p className="font-display text-[22px] leading-tight"><Accented text={b.headline} accent={b.accent} /></p>}
                        {b.on_screen_text && <p className="font-display text-[19px] leading-tight">{b.on_screen_text}</p>}
                        {b.body && <p className="text-[13px] leading-snug text-[#F3EEE7]/90"><Accented text={b.body} accent={b.accent} /></p>}
                        {!b.body && !b.headline && b.accent && <p className="font-display text-[18px] italic">{b.accent}</p>}
                        {b.role === 'header' && b.accent && b.headline && !b.headline.includes(b.accent) && <p className="font-display text-[15px] italic text-[#F3EEE7]/85">{b.accent}</p>}
                        {b.fine_print && <p className="text-[10px] text-[#F3EEE7]/60">{b.fine_print}</p>}
                        {b.cta && <p className="text-[11px] uppercase tracking-[0.15em] text-[#F3EEE7]/85">{b.cta}</p>}
                      </div>
                    </div>
                    {b.voiceover && <p className="text-[12px] text-ink-soft"><b className="font-medium">Voiceover:</b> {b.voiceover}</p>}
                    {b.visual_suggestion && <p className="text-[12px] italic text-stone">{b.visual_suggestion}</p>}
                    <BlockTools i={i} text={blockText(b)} />
                  </div>
                ))}
              </div>
            ) : fmt === 'sms' ? (
              <SmsPreview block={result.blocks.find((b) => b.role === 'sms') ?? result.blocks[0]} onChange={(body) => setResult({ ...result, blocks: result.blocks.map((b) => (b.role === 'sms' ? { ...b, body } : b)) })}
                tools={<BlockTools i={Math.max(0, result.blocks.findIndex((b) => b.role === 'sms'))} text={result.blocks.find((b) => b.role === 'sms')?.body ?? ''} />} />
            ) : fmt === 'email' ? (
              <div className="mx-auto max-w-[600px] overflow-hidden rounded-xl border border-line bg-white">
                <div className="border-b border-line bg-mist/40 px-4 py-2 text-[13px]"><b className="font-medium text-ink">{result.subject_lines?.[subject] ?? ''}</b><span className="ml-2 text-stone">{result.blocks.find((b) => b.role === 'preview')?.body}</span></div>
                <div className="space-y-3 px-6 py-5 text-[14px] text-ink">
                  {result.blocks.filter((b) => b.role !== 'preview').map((b, i0) => { const i = result.blocks.indexOf(b); return (
                    <div key={i0} className="group relative">
                      {b.role === 'headline' && <h3 className="font-display text-[24px] leading-tight">{b.headline ?? b.body}</h3>}
                      {b.role === 'body' && <div className="space-y-2 whitespace-pre-line leading-relaxed"><Accented text={b.body} accent={b.accent} /></div>}
                      {b.role === 'button' && <span className="inline-block bg-[#1B1714] px-5 py-2.5 text-[12px] uppercase tracking-[0.15em] text-[#F3EEE7]">{b.body ?? b.cta}</span>}
                      {b.role === 'ps' && <p className="text-[13px] text-ink-soft">P.S. {(b.body ?? '').replace(/^P\.S\.\s*/i, '')}</p>}
                      {!['headline', 'body', 'button', 'ps'].includes(b.role) && <p className="whitespace-pre-line">{blockText(b)}</p>}
                      {b.visual_suggestion && <p className="mt-1 text-[12px] italic text-stone">{b.visual_suggestion}</p>}
                      <span className="absolute -right-2 -top-2 hidden rounded bg-white shadow-sm group-hover:block"><BlockTools i={i} text={blockText(b)} /></span>
                    </div>
                  ); })}
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                {result.blocks.map((b, i) => (
                  <div key={i} className="panel p-4 text-[14px]">
                    <div className="mb-1 flex items-center justify-between"><Badge>{b.role}{b.number ? ` ${b.number}` : ''}</Badge><BlockTools i={i} text={blockText(b)} /></div>
                    {b.headline && <p className="font-display text-[20px] leading-tight text-ink"><Accented text={b.headline} accent={b.accent} /></p>}
                    {b.body && <p className="whitespace-pre-line text-ink"><Accented text={b.body} accent={b.accent} /></p>}
                    {b.cta && <p className="mt-1 text-[13px] text-ink-soft">{b.cta}</p>}
                    {b.visual_suggestion && <p className="mt-1 text-[12px] italic text-stone">{b.visual_suggestion}</p>}
                  </div>
                ))}
              </div>
            )}

            {(result.caption || result.hashtags?.length) && (
              <div className="panel p-4 text-[14px]">
                <div className="mb-1 flex items-center justify-between"><span className="text-[12px] uppercase tracking-wide text-stone">Caption</span><BlockTools i="caption" text={[result.caption, result.hashtags?.map((h) => (h.startsWith('#') ? h : `#${h}`)).join(' ')].filter(Boolean).join('\n\n')} /></div>
                {result.caption && <p className="whitespace-pre-line text-ink">{result.caption}</p>}
                {!!result.hashtags?.length && <p className="mt-2 text-stone">{result.hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)).join(' ')}</p>}
              </div>
            )}
            {!!result.posting_tips?.length && <div className="text-[13px] text-ink-soft"><span className="text-[12px] uppercase tracking-wide text-stone">Posting tips</span><ul className="mt-1 list-disc pl-5">{result.posting_tips.map((t) => <li key={t}>{t}</li>)}</ul></div>}
          </section>
        )}
      </div>

      <aside className="space-y-2">
        <h2 className="text-[15px] font-medium text-ink">Saved</h2>
        {!saved?.length ? <p className="text-[13px] text-stone">Saved pieces show here to reuse.</p> : (
          <ul className="panel divide-y divide-line">{saved.map((s) => (
            <li key={s.id} className="px-3 py-2 text-[13px]">
              <button type="button" className="block w-full text-left" onClick={() => open(s)}><span className="block truncate font-medium text-ink">{s.title}</span><span className="text-[11px] text-stone">{formatName(s.format)} · {new Date(s.createdAt).toLocaleDateString()}{s.byName ? ` · ${s.byName}` : ''}</span></button>
              <span className="mt-1 flex gap-1">
                {(s.format === 'sms' || s.format === 'email') && <Button size="sm" variant="ghost" icon={<Link2 className="h-3.5 w-3.5" />} onClick={() => setAttaching(s.id)}>Add to follow-up</Button>}
                <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5" />} aria-label="Delete" onClick={() => del(s)} />
              </span>
            </li>
          ))}</ul>
        )}
      </aside>
      {attaching && <AttachModal id={attaching} onClose={() => setAttaching(null)} />}
    </div>
  );
}

/** The client text in a phone bubble — editable, with a live character count (max 300). */
function SmsPreview({ block, onChange, tools }: { block: Block; onChange: (body: string) => void; tools: React.ReactNode }) {
  const body = block.body ?? '';
  return (
    <div className="mx-auto w-full max-w-[340px] space-y-2">
      <div className="rounded-[2rem] border border-line bg-white p-4 shadow-sm">
        <p className="mb-3 text-center text-[11px] text-stone">Addendum Salon</p>
        <div className="ml-auto max-w-[85%] rounded-2xl rounded-br-sm bg-[#1B1714] px-3 py-2 text-[14px] leading-snug text-[#F3EEE7]">
          <textarea className="block w-full resize-none bg-transparent outline-none" rows={Math.max(3, Math.ceil(body.length / 34))} value={body} onChange={(e) => onChange(e.target.value)} aria-label="Text message" />
        </div>
      </div>
      <div className="flex items-center justify-between text-[12px]"><span className={body.length > 300 ? 'text-rose' : 'text-stone'}>{body.length} / 300 characters</span>{tools}</div>
      {block.visual_suggestion && <p className="text-[12px] italic text-stone">{block.visual_suggestion}</p>}
    </div>
  );
}

/** Adds a saved SMS or email to one of the person's open follow-ups. */
function AttachModal({ id, onClose }: { id: string; onClose: () => void }) {
  const toast = useToast();
  const { data: tasks } = useTasks({ kind: 'follow_up', status: 'open' });
  const [q, setQ] = useState('');
  const list = useMemo(() => (tasks ?? []).filter((t: TaskDTO) => `${t.title} ${t.contactName ?? ''}`.toLowerCase().includes(q.toLowerCase())).slice(0, 30), [tasks, q]);
  const attach = async (t: TaskDTO) => {
    try { await api.post(`/content/studio/saved/${id}/attach`, { taskId: t.id }); toast(`Added to “${t.title}”`); onClose(); } catch (e) { toast((e as Error).message, 'error'); }
  };
  return (
    <Modal open wide onClose={onClose} title="Add to a follow-up" footer={<Button variant="ghost" onClick={onClose}>Cancel</Button>}>
      <input className="field mb-3" placeholder="Search follow-ups or clients" value={q} onChange={(e) => setQ(e.target.value)} />
      {!list.length ? <EmptyState title="No open follow-ups match" /> : (
        <ul className="divide-y divide-line border border-line">{list.map((t) => (
          <li key={t.id}><button type="button" className="flex w-full items-center gap-3 px-3 py-2 text-left text-[13px] hover:bg-mist/40" onClick={() => attach(t)}><span className="min-w-0 flex-1 truncate text-ink">{t.title}</span><span className="text-stone">{t.contactName}</span></button></li>
        ))}</ul>
      )}
      <p className="mt-2 text-[12px] text-stone">The text is added to the follow-up’s notes, ready to send when it’s done.</p>
    </Modal>
  );
}
