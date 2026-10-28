import { useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Camera, CalendarDays, CheckSquare, ListTodo, LogOut, Megaphone, Package, Settings, Timer, Users, Wallet } from 'lucide-react';
import { api } from '../../api/client';
import { pathInAwaySections } from '@addendum/shared';
import { useMe } from '../../api/hooks';
import { useAccessStatus } from './NetworkBlocked';
import { cx } from '../ui';
import { SidebarFooter, Wordmark } from './AppShell';
import { BrandMark, useAppearance } from './Brand';
import { Notifications, useUpdates } from './Notifications';
import { SubNavList } from './subNav';
import { CustomizeMenuModal, useMenu } from './sidebarLayout';
import { useStoreNames } from '../../lib/storeNames';

/**
 * The simplified layout for people without the dashboard (stylists by default): only the sections their permissions
 * open — My Calendar, Order Hair, My Commission, and anything an administrator has granted them.
 */
// Same order and labels as the full sidebar.
const ALL = [
  { to: '/time-clock', label: 'Time Clock', icon: Timer, anyOf: ['timeclock:use'] },
  { to: '/follow-ups', label: 'Follow-Ups', icon: CheckSquare, anyOf: ['tasks:read_own', 'tasks:read_all'] },
  { to: '/announcements', label: 'Announcements', icon: Megaphone, anyOf: ['announcements:read', 'announcements:publish', 'announcements:manage'] },
  { to: '/tasks', label: 'Tasks', icon: ListTodo, anyOf: ['tasks:read_own', 'tasks:read_all', 'hair:manage'] },
  { to: '/my-calendar', label: 'Appointments', icon: CalendarDays, anyOf: ['appointments:read_own', 'appointments:read'] },
  { to: '/clients', label: 'Clients', icon: Users, anyOf: ['clients:read', 'clients:read_assigned', 'leads:read', 'hair:manage'] },
  { to: '/inventory', label: 'Order Hair', icon: Package, anyOf: ['inventory:order', 'inventory:view', 'inventory:read_all'] },
  { to: '/my-commission', label: 'Earnings & Goals', short: 'Earnings', icon: Wallet, anyOf: ['commission:own'] },
  { to: '/transformations', label: 'Transformations', short: 'Work', icon: Camera, anyOf: ['transformations:own', 'transformations:view_all', 'transformations:manage'] },
  { to: '/settings', label: 'Settings', icon: Settings, anyOf: [''] },
];

export function StylistShell({ children }: { children: ReactNode }) {
  const { data: me } = useMe();
  const names = useStoreNames();
  const appearance = useAppearance();
  const { data: access } = useAccessStatus();
  // Their own notifications (e.g. a task someone sent them).
  const updates = useUpdates();
  // Away from the salon with chosen sections: just those.
  const allowed = ALL.filter((n) => n.anyOf.some((p) => !p || me?.permissions.includes(p)) && (!access?.limited || pathInAwaySections(n.to, access.limited)));
  // Shared tabs, then the active business's own; this person's order and hidden tabs (Customize menu).
  const menuData = useMenu(allowed);
  const [customizing, setCustomizing] = useState(false);
  const NAV = menuData.visible;
  const nav = useNavigate();
  const qc = useQueryClient();
  const signOut = async () => {
    await api.post('/auth/logout').catch(() => undefined);
    qc.clear();
    nav('/login');
  };
  const link = ({ isActive }: { isActive: boolean }) =>
    cx('flex items-center gap-3 rounded-lg px-3 py-2 text-[14.5px] transition-colors', isActive ? 'bg-white font-medium text-ink shadow-sm' : 'text-ink-soft hover:bg-white/60');

  const item = (n: (typeof NAV)[number]) => (
    <div key={n.to}>
      <NavLink to={n.to} className={link}><n.icon className="h-[18px] w-[18px] text-stone" />{n.label}</NavLink>
      <SubNavList path={n.to} names={names} can={(p) => !!me?.permissions.includes(p)} />
    </div>
  );
  return (
    <div className="flex h-[100dvh] overflow-hidden">
      <aside className="hidden w-[232px] shrink-0 flex-col border-r border-line bg-sidebar px-3 py-5 lg:flex">
        <div className="flex items-start justify-between gap-2"><Wordmark /><Notifications count={updates?.unreadNotifications ?? 0} /></div>
        <nav className="mt-6 flex flex-1 flex-col gap-0.5 overflow-y-auto font-nav">
          {menuData.bySection.map((sec, k) => (
            <div key={sec.key} className={k > 0 ? 'mt-2.5 border-t border-line/70 pt-2' : ''}>
              {(k > 0 || sec.renamed) && <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-stone">{sec.label}</p>}
              {sec.items.map(item)}
            </div>
          ))}
        </nav>
        {customizing && <CustomizeMenuModal allowed={allowed} onClose={() => setCustomizing(false)} />}
        <SidebarFooter name={me?.name} onSignOut={signOut} onCustomize={() => setCustomizing(true)} />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-line bg-paper px-4 py-3 lg:hidden">
          <BrandMark a={appearance} size="header" />
          <span className="ml-auto mr-1 flex items-center"><Notifications count={updates?.unreadNotifications ?? 0} /></span>
          <button onClick={signOut} className="inline-flex items-center gap-1.5 rounded-lg p-1.5 text-sm text-stone hover:text-ink" aria-label="Sign out"><LogOut className="h-4 w-4" /><span>Sign out</span></button>
        </header>
        <main className="flex-1 overflow-y-auto overflow-x-hidden overscroll-x-none pb-24 lg:pb-10">
          <div className="app-content mx-auto w-full max-w-[1000px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{children}</div>
        </main>
        <nav className="fixed inset-x-0 bottom-0 z-30 grid auto-cols-fr grid-flow-col border-t border-line bg-white pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} className={({ isActive }) => cx('flex flex-col items-center gap-0.5 py-2 text-[11px]', isActive ? 'text-plum' : 'text-stone')}>
              <n.icon className="h-5 w-5" />{'short' in n ? n.short : n.label}
            </NavLink>
          ))}
        </nav>
      </div>
    </div>
  );
}
