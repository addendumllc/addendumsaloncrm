import { useEffect, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { ArrowDown, ArrowUp, ChevronDown } from 'lucide-react';
import { useSidebarLayout } from './sidebarLayout';
import type { SharedSettings } from '@addendum/shared';
import { useSettings } from '../../api/hooks';
import type { StoreNames } from '../../lib/storeNames';

/**
 * Sub-menus shown under a sidebar item while you're in that section (Inventory, Follow-Ups, Analytics). Each entry is a
 * link with its own query (`?view=…`); `params` are the query keys that pick the section. Pages use the same list for the
 * section picker shown on phones, where the sidebar is tucked away.
 */
/** `menu`: similar sub-tabs folded under one dropdown in the sidebar (e.g. Ordering, Products). */
/** `also`: other pages of this sub-tab (picked with a toggle on the page) — it's highlighted on those too. */
export type SubItem = { to: string; label: string | ((n: StoreNames) => string); anyOf?: string[]; group?: string; menu?: string; also?: string[] };
/** `collapsible`: clicking the parent tab while in the section opens or closes its sub-tabs (Inventory). */
export type SubNav = { params: string[]; items: SubItem[]; collapsible?: boolean };

export const SUB_NAV: Record<string, SubNav> = {
  // Inventory: its original sub-tabs, each opening its page (the store pages pick Addendum Salon / Addendum Hair on the
  // page: Square for the salon, Shopify for Addendum Hair). Clicking Inventory opens or closes them.
  '/inventory-sync': {
    params: ['view'],
    collapsible: true,
    items: [
      { to: '/inventory-sync', label: 'Inventory', also: ['/inventory-sync?view=items'] },
      { to: '/inventory-sync?view=reorder', label: 'To order', also: ['/inventory-sync?view=toorder', '/inventory-sync?view=preorders'] },
      { to: '/inventory-sync?view=orders', label: 'Purchase orders' },
      { to: '/inventory-sync?view=stock', label: 'Stock counts', also: ['/inventory-sync?view=activity'] },
      { to: '/inventory-sync?view=products', label: 'Products' },
      { to: '/inventory-sync?view=pricing', label: 'Pricing' },
      { to: '/inventory-sync?view=suppliers', label: 'Suppliers' },
      { to: '/inventory-sync?view=sync', label: 'Sync' },
    ],
  },
  // Tasks: each page starts with Addendum Salon / Addendum Hair.
  '/tasks': {
    params: ['view'],
    items: [
      { to: '/tasks', label: 'All tasks' },
      { to: '/tasks?view=todo', label: 'To do' },
      { to: '/tasks?view=followups', label: 'Follow-ups', anyOf: ['tasks:read_all', 'tasks:read_own', 'leads:read', 'hair:manage'] },
    ],
  },
  '/follow-ups': {
    params: ['view', 'due'],
    items: [
      { to: '/follow-ups', label: 'Due today' },
      { to: '/follow-ups?due=overdue', label: 'Overdue' },
      { to: '/follow-ups?due=upcoming', label: 'Upcoming' },
      { to: '/follow-ups?due=done', label: 'Completed' },
      { to: '/follow-ups?view=schedule', label: 'Rebooking schedule', anyOf: ['clients:read', 'clients:read_assigned'] },
    ],
  },
  '/my-commission': {
    params: ['view'],
    items: [
      { to: '/my-commission', label: 'Commission' },
      { to: '/my-commission?view=taxes', label: 'Taxes' },
      { to: '/my-commission?view=year', label: 'Year' },
    ],
  },
  '/commission': {
    params: ['tab'],
    items: [
      { to: '/commission', label: 'Team' },
      { to: '/commission?tab=review', label: 'Needs review', anyOf: ['commission:approve', 'commission:manage'] },
      { to: '/commission?tab=payroll', label: 'Payroll hours', anyOf: ['commission:team', 'commission:manage'] },
      { to: '/commission?tab=periods', label: 'Pay periods', anyOf: ['commission:approve', 'commission:team'] },
    ],
  },
  '/messages': {
    params: ['filter', 'view'],
    items: [
      { to: '/messages', label: 'All conversations', group: 'Inbox' },
      { to: '/messages?filter=unread', label: 'Unread', group: 'Inbox' },
      // The wording used for texts (also in Settings): saved replies, reminder and review texts, signature.
      // "shared:…": also shown when that settings section is shared with the team (Settings → Share with the team).
      { to: '/messages?view=replies', label: 'Saved replies', group: 'Default messages', anyOf: ['settings:read', 'shared:replies'] },
      { to: '/messages?view=reminders', label: 'Reminder & review texts', group: 'Default messages', anyOf: ['settings:read', 'shared:reminders'] },
    ],
  },
  '/clients': {
    params: ['section'],
    items: [
      // One list: Addendum Salon's or Addendum Hair's clients, chosen on the page. New-client inquiries are under Tasks.
      { to: '/clients', label: 'All clients', anyOf: ['clients:read', 'clients:read_assigned', 'hair:manage'] },
    ],
  },
  '/analytics': {
    params: ['scope'],
    items: [
      { to: '/analytics?scope=salon', label: (n) => n.square },
      { to: '/analytics?scope=online', label: (n) => `Online (${[n.shopify, n.shopify2].filter(Boolean).join(' + ')})` },
      { to: '/analytics', label: 'Both' },
    ],
  },
};

/** A permission check that also accepts "shared:<section>" when the salon shares that settings section with the team. */
function useCanOrShared(can: (p: string) => boolean) {
  const shared = useSettings().data?.settings.sharedSettings;
  return (p: string) => (p.startsWith('shared:') ? !!shared?.[p.slice(7) as keyof SharedSettings] : can(p));
}

export const subLabel = (i: SubItem, n: StoreNames) => (typeof i.label === 'function' ? i.label(n) : i.label);

/** Whether a sub-menu item is the one showing: same page, and the same value for each of the section's query keys. */
export function subActive(i: SubItem, nav: SubNav, pathname: string, search: string): boolean {
  if (i.also?.some((to) => subActive({ to, label: '' }, nav, pathname, search))) return true;
  const [path, query = ''] = i.to.split('?');
  if (path !== pathname) return false;
  const want = new URLSearchParams(query);
  const now = new URLSearchParams(search);
  return nav.params.every((k) => (want.get(k) ?? '') === (now.get(k) ?? ''));
}

/** On phones (no sidebar): a dropdown of the section's sub-menu, in place of the sidebar list. */
export function SectionPicker({ path, names, can: canDo, className }: { path: string; names: StoreNames; can: (p: string) => boolean; className?: string }) {
  const can = useCanOrShared(canDo);
  const nav = SUB_NAV[path];
  const loc = useLocation();
  const go = useNavigate();
  const items = nav.items.filter((i) => !i.anyOf || i.anyOf.some(can));
  const current = items.find((i) => subActive(i, nav, loc.pathname, loc.search)) ?? items[0];
  if (items.length < 2) return null;
  return (
    <select className={`field h-11 w-full text-[16px] font-medium lg:hidden ${className ?? ''}`} value={current.to} onChange={(e) => go(e.target.value)} aria-label="Section">
      {items.map((i) => <option key={i.to} value={i.to}>{subLabel(i, names)}</option>)}
    </select>
  );
}

/** The sub-menu under a sidebar item, while you're in that section (both sidebars use it). Nothing when there's only one part. */
/**
 * The sub-menu under a sidebar item, while you're in that section (both sidebars use it). Similar sub-tabs fold under a
 * dropdown; each person can reorder the sub-tabs (Reorder, at the bottom — saved to their account).
 */
/** Sections the person has closed (collapsible ones only), remembered on this device. */
const COLLAPSED_KEY = 'addendum:nav-collapsed';
const collapsedListeners = new Set<() => void>();
const readCollapsed = (): string[] => { try { return JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]'); } catch { return []; } };
export function setSectionCollapsed(path: string, collapsed: boolean) {
  const cur = new Set(readCollapsed());
  if (collapsed) cur.add(path); else cur.delete(path);
  try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...cur])); } catch { /* private window */ }
  collapsedListeners.forEach((f) => f());
}
export function useSectionCollapsed(path: string) {
  const [, bump] = useState(0);
  useEffect(() => { const f = () => bump((n) => n + 1); collapsedListeners.add(f); return () => { collapsedListeners.delete(f); }; }, []);
  return readCollapsed().includes(path);
}

export function SubNavList({ path, names, can: canDo }: { path: string; names: StoreNames; can: (p: string) => boolean }) {
  const can = useCanOrShared(canDo);
  const loc = useLocation();
  const collapsed = useSectionCollapsed(path);
  const { layout, save } = useSidebarLayout();
  const [reordering, setReordering] = useState(false);
  const [openMenus, setOpenMenus] = useState<Record<string, boolean>>({});
  const sub = SUB_NAV[path];
  if (!sub || !(loc.pathname === path || loc.pathname.startsWith(`${path}/`))) return null;
  if (sub.collapsible && collapsed) return null;
  const allowed = sub.items.filter((i) => !i.anyOf || i.anyOf.some(can));
  if (allowed.length < 2) return null;
  // Their order (new sub-tabs keep their built-in place).
  const saved = layout?.subOrder?.[path] ?? [];
  const pos = (to: string) => { const i = saved.indexOf(to); return i < 0 ? 100 + allowed.findIndex((x) => x.to === to) : i; };
  const subs = [...allowed].sort((a, b) => pos(a.to) - pos(b.to));
  const active = (i: SubItem) => subActive(i, sub, loc.pathname, loc.search);
  const link = (i: SubItem, indent = false) => (
    <NavLink key={i.to} to={i.to} end className={() => `block rounded-md px-2 py-1.5 text-[15px] lg:text-[13.5px] ${indent ? 'ml-3' : ''} ${active(i) ? 'bg-white font-medium text-ink shadow-sm' : 'text-ink-soft hover:bg-white/60'}`}>
      {subLabel(i, names)}
    </NavLink>
  );
  const move = (to: string, d: -1 | 1) => {
    const order = subs.map((x) => x.to);
    const i = order.indexOf(to);
    if (i + d < 0 || i + d >= order.length) return;
    [order[i], order[i + d]] = [order[i + d], order[i]];
    void save({ ...(layout ?? { order: [], hidden: [] }), subOrder: { ...(layout?.subOrder ?? {}), [path]: order } });
  };
  if (reordering) {
    return (
      <div className="mb-1 ml-[22px] border-l border-line pl-2">
        {subs.map((i, k) => (
          <div key={i.to} className="flex items-center gap-1 px-1 py-1 text-[13.5px] text-ink-soft">
            <span className="min-w-0 flex-1 truncate">{subLabel(i, names)}{i.menu && <span className="text-[11px] text-stone"> · {i.menu}</span>}</span>
            <button type="button" className="p-0.5 text-stone hover:text-ink disabled:opacity-30" disabled={k === 0} onClick={() => move(i.to, -1)} aria-label={`Move ${subLabel(i, names)} up`}><ArrowUp className="h-3.5 w-3.5" /></button>
            <button type="button" className="p-0.5 text-stone hover:text-ink disabled:opacity-30" disabled={k === subs.length - 1} onClick={() => move(i.to, 1)} aria-label={`Move ${subLabel(i, names)} down`}><ArrowDown className="h-3.5 w-3.5" /></button>
          </div>
        ))}
        <div className="flex gap-3 px-2 pt-1 text-[12px]">
          <button type="button" className="font-medium text-plum hover:underline" onClick={() => setReordering(false)}>Done</button>
          {saved.length > 0 && <button type="button" className="text-stone hover:text-ink" onClick={() => { const next = { ...(layout?.subOrder ?? {}) }; delete next[path]; void save({ ...(layout ?? { order: [], hidden: [] }), subOrder: next }); }}>Reset</button>}
        </div>
      </div>
    );
  }
  // A dropdown shows where its first sub-tab is, with all of its sub-tabs; open while one of them is showing.
  const shownMenus = new Set<string>();
  return (
    <div className="mb-1 ml-[22px] border-l border-line pl-2">
      {subs.map((i, k) => {
        if (!i.menu) return (
          <div key={i.to}>
            {i.group && i.group !== subs[k - 1]?.group && <p className="px-2 pb-0.5 pt-2 text-[11px] font-semibold uppercase tracking-wide text-stone">{i.group}</p>}
            {link(i)}
          </div>
        );
        if (shownMenus.has(i.menu)) return null;
        shownMenus.add(i.menu);
        const members = subs.filter((x) => x.menu === i.menu);
        const isActive = members.some(active);
        const open = openMenus[i.menu] ?? isActive;
        return (
          <div key={`menu-${i.menu}`}>
            <button type="button" onClick={() => setOpenMenus((m) => ({ ...m, [i.menu!]: !open }))} aria-expanded={open}
              className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[15px] lg:text-[13.5px] ${isActive && !open ? 'bg-white font-medium text-ink shadow-sm' : 'text-ink-soft hover:bg-white/60'}`}>
              {i.menu}<ChevronDown className={`h-3.5 w-3.5 text-stone transition-transform ${open ? 'rotate-180' : ''}`} />
            </button>
            {open && members.map((m) => link(m, true))}
          </div>
        );
      })}
      <button type="button" className="px-2 pt-1 text-[11px] text-stone hover:text-ink" onClick={() => setReordering(true)}>Reorder</button>
    </div>
  );
}
