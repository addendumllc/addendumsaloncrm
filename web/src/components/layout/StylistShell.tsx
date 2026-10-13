import type { ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { CalendarDays, CheckSquare, LogOut, Package, Users, Wallet } from 'lucide-react';
import { api } from '../../api/client';
import { useMe } from '../../api/hooks';
import { cx } from '../ui';
import { SidebarFooter, Wordmark } from './AppShell';

/**
 * The simplified layout for people without the dashboard (stylists by default): only the sections their permissions
 * open — My Calendar, Order Hair, My Commission, and anything an administrator has granted them.
 */
const ALL = [
  { to: '/my-calendar', label: 'My Calendar', icon: CalendarDays, anyOf: ['appointments:read_own', 'appointments:read'] },
  { to: '/inventory', label: 'Order Hair', icon: Package, anyOf: ['inventory:order', 'inventory:view', 'inventory:read_all'] },
  { to: '/my-commission', label: 'My Commission', icon: Wallet, anyOf: ['commission:own'] },
  { to: '/follow-ups', label: 'Follow-Ups', icon: CheckSquare, anyOf: ['tasks:read_own', 'tasks:read_all'] },
  { to: '/clients', label: 'My Clients', icon: Users, anyOf: ['clients:read', 'clients:read_assigned'] },
];

export function StylistShell({ children }: { children: ReactNode }) {
  const { data: me } = useMe();
  const NAV = ALL.filter((n) => n.anyOf.some((p) => me?.permissions.includes(p)));
  const nav = useNavigate();
  const qc = useQueryClient();
  const signOut = async () => {
    await api.post('/auth/logout').catch(() => undefined);
    qc.clear();
    nav('/login');
  };
  const link = ({ isActive }: { isActive: boolean }) =>
    cx('flex items-center gap-3 rounded-lg px-3 py-2 text-[14.5px] transition-colors', isActive ? 'bg-white font-medium text-ink shadow-sm' : 'text-ink-soft hover:bg-white/60');

  return (
    <div className="flex h-[100dvh] overflow-hidden">
      <aside className="hidden w-[232px] shrink-0 flex-col border-r border-line bg-mist/70 px-3 py-5 lg:flex">
        <Wordmark />
        <nav className="mt-6 flex flex-1 flex-col gap-0.5">
          {NAV.map((n) => <NavLink key={n.to} to={n.to} className={link}><n.icon className="h-[18px] w-[18px] text-stone" />{n.label}</NavLink>)}
        </nav>
        <SidebarFooter name={me?.name} onSignOut={signOut} />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-line bg-paper/90 px-4 py-3 lg:hidden">
          <p className="font-display text-[22px] font-semibold leading-none text-ink">Addendum</p>
          <button onClick={signOut} className="inline-flex items-center gap-1.5 rounded-lg p-1.5 text-sm text-stone hover:text-ink" aria-label="Sign out"><LogOut className="h-4 w-4" /><span>Sign out</span></button>
        </header>
        <main className="flex-1 overflow-y-auto pb-24 lg:pb-10">
          <div className="mx-auto w-full max-w-[1000px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{children}</div>
        </main>
        <nav className="fixed inset-x-0 bottom-0 z-30 grid auto-cols-fr grid-flow-col border-t border-line bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} className={({ isActive }) => cx('flex flex-col items-center gap-0.5 py-2 text-[11px]', isActive ? 'text-plum' : 'text-stone')}>
              <n.icon className="h-5 w-5" />{n.label}
            </NavLink>
          ))}
        </nav>
      </div>
    </div>
  );
}
