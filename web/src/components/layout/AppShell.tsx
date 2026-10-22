import { useEffect, useRef, useState, type ReactNode } from 'react';
import { pathInAwaySections } from '@addendum/shared';
import { useAccessStatus } from './NetworkBlocked';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowLeftRight, BarChart3, Timer, Bell, CalendarDays, CircleDollarSign, Package, CheckSquare, Home, ListTodo, LogOut, Menu as MenuIcon, MessageSquare, Plus, Settings, Sparkles, Users, Wallet, X,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useIntegrations, useMe, useCanDo } from '../../api/hooks';
import { relative } from '../../lib/format';
import { Button, Menu, cx } from '../ui';
import { useActions } from '../domain/ActionsProvider';
import { BrandMark, useAppearance } from './Brand';
import { GlobalSearch } from './GlobalSearch';
import { SystemBanner } from './SystemBanner';
import { SubNavList } from './subNav';
import { CustomizeMenuLink, CustomizeMenuModal, useMenu } from './sidebarLayout';
import { useStoreNames } from '../../lib/storeNames';
import { Notifications, useUpdates } from './Notifications';

/** Sidebar items and the permissions that show them (any one). The server enforces the same rules on every request. */
export const NAV: { to: string; label: string; icon: typeof Home; end?: boolean; badge?: string; anyOf: string[]; hideIf?: string }[] = [
  // The order and labels the salon asked for. Each item shows only with one of its permissions; pages and the API check too.
  { to: '/', label: 'Dashboard', icon: Home, end: true, anyOf: ['dashboard:view'] },
  { to: '/time-clock', label: 'Time Clock', icon: Timer, anyOf: ['timeclock:use'] },
  { to: '/follow-ups', label: 'Follow-Ups', icon: CheckSquare, anyOf: ['tasks:read_all', 'tasks:read_own'] },
  // Salon tasks and Addendum Hair's tasks (both internal), each in the sub-menu.
  { to: '/tasks', label: 'Tasks', icon: ListTodo, anyOf: ['tasks:read_all', 'tasks:read_own', 'hair:manage'] },
  { to: '/appointments', label: 'Appointments', icon: CalendarDays, anyOf: ['appointments:read'] },
  // Only their own calendar (assistants by default, until an Owner/Admin allows team calendars).
  { to: '/my-calendar', label: 'Appointments', icon: CalendarDays, anyOf: ['appointments:read_own'], hideIf: 'appointments:read' },
  { to: '/messages', label: 'Messages', icon: MessageSquare, badge: 'messages', anyOf: ['messages:read'] },
  // Clients and new-client inquiries (formerly a separate "New Clients" tab) in one place.
  // Clients for both businesses: Addendum Salon / Addendum Hair at the top of the page.
  { to: '/clients', label: 'Clients', icon: Users, anyOf: ['clients:read', 'clients:read_assigned', 'leads:read', 'hair:manage'] },
  { to: '/inventory', label: 'Order Hair', icon: Package, anyOf: ['inventory:order', 'inventory:read_all', 'inventory:view', 'inventory:manage'] },
  { to: '/inventory-sync', label: 'Inventory', icon: ArrowLeftRight, anyOf: ['inventory:sync'] },
  { to: '/my-commission', label: 'Earnings & Goals', icon: Wallet, anyOf: ['commission:own'] },
  { to: '/commission', label: 'Team Payroll', icon: CircleDollarSign, anyOf: ['commission:team', 'commission:approve'] },
  { to: '/analytics', label: 'Analytics', icon: BarChart3, anyOf: ['analytics:read', 'revenue:projections'] },
  // Everyone ('' = no permission needed): their own profile, display and password, plus the salon settings they're allowed.
  { to: '/settings', label: 'Settings', icon: Settings, anyOf: [''] },
];
/** Phone tab bar: the first four of these the person can open (by role); everything else is under More. */
const MOBILE_TABS = ['/', '/time-clock', '/follow-ups', '/appointments', '/my-calendar', '/messages', '/clients', '/tasks', '/inventory', '/my-commission'];

export function AppShell({ children }: { children: ReactNode }) {
  const { data: me } = useMe();
  const { data: integ } = useIntegrations();
  const updates = useUpdates();
  const actions = useActions();
  const nav = useNavigate();
  const loc = useLocation();
  const qc = useQueryClient();
  const [drawer, setDrawer] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => {
    setDrawer(false);
    mainRef.current?.scrollTo?.(0, 0);
  }, [loc.pathname]);
  // Picking a sub-menu item (same page, new section) closes the phone menu too.
  useEffect(() => setDrawer(false), [loc.search]);
  const names = useStoreNames();

  const can = (p?: string) => !p || !!me?.permissions.includes(p);
  const { data: access } = useAccessStatus();
  // Away from the salon with chosen sections: just those in the menu.
  const allowed = NAV.filter((n) => n.anyOf.some((p) => can(p)) && !(n.hideIf && can(n.hideIf)) && (!access?.limited || pathInAwaySections(n.to, access.limited)));
  // Daily work, Operations, Addendum Hair, Business, Administration; this person's order and hidden tabs (Customize menu).
  const menuData = useMenu(allowed);
  const [customizing, setCustomizing] = useState(false);
  const items = menuData.visible;
  const unread = updates?.unreadMessages ?? 0;
  // The inbox manages its own scrolling panes like a messaging app.
  const fullBleed = loc.pathname.startsWith('/messages');

  const signOut = async () => {
    await api.post('/auth/logout').catch(() => undefined);
    qc.clear();
    nav('/login');
  };

  const link = (n: (typeof items)[number]) => (
    <div key={n.to}>
      <NavLink
        to={n.to}
        end={n.end}
        className={({ isActive }) => cx('relative flex min-h-[48px] items-center gap-3 rounded-lg px-3 py-2 text-[16px] transition-colors lg:min-h-0 lg:text-[14.5px]', isActive ? 'bg-white font-medium text-ink shadow-sm' : 'text-ink-soft hover:bg-white/60')}
      >
        <n.icon className="h-[18px] w-[18px] text-stone" />
        <span className="flex-1">{n.label}</span>
        {n.badge === 'messages' && unread > 0 && <span className="rounded-full bg-plum px-1.5 text-[11px] font-semibold leading-5 text-white num">{unread}</span>}
      </NavLink>
      {/* While in a section with a sub-menu, its parts are listed underneath. */}
      <SubNavList path={n.to} names={names} can={(p) => can(p)} />
    </div>
  );
  // Sections with subtle labels (the first, daily work, needs none); Administration sits at the bottom.
  const navList = (
    <nav className="flex flex-col gap-0.5 font-nav">
      {menuData.bySection.map((sec, k) => (
        <div key={sec.key} className={k > 0 ? 'mt-2.5 border-t border-line/70 pt-2' : ''}>
          {(k > 0 || sec.renamed) && <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-stone">{sec.label}</p>}
          {sec.items.map(link)}
        </div>
      ))}
    </nav>
  );
  const menu = navList;

  const quick = (
    <Menu
      align="right"
      trigger={(open) => (
        <Button variant="primary" onClick={open} icon={<Plus className="h-4 w-4" />} aria-label="New"><span className="hidden sm:inline">New</span></Button>
      )}
      items={[
        { label: 'New lead', onClick: actions.newLead, hidden: !can('leads:write') },
        { label: 'Add client', onClick: actions.addClient, hidden: !can('clients:write') },
        { label: 'Follow-up', onClick: () => actions.newFollowUp(), hidden: !can('tasks:write') },
        { label: 'Send message', onClick: () => nav('/messages?compose=1'), hidden: !can('messages:send') },
        { label: 'Order hair', onClick: () => nav('/inventory?new=1'), hidden: !can('inventory:order') },
        { label: "View today's appointments", onClick: () => nav('/appointments?view=day'), hidden: !can('appointments:read') && !can('appointments:read_own') },
        { label: 'View overdue follow-ups', onClick: () => nav('/follow-ups?due=overdue'), hidden: !can('tasks:read_all') && !can('tasks:read_own') },
      ]}
    />
  );

  return (
    <div className="flex h-[100dvh] overflow-hidden">
      {/* Desktop sidebar */}
      <aside className="hidden w-[232px] shrink-0 flex-col border-r border-line bg-sidebar px-3 py-5 lg:flex">
        <Wordmark />
        <div className="mt-6 flex-1 overflow-y-auto">{menu}</div>
        <SidebarFooter name={me?.name} onSignOut={signOut} onCustomize={() => setCustomizing(true)} />
      </aside>
      {customizing && <CustomizeMenuModal allowed={allowed} onClose={() => setCustomizing(false)} />}

      {/* Mobile drawer */}
      {drawer && (
        <div className="fixed inset-0 z-50 bg-ink/30 lg:hidden" onClick={() => setDrawer(false)}>
          <aside className="flex h-full w-[260px] flex-col bg-paper px-3 py-5 animate-slide-in" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between pr-1"><Wordmark /><button onClick={() => setDrawer(false)} aria-label="Close menu"><X className="h-5 w-5 text-stone" /></button></div>
            <div className="mt-6 flex-1 overflow-y-auto">{menu}</div>
            <SidebarFooter name={me?.name} onSignOut={signOut} onCustomize={() => setCustomizing(true)} />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {integ?.demoMode && (
          <div className="flex items-center justify-center gap-2 bg-[#2B2724] px-4 py-1.5 text-center text-[13px] text-[#F7F5F2]">
            <span className="font-semibold">Demo Mode</span>
            <span className="hidden opacity-80 sm:inline">Sample data from a simulated Square account — not live salon data.</span>
          </div>
        )}
        <SystemBanner />
        {integ?.square.needsReconnect && (
          <button onClick={() => (can('settings:read') ? nav('/settings?tab=square') : undefined)} className="bg-rose px-4 py-1.5 text-center text-[13px] text-white">Square connection expired. Please reconnect. Your existing data is safe.</button>
        )}
        <header className="relative z-30 flex items-center gap-2 border-b border-line bg-paper px-3 py-2.5 sm:gap-3 sm:px-6">
          <button className="rounded-lg p-2 text-ink-soft hover:bg-mist lg:hidden" onClick={() => setDrawer(true)} aria-label="Open menu"><MenuIcon className="h-5 w-5" /></button>
          <GlobalSearch />
          <SquarePill />
          <Notifications count={updates?.unreadNotifications ?? 0} />
          {quick}
        </header>
        {fullBleed ? (
          <main ref={mainRef} className="flex min-h-0 flex-1 flex-col overflow-hidden pb-[calc(3.6rem+env(safe-area-inset-bottom))] lg:pb-0">{children}</main>
        ) : (
          <main ref={mainRef} className="flex-1 overflow-y-auto overflow-x-hidden overscroll-x-none pb-24 lg:pb-10">
            <div className="app-content mx-auto w-full max-w-[1240px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{children}</div>
          </main>
        )}

        {/* Mobile tab bar */}
        <nav className="fixed inset-x-0 bottom-0 z-30 grid auto-cols-fr grid-flow-col border-t border-line bg-white pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
          {MOBILE_TABS.map((to) => items.find((n) => n.to === to)).filter((n): n is (typeof items)[number] => !!n).slice(0, 4).map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => cx('relative flex min-h-[56px] flex-col items-center justify-center gap-0.5 py-2 text-[12px]', isActive ? 'text-plum' : 'text-stone')}>
              <n.icon className="h-5 w-5" />
              {n.label}
              {n.badge && unread > 0 && <span className="absolute right-[22%] top-1 h-2 w-2 rounded-full bg-plum" />}
            </NavLink>
          ))}
          <button onClick={() => setDrawer(true)} className="flex min-h-[56px] flex-col items-center justify-center gap-0.5 py-2 text-[12px] text-stone"><MenuIcon className="h-5 w-5" />More</button>
        </nav>
      </div>
    </div>
  );
}

export function Wordmark() {
  const a = useAppearance();
  return (
    <div className="px-3">
      <BrandMark a={a} size="sidebar" />
      {a.tagline && <p className="mt-1 text-[12px] text-stone">{a.tagline}</p>}
    </div>
  );
}

/** The very bottom: Customize menu, then their name (opens their settings) and sign out. */
export function SidebarFooter({ name, onSignOut, onCustomize }: { name?: string; onSignOut: () => void; onCustomize?: () => void }) {
  return (
    <div className="mt-4 border-t border-line pt-2">
    {onCustomize && <CustomizeMenuLink onClick={onCustomize} />}
    <div className="mt-1 flex items-center justify-between gap-1 px-3 pt-1 text-sm">
      <NavLink to="/settings?tab=profile" className="flex-1 truncate text-ink-soft hover:text-ink" title="Your settings">{name}</NavLink>
      <button onClick={onSignOut} className="rounded p-2 text-stone hover:text-ink lg:p-1" title="Sign out" aria-label="Sign out"><LogOut className="h-4 w-4" /></button>
    </div>
    </div>
  );
}

function SquarePill() {
  const { data } = useIntegrations();
  const nav = useNavigate();
  const canDo = useCanDo();
  if (!data) return null;
  const toSettings = canDo('settings:read') ? () => nav('/settings?tab=square') : undefined;
  const sq = data.square;
  const ok = sq.connected && sq.lastSyncStatus !== 'failed';
  return (
    <button onClick={toSettings} disabled={!toSettings} className="hidden items-center gap-2 rounded-full border border-line bg-white px-3 py-1.5 text-[13px] text-ink-soft enabled:hover:border-line-strong md:inline-flex" title={sq.lastSyncMessage ?? ''}>
      <span className={cx('h-2 w-2 rounded-full', ok ? 'bg-sage' : sq.connected ? 'bg-amber' : 'bg-rose')} />
      {sq.connected ? <>Square {ok ? '✓' : ''} <span className="text-stone">· synced {relative(sq.lastSyncAt)}</span></> : 'Square not connected'}
    </button>
  );
}

export { Bell };
