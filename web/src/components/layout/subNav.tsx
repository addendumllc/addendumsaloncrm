import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import type { SharedSettings } from '@addendum/shared';
import { useSettings } from '../../api/hooks';
import type { StoreNames } from '../../lib/storeNames';

/**
 * Sub-menus shown under a sidebar item while you're in that section (Inventory, Follow-Ups, Analytics). Each entry is a
 * link with its own query (`?view=…`); `params` are the query keys that pick the section. Pages use the same list for the
 * section picker shown on phones, where the sidebar is tucked away.
 */
export type SubItem = { to: string; label: string | ((n: StoreNames) => string); anyOf?: string[]; group?: string };
export type SubNav = { params: string[]; items: SubItem[] };

export const SUB_NAV: Record<string, SubNav> = {
  // Inventory: like Tasks — the per-store pages start with Addendum Salon (Square) / Addendum Hair (Shopify).
  '/inventory-sync': {
    params: ['view'],
    items: [
      { to: '/inventory-sync', label: 'Inventory' },
      { to: '/inventory-sync?view=toorder', label: 'To order' },
      { to: '/inventory-sync?view=orders', label: 'Purchase orders' },
      { to: '/inventory-sync?view=stock', label: 'Stock counts / Reorder' },
      { to: '/inventory-sync?view=products', label: 'Products' },
      // Unit cost and each store's price (salon, stylist, retail), changed in one place.
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
      { to: '/messages?view=texting', label: 'Signature & texting', group: 'Default messages', anyOf: ['settings:read'] },
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
export function subActive(i: SubItem, nav: SubNav, pathname: string, search: string) {
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
export function SubNavList({ path, names, can: canDo }: { path: string; names: StoreNames; can: (p: string) => boolean }) {
  const can = useCanOrShared(canDo);
  const loc = useLocation();
  const sub = SUB_NAV[path];
  if (!sub || !(loc.pathname === path || loc.pathname.startsWith(`${path}/`))) return null;
  const subs = sub.items.filter((i) => !i.anyOf || i.anyOf.some(can));
  if (subs.length < 2) return null;
  return (
    <div className="mb-1 ml-[22px] border-l border-line pl-2">
      {subs.map((i, k) => (
        <div key={i.to}>
          {i.group && i.group !== subs[k - 1]?.group && <p className="px-2 pb-0.5 pt-2 text-[11px] font-semibold uppercase tracking-wide text-stone">{i.group}</p>}
          <NavLink to={i.to} end className={() => `block rounded-md px-2 py-1.5 text-[15px] lg:text-[13.5px] ${subActive(i, sub, loc.pathname, loc.search) ? 'bg-white font-medium text-ink shadow-sm' : 'text-ink-soft hover:bg-white/60'}`}>
            {subLabel(i, names)}
          </NavLink>
        </div>
      ))}
    </div>
  );
}
