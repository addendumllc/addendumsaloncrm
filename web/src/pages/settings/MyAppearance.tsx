import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DEFAULT_APPEARANCE, DEFAULT_FONT_STYLES, DEFAULT_THEME_SETTINGS, fontFile, resolveTheme, themesFor, withUserThemes, type ColorMode, type CrmTheme, type PersonalLook, type ThemeColors, type ThemeCustom, type ThemeOpacity, type UserThemeDTO } from '@addendum/shared';
import { api } from '../../api/client';
import { useLook, useMe, useSettings, useUserThemes } from '../../api/hooks';
import { USER_COLORS, applyPersonalLook, fontStackFor } from '../../lib/theme';
import { ButtonFields, COLOR_FIELDS, ColorField, LivePreview, ThemeCard, ThemePreviewLarge, TypeFields, suggestColors, SidebarOpacityField, OpacityField } from '../../components/domain/ThemeFields';
import { Button, Field, Modal, PageTabs, Segmented, Toggle, cx, useToast } from '../../components/ui';
import { Pencil, Plus } from 'lucide-react';

/** A section of the Appearance page. */
function Part({ title, hint, children, locked }: { title: string; hint: string; children: React.ReactNode; locked?: string }) {
  return (
    <section className="border-t border-line pt-6 first:border-0 first:pt-0">
      <h3 className="h-display text-[20px]">{title}</h3>
      <p className="mb-4 mt-1 text-[13px] text-stone">{locked ?? hint}</p>
      {!locked && children}
    </section>
  );
}

/**
 * Your appearance (only you, saved to your account): a theme published by an administrator (or the default), then —
 * where your organization allows — your own colours, fonts and text sizes, and button size and corners; plus light,
 * dark or system. The layout and components are the same for everyone. Changes preview live; nothing is kept until Save.
 */
export function MyAppearance() {
  const { data: saved } = useLook();
  const { data: settings } = useSettings();
  const { data: me } = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const org = { ...DEFAULT_APPEARANCE, ...(settings?.settings.appearance ?? {}) };
  // The organization's themes, plus personal ones: their own and others' published (chosen the same way).
  const { data: personal } = useUserThemes();
  const mine = personal?.find((t) => t.mine) ?? null;
  const shared = (personal ?? []).filter((t) => !t.mine);
  const ts = { ...DEFAULT_THEME_SETTINGS, ...withUserThemes(org.themeSettings, (personal ?? []).map((t) => t.theme)) } as typeof DEFAULT_THEME_SETTINGS;
  const userIds = new Set((personal ?? []).map((t) => t.theme.id));
  const offered = themesFor(ts, me?.role).filter((t) => !userIds.has(t.id));
  const [editing, setEditing] = useState(false);
  // Font styles (made by administrators): published ones to choose from; the default is what applies until they choose.
  const fsSettings = { ...DEFAULT_FONT_STYLES, ...(org.fontStyles ?? {}) };
  const fontStyles = fsSettings.styles.filter((x) => x.status === 'published');
  const fsDefault = fontStyles.find((x) => x.id === fsSettings.defaultStyle) ?? null;
  const base: PersonalLook = saved ?? { accent: null, mode: null, theme: null };
  // An accent chosen before themes existed becomes their own accent here.
  const start: PersonalLook = { ...base, custom: base.custom ?? (base.accent ? { colors: { accent: base.accent } } : {}), accent: null };
  const [draft, setDraft] = useState<PersonalLook | null>(null);
  const d = draft ?? start;
  const [saving, setSaving] = useState(false);
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(start);
  const r = resolveTheme(ts, d, me?.role);
  const theme = resolveTheme(ts, { themeId: d.themeId }, me?.role); // the theme alone (the "theme's" values)
  const custom: ThemeCustom = d.custom ?? {};
  const setCustom = (c: ThemeCustom) => setDraft({ ...d, custom: c });
  // Opacity of each colour (the sidebar has its own): their own over the theme's.
  const setOpacity = (k: Exclude<keyof ThemeColors, 'sidebar'>, v: number | undefined) => { const o = { ...(custom.opacity ?? {}) }; if (v == null) delete o[k]; else o[k] = v; setCustom({ ...custom, opacity: o }); };
  const setColor = (k: keyof ThemeColors, v: string | undefined) => { const colors = { ...(custom.colors ?? {}) }; if (v) colors[k] = v; else delete colors[k]; setCustom({ ...custom, colors }); };
  // Theme Settings (themes and colours) · Font Style (fonts and every text size) · Button Style — one draft, one Save.
  const [section, setSectionState] = useState<'theme' | 'font' | 'buttons'>(() => { try { const v = localStorage.getItem('appearance-section'); return v === 'font' || v === 'buttons' ? v : 'theme'; } catch { return 'theme'; } });
  const setSection = (v: 'theme' | 'font' | 'buttons') => { setSectionState(v); try { localStorage.setItem('appearance-section', v); } catch { /* private window */ } };
  const [more, setMore] = useState(() => !!Object.keys(start.custom?.colors ?? {}).some((k) => k !== 'accent' && k !== 'accent2'));
  // Their calendar colour (Calendar color, below): offered as an accent.
  const { data: profile } = useQuery({ queryKey: ['my-profile'], queryFn: () => api.get<{ profile: { color: string | null } }>('/my-profile').then((r) => r.profile) });

  // Live preview across the whole app; the saved look comes back when leaving without saving.
  const key = JSON.stringify(d);
  useEffect(() => { if (draft) applyPersonalLook(draft); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const savedKey = JSON.stringify(base);
  useEffect(() => () => applyPersonalLook(JSON.parse(savedKey)), [savedKey]);

  const save = async () => {
    setSaving(true);
    try {
      const res = await api.put<{ look: PersonalLook }>('/look', { themeId: d.themeId ?? null, custom: d.custom ?? {}, mode: d.mode ?? null, accent: null, fontStyleId: d.fontStyleId ?? null });
      qc.setQueryData(['look'], res.look);
      setDraft(null);
      toast('Appearance saved');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };
  const cancel = () => { setDraft(null); applyPersonalLook(base); };
  const reset = () => setDraft({ ...d, themeId: null, custom: {} });
  const def = ts.themes.find((x) => x.id === ts.defaultTheme);
  const locked = 'Your organization uses the theme’s settings for this.';

  return (
    <div className="border border-line bg-white">
      <div className="px-5 pt-4">
        <PageTabs className="mb-0" value={section} onChange={setSection} options={[{ value: 'theme', label: 'Theme Settings' }, { value: 'font', label: 'Font Style' }, { value: 'buttons', label: 'Button Style' }]} />
      </div>
      <div className="space-y-6 p-5">
        {section === 'theme' && <>
        <Part title="Theme" hint="Themes published by your administrator. Pick one, then adjust it below if you like.">
          <div className="-mx-1.5 flex flex-wrap gap-1">
            {def && <ThemeCard t={def} badge="Default" on={!d.themeId} onPick={() => setDraft({ ...d, themeId: null })} />}
            {offered.filter((x) => x.id !== ts.defaultTheme).map((t) => <ThemeCard key={t.id} t={t} on={d.themeId === t.id} onPick={() => setDraft({ ...d, themeId: t.id })} />)}
          </div>
          {/* Their own theme (one each): only theirs unless they publish it for the team. */}
          <div className="mt-5">
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-stone">Your theme</p>
            {mine ? (
              <div className="-mx-1.5 flex flex-wrap items-center gap-1">
                <ThemeCard t={mine.theme} badge={mine.published ? 'Published' : 'Only you'} on={d.themeId === mine.theme.id} onPick={() => setDraft({ ...d, themeId: mine.theme.id })} />
                <Button size="sm" variant="ghost" icon={<Pencil className="h-4 w-4" />} onClick={() => setEditing(true)}>Edit your theme</Button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing(true)}>Create your theme</Button>
                <span className="text-[13px] text-stone">One theme of your own. Keep it to yourself, or publish it so others can use it.</span>
              </div>
            )}
          </div>
          {shared.length > 0 && (
            <div className="mt-5">
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-stone">Shared by the team</p>
              <div className="-mx-1.5 flex flex-wrap gap-1">
                {shared.map((u) => <ThemeCard key={u.theme.id} t={u.theme} badge={`By ${u.authorName.split(' ')[0]}`} on={d.themeId === u.theme.id} onPick={() => setDraft({ ...d, themeId: u.theme.id })} />)}
              </div>
            </div>
          )}
          {editing && <MyThemeEditor mine={mine} start={r} onClose={() => setEditing(false)} onSaved={(id) => setDraft({ ...d, themeId: id })} />}
        </Part>
        <Part title="Colors" hint="Your own accent colours over the theme — from the calendar colours, your own calendar colour, or any colour. The layout never changes." locked={ts.allow.colors ? undefined : locked}>
          {/* Accents first: the calendar colours, your own calendar colour, or any colour. */}
          <div className="border border-line px-4 py-1">
            {COLOR_FIELDS.filter((f) => f.key === 'accent' || f.key === 'accent2').map((f) => (
              <ColorField key={f.key} field={f.key} label={f.label} hint={f.hint} value={custom.colors?.[f.key]} fallback={theme.colors[f.key]} swatches={USER_COLORS}
                suggestions={suggestColors(f.key, r.colors)}
                action={profile?.color ? { label: 'Use my calendar color', color: profile.color } : undefined}
                onChange={(v) => setColor(f.key, v)}>
                <OpacityField label={f.label} value={r.opacity?.[f.key as 'accent'] ?? 100} fromTheme={theme.opacity?.[f.key as 'accent'] ?? 100} onChange={(v) => setOpacity(f.key as 'accent', v)} />
              </ColorField>
            ))}
          </div>
          <button type="button" onClick={() => setMore((v) => !v)} aria-expanded={more} className="mt-3 text-[13px] font-medium text-plum hover:underline">
            {more ? 'Hide' : 'Show'} background, sidebar, cards, text and borders (each with its opacity)
          </button>
          {more && (
            <div className="mt-2 border border-line px-4 py-1">
              {COLOR_FIELDS.filter((f) => f.key !== 'accent' && f.key !== 'accent2').map((f) => (
                <ColorField key={f.key} field={f.key} label={f.label} hint={f.hint} value={custom.colors?.[f.key]} fallback={theme.colors[f.key]} suggestions={suggestColors(f.key, r.colors)} onChange={(v) => setColor(f.key, v)}>
                  {f.key === 'sidebar' ? (
                    <SidebarOpacityField value={r.sidebarOpacity} fromTheme={theme.sidebarOpacity}
                      onChange={(v) => { const next = { ...custom }; if (v == null) delete next.sidebarOpacity; else next.sidebarOpacity = v; setCustom(next); }} />
                  ) : (
                    <OpacityField label={f.label} value={r.opacity?.[f.key] ?? 100} fromTheme={theme.opacity?.[f.key] ?? 100} onChange={(v) => setOpacity(f.key as Exclude<keyof ThemeColors, 'sidebar'>, v)} />
                  )}
                </ColorField>
              ))}
            </div>
          )}
        </Part>
        <Part title="Display" hint="Light, dark or following your device. The layout and sizes stay the same.">
          <Segmented value={(d.mode ?? 'light') as ColorMode} onChange={(m) => setDraft({ ...d, mode: m })} options={[{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }, { value: 'auto', label: 'System' }]} />
        </Part>
        </>}
        {section === 'font' && <>
        {fontStyles.length > 0 && (
          <Part title="Font style" hint="Font styles made by your administrator: a font for headings, subheadings, paragraphs, the menu, buttons and labels. Pick the one you prefer.">
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {[{ id: null as string | null, name: fsDefault ? `${fsDefault.name} (default)` : 'The theme’s fonts (default)', style: fsDefault }, ...fontStyles.filter((x) => x.id !== fsSettings.defaultStyle).map((x) => ({ id: x.id as string | null, name: x.name, style: x }))].map((o) => {
                const on = (d.fontStyleId ?? null) === o.id;
                const stack = (role: 'heading' | 'body') => (o.style ? fontStackFor(o.style.fonts[role], fsSettings.library ?? [], role === 'heading' ? 'Georgia, serif' : 'system-ui, sans-serif') : role === 'heading' ? 'var(--font-display)' : 'var(--font-body)');
                return (
                  <button key={o.id ?? 'default'} type="button" aria-pressed={on} onClick={() => setDraft({ ...d, fontStyleId: o.id })}
                    className={cx('border p-3 text-left', on ? 'border-ink ring-1 ring-ink' : 'border-line-strong hover:border-ink/40')}>
                    <span className="block text-[20px] leading-tight text-ink" style={{ fontFamily: stack('heading'), textTransform: o.style?.caps?.heading ? 'uppercase' : 'none' }}>Aa · Headings</span>
                    <span className="mt-1 block text-[13px] text-ink-soft" style={{ fontFamily: stack('body') }}>Paragraphs, menu and buttons</span>
                    <span className="mt-2 block text-[12px] font-medium text-stone">{o.name}</span>
                  </button>
                );
              })}
            </div>
          </Part>
        )}
        {/* Fonts come only from the theme or the font styles made in Theme Management; people pick sizes and weight. */}
        {!fontStyles.length && <p className="text-[13px] text-stone">Fonts come from the theme. Your administrator can add font styles to choose from in Theme Management.</p>}
        <Part title="Text size & weight" hint="Base text, headings, small text and labels, and text weight — applied evenly across the CRM, for you only." locked={ts.allow.type ? undefined : locked}>
          <TypeFields hideFonts value={r.type} onChange={(p) => setCustom({ ...custom, type: { ...(custom.type ?? {}), ...p } })}
            customFonts={{ heading: fontFile(org, 'heading')?.name, body: fontFile(org, 'body')?.name }} />
        </Part>
        </>}
        {section === 'buttons' && (
          <Part title="Button style" hint="One size, height and corner style for every button — for you only." locked={ts.allow.buttons ? undefined : locked}>
            <ButtonFields value={r.buttons} onChange={(p) => setCustom({ ...custom, buttons: { ...(custom.buttons ?? {}), ...p } })} />
          </Part>
        )}
        <section className="border-t border-line pt-6">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-stone">Preview</p>
          <LivePreview />
        </section>
      </div>
      <div className={cx('sticky bottom-0 flex flex-wrap items-center gap-2 border-t border-line bg-white px-5 py-3')}>
        {dirty ? <span className="text-[13px] text-amber">Unsaved changes — previewing now</span> : <span className="text-[13px] text-stone">Saved to your account</span>}
        <Button variant="ghost" className="ml-auto" onClick={reset}>Reset to default</Button>
        <Button variant="ghost" disabled={!dirty} onClick={cancel}>Cancel</Button>
        <Button variant="primary" disabled={!dirty} loading={saving} onClick={save}>Save changes</Button>
      </div>
    </div>
  );
}

/**
 * Your own theme (one per person): colours, fonts, text sizes and buttons, starting from what you see now. Only you
 * see it unless you publish it — then everyone can choose it in their Appearance.
 */
function MyThemeEditor({ mine, start, onClose, onSaved }: {
  mine: UserThemeDTO | null; start: Pick<CrmTheme, 'colors' | 'type' | 'buttons'> & { sidebarOpacity?: number; opacity?: ThemeOpacity }; onClose: () => void; onSaved: (id: string) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [t, setT] = useState(() => ({
    name: mine?.theme.name ?? 'My theme', description: mine?.theme.description ?? '',
    colors: { ...(mine?.theme.colors ?? start.colors) }, type: { ...(mine?.theme.type ?? start.type) }, buttons: { ...(mine?.theme.buttons ?? start.buttons) },
    sidebarOpacity: mine?.theme.sidebarOpacity ?? start.sidebarOpacity ?? 100,
    opacity: { ...(mine?.theme.opacity ?? start.opacity ?? {}) } as ThemeOpacity,
    published: mine?.published ?? false,
  }));
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const r = await api.put<{ themes: UserThemeDTO[] }>('/user-themes/mine', t);
      qc.setQueryData(['user-themes'], r.themes);
      const id = r.themes.find((x) => x.mine)?.theme.id;
      if (id) onSaved(id);
      toast(t.published ? 'Your theme is saved and published — press Save changes to use it' : 'Your theme is saved — press Save changes to use it');
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!confirm('Delete your theme? Anyone using it goes back to the default.')) return;
    setBusy(true);
    try {
      const r = await api.del<{ themes: UserThemeDTO[] }>('/user-themes/mine');
      qc.setQueryData(['user-themes'], r.themes);
      toast('Your theme was deleted');
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open wide onClose={onClose} title={mine ? 'Edit your theme' : 'Create your theme'} footer={<>
      {mine && <Button variant="ghost" className="mr-auto text-rose" disabled={busy} onClick={remove}>Delete</Button>}
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="primary" loading={busy} disabled={!t.name.trim()} onClick={save}>Save theme</Button>
    </>}>
      <div className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name"><input className="field" maxLength={40} value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} /></Field>
          <Field label="Description (optional)"><input className="field" maxLength={120} value={t.description} onChange={(e) => setT({ ...t, description: e.target.value })} placeholder="e.g. Soft taupe with serif headings" /></Field>
        </div>
        <ThemePreviewLarge t={{ name: t.name, colors: t.colors, type: t.type, buttons: t.buttons, sidebarOpacity: t.sidebarOpacity }} />
        <div className="border border-line px-4 py-1">
          {COLOR_FIELDS.map((f) => (
            <ColorField key={f.key} field={f.key} label={f.label} hint={f.hint} value={t.colors[f.key]} fallback={start.colors[f.key]} suggestions={suggestColors(f.key, t.colors)}
              onChange={(v) => setT({ ...t, colors: { ...t.colors, [f.key]: v ?? start.colors[f.key] } })}>
              {f.key === 'sidebar' ? <SidebarOpacityField value={t.sidebarOpacity} onChange={(v) => setT({ ...t, sidebarOpacity: v ?? 100 })} />
                : <OpacityField label={f.label} value={t.opacity[f.key] ?? 100} onChange={(v) => setT({ ...t, opacity: { ...t.opacity, [f.key]: v ?? 100 } })} />}
            </ColorField>
          ))}
        </div>
        <TypeFields value={t.type} onChange={(p) => setT({ ...t, type: { ...t.type, ...p } })} />
        <ButtonFields value={t.buttons} onChange={(p) => setT({ ...t, buttons: { ...t.buttons, ...p } })} />
        <div className="border-t border-line pt-3">
          <Toggle checked={t.published} onChange={(v) => setT({ ...t, published: v })} label="Publish for the team"
            description="Everyone can then choose it in their Appearance (shown with your name). Turn off any time; people using it go back to the default." />
        </div>
      </div>
    </Modal>
  );
}
