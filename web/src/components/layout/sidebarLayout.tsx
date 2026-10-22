import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, GripVertical, Lock, type LucideIcon } from 'lucide-react';
import {
  ALWAYS_SHOWN, DEFAULT_MENU_GROUPS, DEFAULT_MENU_ORDER, DEFAULT_MENU_SECTIONS, MENU_SECTIONS, ROLES, type BuiltinRole, type MenuGroup, type MenuSection, type SidebarDefaults,
} from '@addendum/shared';
import { api } from '../../api/client';
import { useMe, useSettings } from '../../api/hooks';
import { Badge, Button, Modal, cx, useToast } from '../ui';

/**
 * Each person's own sidebar (Customize menu), one per business workspace: the order of its items and the ones they've
 * hidden, saved to their account so it follows them to any device. Without one, the business's default (Settings →
 * Businesses) applies. Only the layout — what they may open is still decided by their permissions, and tabs an
 * administrator made required can't be hidden.
 */
export type SidebarLayout = { order: string[]; hidden: string[]; sections?: Record<string, MenuSection>; sectionList?: { key: string; label: string }[]; labels?: Record<string, string> };
export type MenuItem = { to: string; label: string; icon: LucideIcon };

export function useSidebarLayout() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isFetched } = useQuery({
    queryKey: ['sidebar-layout'],
    queryFn: () => api.get<{ layout: SidebarLayout | null }>('/sidebar/layout').then((r) => r.layout),
    staleTime: 5 * 60_000,
  });
  const save = async (layout: SidebarLayout | null) => {
    qc.setQueryData(['sidebar-layout'], layout);
    try {
      await api.put('/sidebar/layout', { layout });
    } catch (e) {
      toast((e as Error).message, 'error');
      qc.invalidateQueries({ queryKey: ['sidebar-layout'] });
    }
  };
  return { layout: data ?? null, loaded: isFetched, save };
}

/** The organization's menu settings (Settings → Businesses): sections, which business each tab is for, role defaults. */
export function useMenuConfig() {
  const { data } = useSettings();
  const w = data?.settings.workspaces;
  const groups: Record<string, MenuGroup> = { ...DEFAULT_MENU_GROUPS, ...(w?.groups ?? {}) };
  const sections: Record<string, MenuSection> = { ...DEFAULT_MENU_SECTIONS, ...(w?.sections ?? {}) };
  const defaults = (role: string | null | undefined): SidebarDefaults => ({ order: DEFAULT_MENU_ORDER, hidden: [], required: [], ...(w?.menuDefaults?.[role as BuiltinRole] ?? {}) });
  return { groups, sections, defaults };
}

/** The sections in order: a saved list (keeping any built-in ones it left out), else the built-in list. */
export const sectionListOf = (list?: { key: string; label: string }[]) => {
  if (!list?.length) return MENU_SECTIONS;
  return [...list, ...MENU_SECTIONS.filter((b) => !list.some((x) => x.key === b.key))];
};
/** A tab's section (a section that no longer exists falls back to the first). */
export const sectionOf = (sections: Record<string, MenuSection>, to: string, heads = MENU_SECTIONS): MenuSection => {
  const k = sections[to] ?? DEFAULT_MENU_SECTIONS[to] ?? 'daily';
  return heads.some((h) => h.key === k) ? k : heads[0]?.key ?? 'daily';
};
export const groupOf = (groups: Record<string, MenuGroup>, to: string): MenuGroup => groups[to] ?? 'shared';

/** Items in the given order (new ones keep their built-in place), each marked hidden / required. */
export function arrange<T extends { to: string }>(items: T[], layout: SidebarLayout | null, defaults?: SidebarDefaults): (T & { hidden: boolean; required: boolean })[] {
  const order = layout?.order ?? defaults?.order ?? DEFAULT_MENU_ORDER;
  const pos = new Map(order.map((to, i) => [to, i]));
  const builtIn = new Map(DEFAULT_MENU_ORDER.map((to, i) => [to, i]));
  const required = new Set([...ALWAYS_SHOWN, ...(defaults?.required ?? [])]);
  const hidden = new Set((layout?.hidden ?? defaults?.hidden ?? []).filter((to) => !required.has(to)));
  return [...items]
    .map((it, i) => ({ it, i }))
    .sort((a, b) => (pos.get(a.it.to) ?? 500 + (builtIn.get(a.it.to) ?? a.i)) - (pos.get(b.it.to) ?? 500 + (builtIn.get(b.it.to) ?? b.i)))
    .map(({ it }) => ({ ...it, hidden: hidden.has(it.to), required: required.has(it.to) }));
}

/**
 * The sidebar: Daily work, Operations, Addendum Hair, Business and Administration, each in this person's order (or
 * their role's default). Only tabs they can open; no business switcher.
 */
export function useMenu<T extends MenuItem>(allowed: T[]) {
  const { data: me } = useMe();
  const { groups, sections, defaults } = useMenuConfig();
  const { layout, save } = useSidebarLayout();
  const def = defaults(me?.role);
  const list = arrange(allowed, layout, def);
  // Sections: theirs (tabs they moved), else the default menu's, else the organization's.
  const src = layout ?? def;
  const mine = { ...sections, ...(src.sections ?? {}) };
  // Headings: theirs (renamed or new), else the default menu's, else the built-in ones; tab names they changed.
  const heads = sectionListOf(src.sectionList);
  const visible = list.filter((n) => !n.hidden).map((n) => ({ ...n, label: src.labels?.[n.to] ?? n.label }));
  const bySection = heads.map((x) => ({ ...x, renamed: x.label !== MENU_SECTIONS.find((b) => b.key === x.key)?.label, items: visible.filter((n) => sectionOf(mine, n.to, heads) === x.key) })).filter((x) => x.items.length);
  return { visible, bySection, layout, save, groups, sections: mine, defaults };
}

// ---------------------------------------------------------------- the editor (personal and admin)

type Row = MenuItem & { hidden: boolean; required: boolean };

/**
 * A menu editor: sections with drag-and-drop (or arrows) to reorder, a checkbox to show or hide, and a live preview of
 * the sidebar. `admin`: also choose each tab's section and which tabs are required.
 */
export function MenuEditor({ items, value, onChange, groups, sections, onSections, required, onRequired, admin }: {
  items: MenuItem[];
  value: SidebarLayout;
  onChange: (v: SidebarLayout) => void;
  groups: Record<string, MenuGroup>;
  sections: Record<string, MenuSection>;
  onSections?: (s: Record<string, MenuSection>) => void;
  required: string[];
  onRequired?: (r: string[]) => void;
  admin?: boolean;
}) {
  const rows = arrange(items, value, { order: value.order, hidden: value.hidden, required });
  const heads = sectionListOf(value.sectionList);
  const [renaming, setRenaming] = useState<string | null>(null);
  const setHeads = (list: { key: string; label: string }[]) => onChange({ ...value, sectionList: list });
  const renameTab = (to: string, label: string, original: string) => {
    const labels = { ...(value.labels ?? {}) };
    if (!label.trim() || label.trim() === original) delete labels[to]; else labels[to] = label.trim().slice(0, 30);
    onChange({ ...value, labels });
  };
  const [drag, setDrag] = useState<string | null>(null);
  const inSection = (k: MenuSection) => rows.filter((r) => sectionOf(sections, r.to, heads) === k);
  const commit = (next: Row[], secs = sections) => onChange({ ...value, order: next.map((r) => r.to), hidden: next.filter((r) => r.hidden && !r.required).map((r) => r.to), sections: secs });
  // A tab dragged onto another section's tab moves into that section.
  const moveToSection = (to: string, k: MenuSection) => { const secs = { ...sections, [to]: k }; onSections ? onSections(secs) : commit(rows, secs); };
  const move = (to: string, target: string) => {
    if (to === target) return;
    // Moving down lands after the target, moving up before it.
    const next = [...rows];
    const from = next.findIndex((r) => r.to === to);
    const at = next.findIndex((r) => r.to === target);
    const [it] = next.splice(from, 1);
    next.splice(at, 0, it);
    commit(next);
  };
  const step = (to: string, dir: -1 | 1) => {
    const list = inSection(sectionOf(sections, to, heads));
    const other = list[list.findIndex((r) => r.to === to) + dir];
    if (other) move(to, other.to);
  };
  const toggle = (to: string) => commit(rows.map((r) => (r.to === to ? { ...r, hidden: !r.hidden } : r)));
  const biz = (to: string) => { const g = groups[to] ?? 'shared'; return g === 'salon' ? 'Salon' : g === 'hair' ? 'Hair' : null; };
  return (
    <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_200px]">
      <div className="space-y-5">
        {heads.map((sec, si) => {
          const list = inSection(sec.key);
          const custom = !MENU_SECTIONS.some((b) => b.key === sec.key);
          // Every section shows, so tabs can be moved into an empty one.
          return (
            <div key={sec.key}>
              <div className="mb-1.5 flex items-center gap-2">
                <input className="min-w-0 flex-1 border-b border-transparent bg-transparent text-[11px] font-semibold uppercase tracking-[0.08em] text-stone hover:border-line focus:border-plum focus:outline-none"
                  value={sec.label} maxLength={30} aria-label="Section heading"
                  onChange={(e) => setHeads(heads.map((h) => (h.key === sec.key ? { ...h, label: e.target.value } : h)))}
                  onBlur={(e) => { if (!e.target.value.trim()) setHeads(heads.map((h) => (h.key === sec.key ? { ...h, label: MENU_SECTIONS.find((b) => b.key === sec.key)?.label ?? 'Section' } : h))); }} />
                <button type="button" className="p-0.5 text-stone hover:text-ink disabled:opacity-30" disabled={si === 0} aria-label={`Move ${sec.label} up`}
                  onClick={() => { const l = [...heads]; [l[si - 1], l[si]] = [l[si], l[si - 1]]; setHeads(l); }}><ArrowUp className="h-3.5 w-3.5" /></button>
                <button type="button" className="p-0.5 text-stone hover:text-ink disabled:opacity-30" disabled={si === heads.length - 1} aria-label={`Move ${sec.label} down`}
                  onClick={() => { const l = [...heads]; [l[si + 1], l[si]] = [l[si], l[si + 1]]; setHeads(l); }}><ArrowDown className="h-3.5 w-3.5" /></button>
                {custom && !list.length && <button type="button" className="text-[12px] text-stone hover:text-rose" onClick={() => setHeads(heads.filter((h) => h.key !== sec.key))}>Remove</button>}
              </div>
              <ul className="divide-y divide-line border border-line bg-white">
                {list.length === 0 && (
                  <li className="px-3 py-2 text-[13px] text-stone" onDragOver={(e) => { if (drag) { e.preventDefault(); moveToSection(drag, sec.key); } }}>No tabs here — drag one in, or pick this section on a tab.</li>
                )}
                {list.map((r, i) => (
                  <li key={r.to} draggable onDragStart={(e) => { setDrag(r.to); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', r.to); }}
                    onDragOver={(e) => {
                      if (!drag) return;
                      e.preventDefault();
                      if (sectionOf(sections, drag, heads) !== sec.key) moveToSection(drag, sec.key);
                      else if (drag !== r.to) move(drag, r.to);
                    }}
                    onDragEnd={() => setDrag(null)} onDrop={(e) => e.preventDefault()}
                    className={cx('flex flex-wrap items-center gap-2 px-2 py-1.5 text-[14px]', drag === r.to && 'opacity-40', r.hidden ? 'text-stone-light' : 'text-ink')}>
                    <GripVertical className="h-4 w-4 shrink-0 cursor-grab text-stone" aria-hidden />
                    <label className="flex min-w-0 flex-1 items-center gap-2">
                      <input type="checkbox" className="h-4 w-4 accent-plum" checked={!r.hidden} disabled={r.required} onChange={() => toggle(r.to)} aria-label={`Show ${r.label}`} />
                      <r.icon className="h-4 w-4 shrink-0 text-stone" />
                      {renaming === r.to ? (
                        <input autoFocus className="field h-7 w-40 py-0 text-[13px]" defaultValue={value.labels?.[r.to] ?? r.label} maxLength={30} aria-label={`New name for ${r.label}`}
                          onBlur={(e) => { renameTab(r.to, e.target.value, r.label); setRenaming(null); }}
                          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(null); }} />
                      ) : (
                        <button type="button" className={cx('truncate text-left hover:underline', r.hidden && 'line-through')} title="Rename" onClick={(e) => { e.preventDefault(); setRenaming(r.to); }}>
                          {value.labels?.[r.to] ?? r.label}
                        </button>
                      )}
                      {value.labels?.[r.to] && <span className="text-[11px] text-stone">({r.label})</span>}
                      {biz(r.to) && <span className="text-[11px] text-stone">· {biz(r.to)}</span>}
                      {r.required && !admin && <Badge><Lock className="mr-0.5 inline h-3 w-3" />Required</Badge>}
                    </label>
                    {(
                      <select className="field h-8 w-auto py-0 text-[13px]" value={sectionOf(sections, r.to, heads)} aria-label={`${r.label} section`}
                        onChange={(e) => moveToSection(r.to, e.target.value as MenuSection)}>
                        {heads.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
                      </select>
                    )}
                    {admin && onRequired && !ALWAYS_SHOWN.includes(r.to) && (
                      <label className="flex items-center gap-1 text-[12px] text-ink-soft">
                        <input type="checkbox" className="h-3.5 w-3.5 accent-plum" checked={required.includes(r.to)} onChange={(e) => onRequired(e.target.checked ? [...required, r.to] : required.filter((x) => x !== r.to))} />Required
                      </label>
                    )}
                    <span className="flex">
                      <button type="button" className="p-1 text-stone hover:text-ink disabled:opacity-30" disabled={i === 0} onClick={() => step(r.to, -1)} aria-label={`Move ${r.label} up`}><ArrowUp className="h-3.5 w-3.5" /></button>
                      <button type="button" className="p-1 text-stone hover:text-ink disabled:opacity-30" disabled={i === list.length - 1} onClick={() => step(r.to, 1)} aria-label={`Move ${r.label} down`}><ArrowDown className="h-3.5 w-3.5" /></button>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
        {heads.length < 15 && (
          <button type="button" className="text-[13px] font-medium text-plum hover:underline"
            onClick={() => setHeads([...heads, { key: `s-${Date.now().toString(36)}`, label: 'New section' }])}>+ Add a section</button>
        )}
        <p className="text-[12px] text-stone">Click a heading or a tab’s name to rename it.</p>
      </div>
      {/* Live preview of the sidebar. */}
      <div aria-label="Preview" className="hidden self-start border border-line bg-sidebar p-2 md:block">
        <p className="px-2 pb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-stone">Preview</p>
        {heads.map((sec, k) => {
          const list = inSection(sec.key).filter((r) => !r.hidden);
          if (!list.length) return null;
          return (
            <div key={sec.key}>
              {k > 0 && <p className="px-2 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-[0.08em] text-stone">{sec.label}</p>}
              {list.map((r) => <p key={r.to} className="flex items-center gap-2 px-2 py-1 text-[13px] text-ink-soft"><r.icon className="h-3.5 w-3.5 text-stone" />{value.labels?.[r.to] ?? r.label}</p>)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Customize menu: each person's own sidebar. Nothing changes until Save; Cancel leaves it as it was; Restore defaults
 * goes back to their role's default menu.
 */
export function CustomizeMenuModal({ allowed, onClose }: { allowed: MenuItem[]; onClose: () => void }) {
  const { data: me } = useMe();
  const { groups, sections, defaults } = useMenuConfig();
  const { layout, loaded, save } = useSidebarLayout();
  const toast = useToast();
  const [draft, setDraft] = useState<SidebarLayout | null | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const d = defaults(me?.role);
  const current = draft === undefined ? layout : draft;
  const value: SidebarLayout = current ?? { order: d.order, hidden: d.hidden, sections: d.sections, sectionList: d.sectionList, labels: d.labels };
  // The salon owner (anyone who can edit settings) can make their menu everyone's starting menu.
  const owner = !!me?.permissions.includes('settings:write');
  const [asDefault, setAsDefault] = useState(false);
  const { data: settings } = useSettings();
  const qc = useQueryClient();
  const doSave = async () => {
    setSaving(true);
    try {
      if (draft !== undefined) await save(draft ?? null);
      if (owner && asDefault) {
        const w = settings?.settings.workspaces;
        const menu: SidebarDefaults = { order: value.order, hidden: value.hidden, required: [], sections: value.sections ?? {}, sectionList: value.sectionList, labels: value.labels };
        const r = await api.patch<{ settings: unknown }>('/settings', { workspaces: { ...(w ?? {}), menuDefaults: Object.fromEntries(ROLES.map((role) => [role, menu])) } });
        qc.setQueryData(['settings'], r);
      }
      toast(owner && asDefault ? 'Menu saved — now the default for everyone who hasn’t customized theirs' : 'Menu saved');
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal open wide onClose={onClose} title="Customize menu" footer={<>
      <Button variant="ghost" className="mr-auto" onClick={() => setDraft(null)}>Restore defaults</Button>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="primary" loading={saving} disabled={draft === undefined && !asDefault} onClick={doSave}>Save</Button>
    </>}>
      <p className="mb-4 text-[13px] text-stone">Show, hide, reorder and move your tabs between sections (drag them, use the arrows, or pick a section). Only for you, saved to your account. Tabs you don’t have access to aren’t listed; hiding a tab doesn’t remove your access to it, and your name at the bottom always opens your settings.</p>
      {loaded && <MenuEditor items={allowed} value={value} onChange={setDraft} groups={groups} sections={{ ...sections, ...(value.sections ?? {}) }} required={d.required} />}
      {draft === null && <p className="mt-3 text-[12px] text-stone">Back to the default menu — press Save to apply.</p>}
      {owner && (
        <label className="mt-4 flex items-start gap-2 border-t border-line pt-3 text-[14px] text-ink">
          <input type="checkbox" className="mt-1 h-4 w-4 accent-plum" checked={asDefault} onChange={(e) => setAsDefault(e.target.checked)} />
          <span>Make this the default for everyone<span className="block text-[13px] text-stone">Everyone who hasn’t rearranged their own menu gets this order, sections and hidden tabs (they still only see tabs they can open). Anyone who already customized keeps theirs.</span></span>
        </label>
      )}
    </Modal>
  );
}

/** Role names for the admin defaults. */
export const ROLE_OPTIONS = ROLES;

/** "Customize menu" link at the bottom of the sidebar. */
export function CustomizeMenuLink({ onClick }: { onClick: () => void }) {
  return <button type="button" onClick={onClick} className="mt-2 w-full rounded-lg px-3 py-1.5 text-left text-[12.5px] text-stone hover:bg-white/60 hover:text-ink">Customize menu</button>;
}
