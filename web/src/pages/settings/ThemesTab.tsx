import { useEffect, useState } from 'react';
import { Copy, Pencil, Plus, Star, Trash2 } from 'lucide-react';
import { DEFAULT_APPEARANCE, DEFAULT_THEME_SETTINGS, ROLES, fontFile, type BuiltinRole, type CrmTheme, type ThemeSettings } from '@addendum/shared';
import { useLook, useSettings } from '../../api/hooks';
import { applyAppearance } from '../../lib/theme';
import { ButtonFields, COLOR_FIELDS, ColorField, LivePreview, ThemeCard, TypeFields, suggestColors, SidebarOpacityField, OpacityField, ThemePreviewLarge } from '../../components/domain/ThemeFields';
import { Badge, Button, Field, Modal, Segmented, Toggle } from '../../components/ui';
import { Card, SaveBar, useCan, useSection } from './shared';
import { FontStylesCard } from './FontStyles';

const ROLE_LABEL: Record<BuiltinRole, string> = { admin: 'Admin', receptionist: 'Reception', stylist: 'Stylist', assistant: 'Assistant' };
const STATUS: Record<CrmTheme['status'], { label: string; tone: 'sage' | 'amber' | 'neutral' }> = {
  published: { label: 'Published', tone: 'sage' }, draft: { label: 'Draft', tone: 'amber' }, retired: { label: 'Retired', tone: 'neutral' },
};
const slug = (name: string, taken: string[]) => {
  const b = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'theme';
  let id = b; let i = 2;
  while (taken.includes(id)) id = `${b}-${i++}`;
  return id;
};

/**
 * Settings → Theme Management (administrators): the approved themes. Each sets colours, fonts and sizes, and button
 * size and corners — never the layout. Draft themes are only seen here; published ones can be chosen by the team (or by
 * the roles picked); retired ones are no longer offered (anyone using one moves to the default).
 */
export function ThemesSettings() {
  const sec = useSection('appearance');
  const can = useCan();
  const [editing, setEditing] = useState<CrmTheme | null>(null);
  if (!sec.draft) return null;
  const locked = !can('settings:write');
  const ts: ThemeSettings = { ...DEFAULT_THEME_SETTINGS, ...(sec.draft.themeSettings ?? {}) };
  const put = (next: Partial<ThemeSettings>) => sec.set('themeSettings', { ...ts, ...next });
  const upsert = (t: CrmTheme) => put({ themes: ts.themes.some((x) => x.id === t.id) ? ts.themes.map((x) => (x.id === t.id ? t : x)) : [...ts.themes, t] });
  const newTheme = (from?: CrmTheme): CrmTheme => {
    const base = from ?? ts.themes.find((x) => x.id === ts.defaultTheme) ?? DEFAULT_THEME_SETTINGS.themes[0];
    const name = from ? `${from.name} copy` : 'New theme';
    return { ...base, id: slug(name, ts.themes.map((x) => x.id)), name, description: from?.description ?? '', status: 'draft', roles: [] };
  };
  return (
    <div className="space-y-6">
      <Card title="Themes" description="Approved looks for the team to choose from (click a name to rename it). A theme sets colours, fonts and text sizes, and buttons — every theme uses the same layout and components. Press Save changes to publish your edits."
        footer={<SaveBar dirty={sec.dirty} saving={sec.saving} onSave={() => sec.save()} onReset={sec.reset} disabled={locked} />}>
        <div className="mb-4 flex justify-end"><Button variant="primary" icon={<Plus className="h-4 w-4" />} disabled={locked} onClick={() => setEditing(newTheme())}>New theme</Button></div>
        <ul className="divide-y divide-line border border-line">
          {ts.themes.map((t) => {
            const isDefault = t.id === ts.defaultTheme;
            return (
              <li key={t.id} className="flex flex-wrap items-center gap-3 px-3 py-3">
                <span className="flex shrink-0 overflow-hidden border border-black/10" aria-hidden>
                  {(['background', 'sidebar', 'surface', 'accent', 'accent2'] as const).map((k) => <span key={k} className="h-8 w-4" style={{ background: t.colors[k] }} />)}
                </span>
                <span className="min-w-[10rem] flex-1">
                  <span className="flex flex-wrap items-center gap-2 text-[14px] font-medium text-ink">
                    <input key={`${t.id}-${t.name}`} className="min-w-0 max-w-[14rem] border border-transparent bg-transparent px-1 py-0.5 font-medium text-ink hover:border-line focus:border-plum focus:bg-white focus:outline-none"
                      defaultValue={t.name} maxLength={40} disabled={locked} aria-label={`Rename ${t.name}`}
                      onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== t.name) upsert({ ...t, name: v }); else e.target.value = t.name; }}
                      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} /><Badge tone={STATUS[t.status].tone}>{STATUS[t.status].label}</Badge>{isDefault && <Badge tone="plum">Default</Badge>}</span>
                  <span className="block text-[12px] text-stone">{t.description || '—'} · {t.roles.length ? `For ${t.roles.map((r) => ROLE_LABEL[r]).join(', ')}` : 'Everyone'}</span>
                </span>
                <span className="flex flex-wrap gap-1">
                  <Button size="sm" variant="ghost" icon={<Pencil className="h-4 w-4" />} disabled={locked} onClick={() => setEditing(t)}>Edit</Button>
                  <Button size="sm" variant="ghost" icon={<Copy className="h-4 w-4" />} disabled={locked} onClick={() => setEditing(newTheme(t))}>Duplicate</Button>
                  {t.status !== 'published' && <Button size="sm" disabled={locked} onClick={() => upsert({ ...t, status: 'published' })}>Publish</Button>}
                  {t.status === 'published' && !isDefault && <Button size="sm" variant="ghost" disabled={locked} onClick={() => upsert({ ...t, status: 'retired' })}>Retire</Button>}
                  {t.status === 'published' && !isDefault && <Button size="sm" variant="ghost" icon={<Star className="h-4 w-4" />} disabled={locked} onClick={() => put({ defaultTheme: t.id })}>Make default</Button>}
                  {!isDefault && ts.themes.length > 1 && (
                    <Button size="sm" variant="ghost" icon={<Trash2 className="h-4 w-4" />} disabled={locked} aria-label={`Delete ${t.name}`}
                      onClick={() => window.confirm(`Delete “${t.name}”? Anyone using it moves to the default theme. (Press Save changes to apply.)`) && put({ themes: ts.themes.filter((x) => x.id !== t.id) })}>Delete</Button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
        <p className="mt-2 text-[12px] text-stone">The default theme must be published; it’s what everyone sees until they choose another. Make another theme the default before deleting this one.</p>
      </Card>

      <FontStylesCard sec={sec as any} locked={locked} />

      <Card title="What team members can change" description="On top of their theme, for themselves only."
        footer={<SaveBar dirty={sec.dirty} saving={sec.saving} onSave={() => sec.save()} onReset={sec.reset} disabled={locked} />}>
        <div className="max-w-lg space-y-1">
          <Toggle label="Colors" description="Accents, backgrounds, sidebar, cards, text and borders." checked={ts.allow.colors} disabled={locked} onChange={(v) => put({ allow: { ...ts.allow, colors: v } })} />
          <Toggle label="Fonts and text size" description="Interface font, heading font, and sizes for text, headings and labels." checked={ts.allow.type} disabled={locked} onChange={(v) => put({ allow: { ...ts.allow, type: v } })} />
          <Toggle label="Buttons" description="Button size and corners." checked={ts.allow.buttons} disabled={locked} onChange={(v) => put({ allow: { ...ts.allow, buttons: v } })} />
        </div>
      </Card>
      {editing && <ThemeEditor theme={editing} isDefault={editing.id === ts.defaultTheme} onClose={() => setEditing(null)} onDone={(t) => { upsert(t); setEditing(null); }} />}
    </div>
  );
}

/** Create or edit a theme, previewed across the whole app while open. */
function ThemeEditor({ theme, isDefault, onClose, onDone }: { theme: CrmTheme; isDefault: boolean; onClose: () => void; onDone: (t: CrmTheme) => void }) {
  const { data: settings } = useSettings();
  const { data: look } = useLook();
  const [t, setT] = useState<CrmTheme>(theme);
  const org = { ...DEFAULT_APPEARANCE, ...(settings?.settings.appearance ?? {}) };
  // Preview: this theme as everyone's default, without anyone's own adjustments (only on this screen, until closed).
  useEffect(() => {
    const ts = { ...DEFAULT_THEME_SETTINGS, ...(org.themeSettings ?? {}) };
    applyAppearance({ ...org, themeSettings: { ...ts, themes: [...ts.themes.filter((x) => x.id !== t.id), { ...t, status: 'published', roles: [] }], defaultTheme: t.id } }, { mode: look?.mode ?? null, accent: null, theme: null });
  }, [JSON.stringify(t)]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => applyAppearance(org, look ?? null), []); // eslint-disable-line react-hooks/exhaustive-deps
  const valid = t.name.trim().length > 0;
  return (
    <Modal open wide onClose={onClose} title={theme.name === t.name ? `Theme · ${t.name}` : `Theme · ${t.name || 'Untitled'}`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!valid} onClick={() => onDone({ ...t, name: t.name.trim(), description: t.description.trim() })}>Done</Button></>}>
      {/* Always in view while choosing: this theme's colours. */}
      <div className="sticky -top-5 z-10 -mx-5 -mt-5 mb-4 border-b border-line bg-white px-5 py-3">
        <ThemePreviewLarge t={t} />
        <p className="mt-2 text-[12px] text-stone">Previewing this theme here and across the CRM while this is open. Press Done, then Save changes, to keep it.</p>
      </div>
      <div className="space-y-6">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name"><input className="field" maxLength={40} value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} /></Field>
          <Field label="Description (optional)"><input className="field" maxLength={160} value={t.description} onChange={(e) => setT({ ...t, description: e.target.value })} /></Field>
          <div>
            <span className="label">Status</span>
            <Segmented value={t.status} onChange={(status) => setT({ ...t, status: isDefault ? 'published' : status })}
              options={[{ value: 'draft', label: 'Draft' }, { value: 'published', label: 'Published' }, ...(isDefault ? [] : [{ value: 'retired' as const, label: 'Retired' }])]} />
            {isDefault && <p className="mt-1 text-[12px] text-stone">The default theme stays published.</p>}
          </div>
          <div>
            <span className="label">Who can choose it</span>
            <div className="flex flex-wrap gap-3 pt-1 text-[14px] text-ink-soft">
              {ROLES.map((r) => (
                <label key={r} className="flex items-center gap-1.5"><input type="checkbox" className="h-4 w-4 accent-plum" checked={t.roles.includes(r)}
                  onChange={(e) => setT({ ...t, roles: e.target.checked ? [...t.roles, r] : t.roles.filter((x) => x !== r) })} />{ROLE_LABEL[r]}</label>
              ))}
            </div>
            <p className="mt-1 text-[12px] text-stone">{t.roles.length ? 'Only these roles.' : 'None ticked: everyone.'}</p>
          </div>
        </div>
        <section>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-stone">Colors</p>
          <div className="border border-line px-4 py-1">
            {COLOR_FIELDS.map((f) => (
              <ColorField key={f.key} field={f.key} label={f.label} hint={f.hint} value={t.colors[f.key]} fallback={t.colors[f.key]} suggestions={suggestColors(f.key, t.colors)}
                onChange={(v) => v && setT({ ...t, colors: { ...t.colors, [f.key]: v } })}>
                {f.key === 'sidebar' ? <SidebarOpacityField value={t.sidebarOpacity ?? 100} onChange={(v) => setT({ ...t, sidebarOpacity: v ?? 100 })} />
                  : <OpacityField label={f.label} value={t.opacity?.[f.key] ?? 100} onChange={(v) => setT({ ...t, opacity: { ...(t.opacity ?? {}), [f.key]: v ?? 100 } })} />}
              </ColorField>
            ))}
          </div>
        </section>
        <section>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-stone">Fonts & text size</p>
          <TypeFields value={t.type} onChange={(p) => setT({ ...t, type: { ...t.type, ...p } })} customFonts={{ heading: fontFile(org, 'heading')?.name, body: fontFile(org, 'body')?.name }} />
        </section>
        <section>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-stone">Buttons</p>
          <ButtonFields value={t.buttons} onChange={(p) => setT({ ...t, buttons: { ...t.buttons, ...p } })} />
        </section>
        <section>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-stone">Preview</p>
          <LivePreview />
        </section>
      </div>
    </Modal>
  );
}
