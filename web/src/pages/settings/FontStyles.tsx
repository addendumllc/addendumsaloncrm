import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Copy, Pencil, Plus, Trash2, Upload } from 'lucide-react';
import { DEFAULT_FONT_STYLES, FONT_CHOICES, FONT_MAX_BYTES, FONT_ROLES, type AppSettings, type Appearance, type FontLibraryEntry, type FontRole, type FontStyle, type FontStyleSettings, type FontWeight } from '@addendum/shared';
import { api } from '../../api/client';
import { useSettings } from '../../api/hooks';
import { fontStackFor } from '../../lib/theme';
import { Badge, Button, Field, Modal, Toggle, cx, useToast } from '../../components/ui';
import { Card, SaveBar } from './shared';

type Section = { draft?: Appearance; set: <K extends keyof Appearance>(k: K, v: Appearance[K]) => void; dirty: boolean; saving: boolean; save: () => unknown; reset: () => void };
const WEIGHTS: FontWeight[] = [300, 400, 500, 600, 700];
/** Text sizes offered (percent of standard). */
const SIZES = [80, 90, 110, 120, 135, 150];
const SAMPLE: Record<FontRole, string> = {
  heading: 'Today’s Priorities', subheading: 'Upcoming appointments', body: 'Sarah is due for a colour refresh and has a cut on Friday.',
  menu: 'Dashboard', button: 'Book appointment', label: 'Client name', link: 'View client profile',
};
const slug = (name: string, taken: string[]) => {
  const b = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'style';
  let id = b; let i = 2;
  while (taken.includes(id)) id = `${b}-${i++}`;
  return id;
};

/**
 * Theme Management → Font styles (administrators only): a font for every kind of text — headings, subheadings,
 * paragraphs, the menu, buttons, labels and links — from the built-in fonts or your own uploads, with weight and
 * capitals. Published styles are offered to everyone in their Appearance; the default is what people get until they choose.
 */
export function FontStylesCard({ sec, locked }: { sec: Section; locked: boolean }) {
  const { data: settings } = useSettings();
  const [editing, setEditing] = useState<FontStyle | null>(null);
  const fs: FontStyleSettings = { ...DEFAULT_FONT_STYLES, ...(sec.draft?.fontStyles ?? {}) };
  // The library comes from the server (uploads change it straight away).
  const library = settings?.settings.appearance.fontStyles?.library ?? [];
  const put = (next: Partial<FontStyleSettings>) => sec.set('fontStyles', { ...fs, ...next });
  const upsert = (s: FontStyle) => put({ styles: fs.styles.some((x) => x.id === s.id) ? fs.styles.map((x) => (x.id === s.id ? s : x)) : [...fs.styles, s] });
  const newStyle = (from?: FontStyle): FontStyle => {
    const base = from ?? DEFAULT_FONT_STYLES.styles[0];
    const name = from ? `${from.name} copy` : 'New font style';
    return { ...base, fonts: { ...base.fonts }, weights: { ...(base.weights ?? {}) }, caps: { ...(base.caps ?? {}) }, sizes: { ...(base.sizes ?? {}) }, id: slug(name, fs.styles.map((x) => x.id)), name, description: from?.description ?? '', status: 'draft' };
  };
  return (
    <Card title="Font styles" description="Only administrators make font styles. Each sets the font, weight and capitals for headings, subheadings, paragraphs, the menu, buttons, labels and links — from the built-in fonts or fonts you upload. Published styles are offered to everyone in their Appearance."
      footer={<SaveBar dirty={sec.dirty} saving={sec.saving} onSave={() => sec.save()} onReset={sec.reset} disabled={locked} />}>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <Field label="Everyone gets (until they choose)">
          <select className="field w-auto" disabled={locked} value={fs.defaultStyle ?? ''} onChange={(e) => put({ defaultStyle: e.target.value || null })}>
            <option value="">The theme’s own fonts</option>
            {fs.styles.filter((s) => s.status === 'published').map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Button variant="primary" icon={<Plus className="h-4 w-4" />} disabled={locked} onClick={() => setEditing(newStyle())}>New font style</Button>
      </div>
      <ul className="divide-y divide-line border border-line">
        {fs.styles.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-3 px-3 py-3">
            <span className="min-w-[12rem] flex-1">
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-[18px] leading-tight text-ink" style={{ fontFamily: fontStackFor(s.fonts.heading, library, 'Georgia, serif') }}>{s.name}</span>
                <Badge tone={s.status === 'published' ? 'sage' : 'amber'}>{s.status === 'published' ? 'Published' : 'Draft'}</Badge>
                {fs.defaultStyle === s.id && <Badge tone="plum">Default</Badge>}
              </span>
              <span className="block text-[12px] text-stone" style={{ fontFamily: fontStackFor(s.fonts.body, library, 'system-ui, sans-serif') }}>{s.description || '—'}</span>
            </span>
            <Button size="sm" variant="ghost" icon={<Pencil className="h-4 w-4" />} disabled={locked} onClick={() => setEditing(s)}>Edit</Button>
            <Button size="sm" variant="ghost" icon={<Copy className="h-4 w-4" />} disabled={locked} onClick={() => setEditing(newStyle(s))}>Duplicate</Button>
            <Button size="sm" variant="ghost" icon={<Trash2 className="h-4 w-4" />} disabled={locked || fs.defaultStyle === s.id} onClick={() => confirm(`Delete “${s.name}”? Anyone using it goes back to the default.`) && put({ styles: fs.styles.filter((x) => x.id !== s.id) })}>Delete</Button>
          </li>
        ))}
      </ul>
      <FontLibrary library={library} locked={locked} />
      {editing && <FontStyleEditor style={editing} library={library} onClose={() => setEditing(null)} onDone={(s) => { upsert(s); setEditing(null); }} />}
    </Card>
  );
}

/** Uploads a font file (WOFF2, WOFF, TTF or OTF) to the library; returns the new entry. */
function useFontUpload() {
  const qc = useQueryClient();
  const toast = useToast();
  return async (f: File): Promise<FontLibraryEntry | null> => {
    if (f.size > FONT_MAX_BYTES) { toast('The font file must be 1.5 MB or smaller.', 'error'); return null; }
    try {
      const dataUrl = await new Promise<string>((ok, fail) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = fail; r.readAsDataURL(f); });
      const r = await api.put<{ settings: AppSettings; font: FontLibraryEntry }>('/settings/font-file', { dataUrl, name: f.name });
      qc.setQueryData(['settings'], { settings: r.settings });
      toast(`${r.font.name} uploaded`);
      return r.font;
    } catch (e) {
      toast((e as Error).message, 'error');
      return null;
    }
  };
}

function FontLibrary({ library, locked }: { library: FontLibraryEntry[]; locked: boolean }) {
  const upload = useFontUpload();
  const qc = useQueryClient();
  const toast = useToast();
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="mt-5">
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-stone">Your fonts</p>
      <p className="mb-2 text-[12px] text-stone">Brand fonts you upload (WOFF2 is best). Make sure the licence allows use on websites.</p>
      <div className="flex flex-wrap gap-2">
        {library.map((f) => (
          <span key={f.id} className="inline-flex items-center gap-2 border border-line bg-white px-2.5 py-1 text-[14px]" style={{ fontFamily: fontStackFor(`file:${f.id}`, library, 'inherit') }}>
            {f.name}
            {!locked && <button type="button" className="text-stone hover:text-rose" aria-label={`Remove ${f.name}`} onClick={async () => {
              if (!confirm(`Remove ${f.name}? Font styles using it go back to built-in fonts for that text.`)) return;
              try { const r = await api.del<{ settings: AppSettings }>(`/settings/font-file/${f.id}`); qc.setQueryData(['settings'], { settings: r.settings }); } catch (e) { toast((e as Error).message, 'error'); }
            }}><Trash2 className="h-3.5 w-3.5" /></button>}
          </span>
        ))}
        <input ref={file} type="file" accept=".woff2,.woff,.ttf,.otf,font/*" className="hidden" onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; setBusy(true); await upload(f); setBusy(false); e.target.value = ''; }} />
        <Button size="sm" icon={<Upload className="h-4 w-4" />} loading={busy} disabled={locked} onClick={() => file.current?.click()}>Upload font</Button>
      </div>
    </div>
  );
}

function FontStyleEditor({ style, library: libraryIn, onClose, onDone }: { style: FontStyle; library: FontLibraryEntry[]; onClose: () => void; onDone: (s: FontStyle) => void }) {
  const [s, setS] = useState<FontStyle>(style);
  const [library, setLibrary] = useState(libraryIn);
  useEffect(() => setLibrary(libraryIn), [libraryIn]);
  const upload = useFontUpload();
  const [uploadingFor, setUploadingFor] = useState<FontRole | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const setFont = (role: FontRole, v: string) => setS((x) => ({ ...x, fonts: { ...x.fonts, [role]: v } }));
  return (
    <Modal open xl onClose={onClose} title={style.name === 'New font style' ? 'New font style' : `Edit ${style.name}`} footer={<>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="primary" disabled={!s.name.trim()} onClick={() => onDone({ ...s, name: s.name.trim() })}>Done</Button>
    </>}>
      <input ref={file} type="file" accept=".woff2,.woff,.ttf,.otf,font/*" className="hidden" onChange={async (e) => {
        const f = e.target.files?.[0]; const role = uploadingFor; e.target.value = '';
        if (!f || !role) return;
        const entry = await upload(f);
        if (entry) { setLibrary((l) => [...l, entry]); setFont(role, `file:${entry.id}`); }
        setUploadingFor(null);
      }} />
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name"><input className="field" maxLength={40} value={s.name} onChange={(e) => setS({ ...s, name: e.target.value })} /></Field>
          <Field label="Description"><input className="field" maxLength={160} value={s.description} onChange={(e) => setS({ ...s, description: e.target.value })} /></Field>
        </div>
        <ul className="divide-y divide-line border border-line">
          {FONT_ROLES.map((r) => {
            // Buttons can follow the links (font, weight, capitals and size) — the default.
            const linked = r.key === 'button' && s.buttonsAsLinks !== false;
            const k: FontRole = linked ? 'link' : r.key;
            const stack = fontStackFor(s.fonts[k], library, r.key === 'heading' || r.key === 'subheading' ? 'Georgia, serif' : 'system-ui, sans-serif');
            return (
              <li key={r.key} className="grid gap-2 px-3 py-3 sm:grid-cols-[9rem_minmax(0,1fr)] sm:items-start">
                <div><p className="text-[14px] font-medium text-ink">{r.label}</p><p className="text-[12px] text-stone">{r.hint}</p></div>
                <div className="min-w-0 space-y-2">
                  <p className={cx('truncate text-ink', r.key === 'heading' ? 'text-[26px]' : r.key === 'subheading' ? 'text-[19px]' : 'text-[15px]', r.key === 'link' && 'text-plum underline')}
                    style={{ fontFamily: stack, fontWeight: s.weights?.[k] ?? (k === 'button' || k === 'label' ? 500 : 400), textTransform: s.caps?.[k] ? 'uppercase' : 'none', letterSpacing: s.caps?.[k] ? '0.04em' : undefined, zoom: (s.sizes?.[k] ?? 100) / 100 }}>{SAMPLE[r.key]}</p>
                  {r.key === 'button' && (
                    <label className="flex items-center gap-1.5 text-[13px] text-ink-soft">
                      <input type="checkbox" className="h-4 w-4 accent-plum" checked={linked} onChange={(e) => setS({ ...s, buttonsAsLinks: e.target.checked })} />Same as links
                    </label>
                  )}
                  {!linked && <div className="flex flex-wrap items-center gap-2">
                    <select className="field h-10 w-auto py-1 text-sm" value={s.fonts[r.key]} onChange={(e) => setFont(r.key, e.target.value)} aria-label={`${r.label} font`}>
                      {library.length > 0 && <optgroup label="Your fonts">{library.map((f) => <option key={f.id} value={`file:${f.id}`}>{f.name}</option>)}</optgroup>}
                      <optgroup label="Serif">{FONT_CHOICES.filter((f) => f.kind === 'serif').map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}</optgroup>
                      <optgroup label="Sans-serif">{FONT_CHOICES.filter((f) => f.kind === 'sans').map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}</optgroup>
                    </select>
                    <Button size="sm" variant="ghost" icon={<Upload className="h-4 w-4" />} loading={uploadingFor === r.key} onClick={() => { setUploadingFor(r.key); file.current?.click(); }}>Upload</Button>
                    <select className="field h-10 w-auto py-1 text-sm" value={s.weights?.[r.key] ?? ''} onChange={(e) => setS({ ...s, weights: { ...(s.weights ?? {}), [r.key]: e.target.value ? Number(e.target.value) as FontWeight : undefined } })} aria-label={`${r.label} weight`}>
                      <option value="">Standard weight</option>
                      {WEIGHTS.map((w) => <option key={w} value={w}>{w === 300 ? 'Light' : w === 400 ? 'Regular' : w === 500 ? 'Medium' : w === 600 ? 'Semibold' : 'Bold'} ({w})</option>)}
                    </select>
                    <select className="field h-10 w-auto py-1 text-sm" value={s.sizes?.[r.key] ?? ''} onChange={(e) => setS({ ...s, sizes: { ...(s.sizes ?? {}), [r.key]: e.target.value ? Number(e.target.value) : undefined } })} aria-label={`${r.label} size`}>
                      <option value="">Standard size</option>
                      {SIZES.map((p) => <option key={p} value={p}>{p < 100 ? 'Smaller' : 'Larger'} ({p}%)</option>)}
                    </select>
                    <label className="flex items-center gap-1.5 text-[13px] text-ink-soft">
                      <input type="checkbox" className="h-4 w-4 accent-plum" checked={!!s.caps?.[r.key]} onChange={(e) => setS({ ...s, caps: { ...(s.caps ?? {}), [r.key]: e.target.checked } })} />Capitals
                    </label>
                  </div>}
                </div>
              </li>
            );
          })}
        </ul>
        <Toggle checked={s.status === 'published'} onChange={(v) => setS({ ...s, status: v ? 'published' : 'draft' })} label="Published" description="Offered to everyone in their Appearance. Drafts are only seen here." />
      </div>
    </Modal>
  );
}
