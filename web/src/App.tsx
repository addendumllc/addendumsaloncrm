import { Suspense, lazy, useEffect, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useMe, useSettings } from './api/hooks';
import { setTimezone } from './lib/format';
import { applyAppearance } from './lib/theme';
import { AppShell } from './components/layout/AppShell';
import { StylistShell } from './components/layout/StylistShell';
import { NetworkBlocked, useAccessStatus } from './components/layout/NetworkBlocked';
import { ActionsProvider } from './components/domain/ActionsProvider';
import { EmptyState, PageLoading } from './components/ui';
import { ShieldOff } from 'lucide-react';
import { LoginPage } from './pages/Login';
const OnboardingPage = lazy(() => import('./pages/Onboarding').then((m) => ({ default: m.OnboardingPage })));
import { DashboardPage } from './pages/Dashboard';
import { FollowUpsPage } from './pages/FollowUps';
import { TasksPage } from './pages/Tasks';
import { AppointmentsPage } from './pages/Appointments';
import { ClientsPage } from './pages/Clients';
import { ClientProfilePage } from './pages/ClientProfile';
import { LeadsPage } from './pages/Leads';
import { MessagesPage } from './pages/Messages';
const AnalyticsPage = lazy(() => import('./pages/Analytics').then((m) => ({ default: m.AnalyticsPage })));
const InventoryPage = lazy(() => import('./pages/Inventory').then((m) => ({ default: m.InventoryPage })));
const SettingsPage = lazy(() => import('./pages/Settings').then((m) => ({ default: m.SettingsPage })));
const MyCalendarPage = lazy(() => import('./pages/MyCalendar').then((m) => ({ default: m.MyCalendarPage })));
const InventorySyncPage = lazy(() => import('./pages/InventorySync').then((m) => ({ default: m.InventorySyncPage })));
const MyCommissionPage = lazy(() => import('./pages/Commission').then((m) => ({ default: m.MyCommissionPage })));
const TeamCommissionPage = lazy(() => import('./pages/Commission').then((m) => ({ default: m.TeamCommissionPage })));
import { ResetPasswordPage } from './pages/ResetPassword';
import { SETTINGS_PERMS } from './lib/access';

export function App() {
  const { data: me, isLoading, isError } = useMe();
  const nav = useNavigate();
  const loc = useLocation();
  const qc = useQueryClient();

  useEffect(() => {
    const out = () => {
      qc.clear();
      if (!loc.pathname.startsWith('/login')) nav('/login');
    };
    // A refused request may mean the role changed: re-check who's signed in so the right screens show.
    const recheck = () => void qc.invalidateQueries({ queryKey: ['me'] });
    window.addEventListener('addendum:signed-out', out);
    window.addEventListener('addendum:forbidden', recheck);
    return () => {
      window.removeEventListener('addendum:signed-out', out);
      window.removeEventListener('addendum:forbidden', recheck);
    };
  }, [nav, loc.pathname, qc]);

  // Password set-up / reset links work whether or not someone is signed in on this device.
  if (loc.pathname === '/reset-password') return <ResetPasswordPage />;
  if (isLoading) return <div className="flex h-screen items-center justify-center"><PageLoading /></div>;
  if (isError || !me) {
    return (
      <Routes>
        <Route path="*" element={<LoginPage />} />
      </Routes>
    );
  }
  return <SignedIn />;
}

function SignedIn() {
  const { data: settings } = useSettings();
  const { data: me } = useMe();
  const { data: access } = useAccessStatus();
  const loc = useLocation();
  useEffect(() => {
    if (settings?.settings.business?.timezone) setTimezone(settings.settings.business.timezone);
    if (settings) applyAppearance(settings.settings.appearance);
  }, [settings]);
  if (!settings) return <div className="flex h-screen items-center justify-center"><PageLoading /></div>;
  // Not on the salon network on a computer (Location & Access): the server refuses everything, so say why.
  if (access?.restricted) return <NetworkBlocked status={access} />;
  // Each page opens for the permissions listed (any one). The server checks every request as well.
  const can = (p: string) => !!me && me.permissions.includes(p);
  const canAny = (...ps: string[]) => ps.some(can);
  const guard = (anyOf: string[], page: ReactNode) => (canAny(...anyOf) ? page : <NoAccess />);
  const routes = (home: string) => (
    <Routes>
      <Route path="/" element={canAny('dashboard:view') ? <DashboardPage /> : <Navigate to={home} replace />} />
      <Route path="/follow-ups" element={guard(['tasks:read_all', 'tasks:read_own'], <FollowUpsPage />)} />
      <Route path="/tasks" element={guard(['tasks:read_all', 'tasks:read_own'], <TasksPage />)} />
      <Route path="/appointments" element={!can('appointments:read') && can('appointments:read_own') ? <Navigate to="/my-calendar" replace /> : guard(['appointments:read'], <AppointmentsPage />)} />
      <Route path="/my-calendar" element={canAny('appointments:read') && canAny('dashboard:view') ? <Navigate to="/appointments" replace /> : guard(['appointments:read_own', 'appointments:read'], <MyCalendarPage />)} />
      <Route path="/clients" element={guard(['clients:read', 'clients:read_assigned'], <ClientsPage />)} />
      <Route path="/clients/:id" element={guard(['clients:read', 'clients:read_assigned'], <ClientProfilePage />)} />
      <Route path="/leads" element={guard(['leads:read'], <LeadsPage />)} />
      <Route path="/messages" element={guard(['messages:read'], <MessagesPage />)} />
      <Route path="/messages/:id" element={guard(['messages:read'], <MessagesPage />)} />
      <Route path="/inventory" element={guard(['inventory:order', 'inventory:read_all', 'inventory:view', 'inventory:manage'], <InventoryPage />)} />
      <Route path="/inventory-sync" element={guard(['inventory:sync'], <InventorySyncPage />)} />
      <Route path="/my-commission" element={guard(['commission:own'], <MyCommissionPage />)} />
      <Route path="/commission" element={guard(['commission:team', 'commission:approve'], <TeamCommissionPage />)} />
      <Route path="/analytics" element={guard(['analytics:read'], <AnalyticsPage />)} />
      <Route path="/settings" element={guard(SETTINGS_PERMS, <SettingsPage />)} />
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route path="*" element={<Navigate to={home} replace />} />
    </Routes>
  );

  // People without the dashboard (stylists by default) get the simplified app with only their sections.
  if (!can('dashboard:view')) {
    const home = canAny('appointments:read_own', 'appointments:read') ? '/my-calendar' : canAny('inventory:order', 'inventory:view') ? '/inventory' : canAny('commission:own') ? '/my-commission' : '/settings';
    return (
      <StylistShell>
        <Suspense fallback={<PageLoading />}>{routes(home)}</Suspense>
      </StylistShell>
    );
  }
  const needsOnboarding = can('settings:write') && !settings.limited && settings.settings.onboardingComplete === false;
  if (needsOnboarding && loc.pathname !== '/welcome') return <Navigate to="/welcome" replace />;
  if (loc.pathname === '/welcome') return <Suspense fallback={<PageLoading />}><OnboardingPage /></Suspense>;

  return (
    <ActionsProvider>
      <AppShell>
        <Suspense fallback={<PageLoading />}>{routes('/')}</Suspense>
      </AppShell>
    </ActionsProvider>
  );
}

function NoAccess() {
  return (
    <div className="panel">
      <EmptyState icon={<ShieldOff className="h-9 w-9" />} title="You don't have access to this page">Ask an administrator if you need it.</EmptyState>
    </div>
  );
}
