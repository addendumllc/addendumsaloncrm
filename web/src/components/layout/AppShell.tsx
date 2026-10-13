import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowLeftRight, BarChart3, Bell, CalendarDays, CircleDollarSign, Package, CheckSquare, Home, ListTodo, LogOut, Menu as MenuIcon, MessageSquare, Plus, Settings, Sparkles, Users, Wallet, X,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useIntegrations, useMe, useCanDo } from '../../api/hooks';
import { relative } from '../../lib/format';
import { Menu, cx } from '../ui';
import { useActions } from '../domain/ActionsProvider';
import { BrandMark, useAppearance } from './Brand';
import { GlobalSearch } from './GlobalSearch';
import { Notifications, useUpdates } from './Notifications';
import { SETTINGS_PERMS } from '../../lib/access';

/** Sidebar items and the permissions that show them (any one). The server enforces the same rules on every request. */
export const NAV: { to: string; label: string; icon: typeof Home; end?: boolean; badge?: string; anyOf: string[] }[] = [
  { to: '/', label: 'Dashboard', icon: Home, end: true, anyOf: ['dashboard:view'] },
  { to: '/follow-ups', label: 'Follow-Ups', icon: CheckSquare, anyOf: ['tasks:read_all', 'tasks:read_own'] },
  { to: '/appointments', label: 'Appointments', icon: CalendarDays, anyOf: ['appointments:read', 'appointments:read_own'] },
  { to: '/messages', label: 'Messages', icon: MessageSquare, badge: 'messages', anyOf: ['messages:read'] },
  { to: '/clients', label: 'Clients', icon: Users, anyOf: ['clients:read', 'clients:read_assigned'] },
  { to: '/leads', label: 'New Clients', icon: Sparkles, anyOf: ['leads:read'] },
  { to: '/tasks', label: 'Tasks', icon: ListTodo, anyOf: ['tasks:read_all', 'tasks:read_own'] },
  { to: '/inventory', label: 'Order Hair', icon: Package, anyOf: ['inventory:order', 'inventory:read_all', 'inventory:view', 'inventory:manage'] },
  { to: '/inventory-sync', label: 'Inventory Sync', icon: ArrowLeftRight, anyOf: ['inventory:sync'] },
  { to: '/my-commission', label: 'My Commission', icon: Wallet, anyOf: ['commission:own'] },
  { to: '/commission', label: 'Team Commission', icon: CircleDollarSign, anyOf: ['commission:team', 'commission:approve'] },
  { to: '/analytics', label: 'Analytics', icon: BarChart3, anyOf: ['analytics:read'] },
  { to: '/settings', label: 'Settings', icon: Settings, anyOf: SETTINGS_PERMS },
];
const MOBILE_TABS = ['/', '/follow-ups', '/appointments', '/messages'];

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

  const can = (p?: string) => !p || !!me?.permissions.includes(p);
  const items = NAV.filter((n) => n.anyOf.some((p) => can(p)));
  const unread = updates?.unreadMessages ?? 0;
  // The inbox manages its own scrolling panes like a messaging app.
  const fullBleed = loc.pathname.startsWith('/messages');

  const signOut = async () => {
    await api.post('/auth/logout').catch(() => undefined);
    qc.clear();
    nav('/login');
  };

  const navList = (
    <nav className="flex flex-col gap-0.5">
      {items.map((n) => (
        <NavLink
          key={n.to}
          to={n.to}
          end={n.end}
          className={({ isActive }) => cx('flex items-center gap-3 rounded-lg px-3 py-2 text-[14.5px] transition-colors', isActive ? 'bg-white font-medium text-ink shadow-sm' : 'text-ink-soft hover:bg-white/60')}
        >
          <n.icon className="h-[18px] w-[18px] text-stone" />
          <span className="flex-1">{n.label}</span>
          {n.badge === 'messages' && unread > 0 && <span className="rounded-full bg-plum px-1.5 text-[11px] font-semibold leading-5 text-white num">{unread}</span>}
        </NavLink>
      ))}
    </nav>
  );

  const quick = (
    <Menu
      align="right"
      trigger={(open) => (
        <button onClick={open} className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-ink px-3.5 text-sm font-medium text-white hover:bg-ink-soft">
          <Plus className="h-4 w-4" /> <span className="hidden sm:inline">New</span>
        </button>
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
        <div className="mt-6 flex-1 overflow-y-auto">{navList}</div>
        <SidebarFooter name={me?.name} onSignOut={signOut} />
      </aside>

      {/* Mobile drawer */}
      {drawer && (
        <div className="fixed inset-0 z-50 bg-ink/30 lg:hidden" onClick={() => setDrawer(false)}>
          <aside className="flex h-full w-[260px] flex-col bg-paper px-3 py-5 animate-slide-in" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between pr-1"><Wordmark /><button onClick={() => setDrawer(false)} aria-label="Close menu"><X className="h-5 w-5 text-stone" /></button></div>
            <div className="mt-6 flex-1 overflow-y-auto">{navList}</div>
            <SidebarFooter name={me?.name} onSignOut={signOut} />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {integ?.demoMode && (
          <div className="flex items-center justify-center gap-2 bg-plum px-4 py-1.5 text-center text-[13px] text-white">
            <span className="font-semibold">Demo Mode</span>
            <span className="hidden text-white/80 sm:inline">Sample data from a simulated Square account — not live salon data.</span>
          </div>
        )}
        {integ?.square.needsReconnect && (
          <button onClick={() => (can('settings:read') ? nav('/settings?tab=square') : undefined)} className="bg-rose px-4 py-1.5 text-center text-[13px] text-white">Square connection expired. Please reconnect. Your existing data is safe.</button>
        )}
        <header className="flex items-center gap-2 border-b border-line bg-paper/90 px-3 py-2.5 backdrop-blur sm:gap-3 sm:px-6">
          <button className="rounded-lg p-2 text-ink-soft hover:bg-mist lg:hidden" onClick={() => setDrawer(true)} aria-label="Open menu"><MenuIcon className="h-5 w-5" /></button>
          <GlobalSearch />
          <SquarePill />
          <Notifications count={updates?.unreadNotifications ?? 0} />
          {quick}
        </header>
        {fullBleed ? (
          <main ref={mainRef} className="flex min-h-0 flex-1 flex-col overflow-hidden pb-[calc(3.6rem+env(safe-area-inset-bottom))] lg:pb-0">{children}</main>
        ) : (
          <main ref={mainRef} className="flex-1 overflow-y-auto pb-24 lg:pb-10">
            <div className="mx-auto w-full max-w-[1240px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{children}</div>
          </main>
        )}

        {/* Mobile tab bar */}
        <nav className="fixed inset-x-0 bottom-0 z-30 grid auto-cols-fr grid-flow-col border-t border-line bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
          {items.filter((n) => MOBILE_TABS.includes(n.to)).slice(0, 4).map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => cx('relative flex flex-col items-center gap-0.5 py-2 text-[11px]', isActive ? 'text-plum' : 'text-stone')}>
              <n.icon className="h-5 w-5" />
              {n.label}
              {n.badge && unread > 0 && <span className="absolute right-[22%] top-1 h-2 w-2 rounded-full bg-plum" />}
            </NavLink>
          ))}
          <button onClick={() => setDrawer(true)} className="flex flex-col items-center gap-0.5 py-2 text-[11px] text-stone"><MenuIcon className="h-5 w-5" />More</button>
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

export function SidebarFooter({ name, onSignOut }: { name?: string; onSignOut: () => void }) {
  return (
    <div className="mt-4 flex items-center justify-between border-t border-line px-3 pt-4 text-sm">
      <span className="truncate text-ink-soft">{name}</span>
      <button onClick={onSignOut} className="rounded p-1 text-stone hover:text-ink" title="Sign out" aria-label="Sign out"><LogOut className="h-4 w-4" /></button>
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
