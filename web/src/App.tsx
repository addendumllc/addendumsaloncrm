import { Suspense, lazy, useEffect, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AWAY_SECTIONS, pathInAwaySections, type TimeClockStatusDTO } from '@addendum/shared';
import { useLook, useMe, useSettings, useUserThemes } from './api/hooks';
import { dayKey, setTimezone } from './lib/format';
import { api } from './api/client';
import { setThemeRole, setUserThemes, applyAppearance } from './lib/theme';
import { AppShell, NAV } from './components/layout/AppShell';
import { StylistShell } from './components/layout/StylistShell';
import { NetworkBlocked, useAccessStatus } from './components/layout/NetworkBlocked';
import { ActionsProvider } from './components/domain/ActionsProvider';
import { EmptyState, PageLoading } from './components/ui';
import { ShieldOff, Wifi } from 'lucide-react';
import { LoginPage } from './pages/Login';
const OnboardingPage = lazy(() => import('./pages/Onboarding').then((m) => ({ default: m.OnboardingPage })));
import { DashboardPage } from './pages/Dashboard';
import { FollowUpsPage } from './pages/FollowUps';
import { ContentPage } from './pages/Content';
import { TasksPage } from './pages/Tasks';
import { AnnouncementsPage } from './components/domain/Announcements';
import { AppointmentsPage } from './pages/Appointments';
import { ClientsPage } from './pages/Clients';
import { ClientProfilePage } from './pages/ClientProfile';
import { LeadsPage } from './pages/Leads';
import { MessagesPage } from './pages/Messages';
const AnalyticsPage = lazy(() => import('./pages/Analytics').then((m) => ({ default: m.AnalyticsPage })));
const InventoryPage = lazy(() => import('./pages/Inventory').then((m) => ({ default: m.InventoryPage })));
const TimeClockPage = lazy(() => import('./pages/TimeClock').then((m) => ({ default: m.TimeClockPage })));
const SettingsPage = lazy(() => import('./pages/Settings').then((m) => ({ default: m.SettingsPage })));
const MyCalendarPage = lazy(() => import('./pages/MyCalendar').then((m) => ({ default: m.MyCalendarPage })));
const InventorySyncPage = lazy(() => import('./pages/InventorySync').then((m) => ({ default: m.InventorySyncPage })));
const MyCommissionPage = lazy(() => import('./pages/Commission').then((m) => ({ default: m.MyCommissionPage })));
const TeamCommissionPage = lazy(() => import('./pages/Commission').then((m) => ({ default: m.TeamCommissionPage })));
import { ResetPasswordPage } from './pages/ResetPassword';

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

/**
 * The first time someone who uses the time clock opens the CRM each day (on this device), the Time Clock opens first —
 * unless they've already clocked in today (on any device). Clocking in then takes them to the Dashboard.
 */
function FirstOpenOfDay({ userId }: { userId: string }) {
  const nav = useNavigate();
  const loc = useLocation();
  const { data } = useQuery({ queryKey: ['timeclock'], queryFn: () => api.get<TimeClockStatusDTO>('/timeclock/me'), staleTime: 30_000 });
  useEffect(() => {
    if (!data) return;
    const key = `addendum:clock-first-open:${userId}`;
    const today = dayKey(new Date());
    let seen: string | null = null;
    try { seen = localStorage.getItem(key); } catch { /* private window: treat as not seen */ }
    if (seen === today) return;
    try { localStorage.setItem(key, today); } catch { /* ignore */ }
    const clockedInToday = !!data.shift || data.recent.some((s) => dayKey(s.clockInAt) === today);
    if (!clockedInToday && loc.pathname !== '/time-clock') nav('/time-clock?first=1', { replace: true });
  }, [data, userId]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

function SignedIn() {
  const { data: settings } = useSettings();
  const { data: me } = useMe();
  const { data: access } = useAccessStatus();
  const loc = useLocation();
  // This person's own accent and light/dark (My look), over the salon's look.
  const { data: look } = useLook();
  const { data: personalThemes } = useUserThemes(!!me);
  useEffect(() => { setUserThemes((personalThemes ?? []).map((t) => t.theme)); }, [personalThemes]);
  useEffect(() => {
    if (settings?.settings.business?.timezone) setTimezone(settings.settings.business.timezone);
    // Themes can be limited to roles.
    setThemeRole(me?.role);
    if (settings) applyAppearance(settings.settings.appearance, look ?? null);
  }, [settings, look, me?.role]);
  if (!settings) return <div className="flex h-screen items-center justify-center"><PageLoading /></div>;
  // Each page opens for the permissions listed (any one). The server checks every request as well.
  const can = (p: string) => !!me && me.permissions.includes(p);
  const canAny = (...ps: string[]) => ps.some(can);
  // "Clock in from anywhere": the time clock works away from the approved networks even when the rest of the app doesn't.
  const clockAnywhere = can('timeclock:use') && can('timeclock:anywhere');
  // Not on the salon network on a computer (Location & Access): the server refuses everything, so say why.
  if (access?.restricted) {
    if (!clockAnywhere) return <NetworkBlocked status={access} />;
    return (
      <div className="min-h-[100dvh] bg-paper px-4 py-6 sm:px-8">
        <p className="mx-auto mb-4 flex max-w-xl items-start gap-2 rounded-xl2 border border-amber/30 bg-amber/10 px-4 py-3 text-[14px] text-ink-soft">
          <Wifi className="mt-0.5 h-4 w-4 shrink-0 text-amber" />Away from the salon you can use the Time Clock. Connect to the salon or office network for the rest of the CRM.
        </p>
        <Suspense fallback={<PageLoading />}><TimeClockPage /></Suspense>
      </div>
    );
  }
  const guard = (anyOf: string[], page: ReactNode) => (canAny(...anyOf) ? page : <NoAccess />);
  // Away from the salon with chosen sections ("Away from the salon: …"): only those open; the server enforces it too.
  const away = access?.limited ?? null;
  if (away && !pathInAwaySections(loc.pathname, away) && !(clockAnywhere && loc.pathname === '/time-clock')) {
    const pages = [...NAV, { to: '/announcements', anyOf: ['announcements:read'] }];
    const first = AWAY_SECTIONS.filter((s) => away.includes(s.key)).flatMap((s) => s.paths)
      .find((p) => pages.some((n) => n.to === p && n.anyOf.some(can)));
    if (first) return <Navigate to={first} replace />;
  }
  const awayNote = away && (
    <p className="mb-4 flex items-start gap-2 rounded-xl2 border border-amber/30 bg-amber/10 px-4 py-3 text-[14px] text-ink-soft">
      <Wifi className="mt-0.5 h-4 w-4 shrink-0 text-amber" />Away from the salon you can use {AWAY_SECTIONS.filter((s) => away.includes(s.key)).map((s) => s.label).join(', ')}. Connect to the salon or office network for everything else.
    </p>
  );
  const routes = (home: string) => (
    <>{awayNote}{can('timeclock:use') && <FirstOpenOfDay userId={me!.id} />}<Routes>
      <Route path="/" element={canAny('dashboard:view') ? <DashboardPage /> : <Navigate to={home} replace />} />
      <Route path="/follow-ups" element={guard(['tasks:read_all', 'tasks:read_own'], <FollowUpsPage />)} />
      <Route path="/content" element={guard(['content:manage', 'content:studio'], <ContentPage />)} />
      <Route path="/tasks" element={guard(['tasks:read_all', 'tasks:read_own', 'hair:manage'], <TasksPage />)} />
      {/* For people without the dashboard (stylists by default); everyone else sees announcements on the dashboard. */}
      <Route path="/announcements" element={guard(['announcements:read', 'announcements:publish', 'announcements:manage'], <AnnouncementsPage />)} />
      <Route path="/appointments" element={!can('appointments:read') && can('appointments:read_own') ? <Navigate to="/my-calendar" replace /> : guard(['appointments:read'], <AppointmentsPage />)} />
      <Route path="/my-calendar" element={canAny('appointments:read') && canAny('dashboard:view') ? <Navigate to="/appointments" replace /> : guard(['appointments:read_own', 'appointments:read'], <MyCalendarPage />)} />
      <Route path="/clients" element={guard(['clients:read', 'clients:read_assigned', 'leads:read', 'hair:manage'], <ClientsPage />)} />
      <Route path="/clients/:id" element={guard(['clients:read', 'clients:read_assigned'], <ClientProfilePage />)} />
      {/* New Clients is now part of Clients: old links (bookmarks, search, dashboard) land in the right place. */}
      <Route path="/leads" element={guard(['leads:read'], <LeadsRedirect />)} />
      <Route path="/messages" element={guard(['messages:read'], <MessagesPage />)} />
      <Route path="/messages/:id" element={guard(['messages:read'], <MessagesPage />)} />
      <Route path="/inventory" element={guard(['inventory:order', 'inventory:read_all', 'inventory:view', 'inventory:manage'], <InventoryPage />)} />
      <Route path="/inventory-sync" element={guard(['inventory:sync'], <InventorySyncPage />)} />
      <Route path="/hair-clients" element={<Navigate to="/clients?business=hair" replace />} />
      <Route path="/hair" element={<Navigate to="/tasks?hair=todo" replace />} />
      <Route path="/my-commission" element={guard(['commission:own'], <MyCommissionPage />)} />
      <Route path="/commission" element={guard(['commission:team', 'commission:approve'], <TeamCommissionPage />)} />
      <Route path="/analytics" element={guard(['analytics:read', 'revenue:projections', 'inventory:sync', 'hair:manage'], <AnalyticsPage />)} />
      {/* Purchases is an Analytics sub-tab now; older links land there. */}
      <Route path="/purchases" element={<Navigate to="/analytics?scope=purchases" replace />} />
      <Route path="/time-clock" element={guard(['timeclock:use'], <TimeClockPage />)} />
      {/* Everyone has Settings: their own profile, display and password, plus whatever salon settings they're allowed. */}
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="/my-settings" element={<Navigate to="/settings?tab=profile" replace />} />
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route path="*" element={<Navigate to={home} replace />} />
    </Routes></>
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
  const needsOnboarding = !away && can('settings:write') && !settings.limited && settings.settings.onboardingComplete === false;
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

function LeadsRedirect() {
  const loc = useLocation();
  const p = new URLSearchParams(loc.search);
  p.set('section', 'new');
  return <Navigate to={`/clients?${p.toString()}`} replace />;
}

function NoAccess() {
  return (
    <div className="panel">
      <EmptyState icon={<ShieldOff className="h-9 w-9" />} title="You don't have access to this page">Ask an administrator if you need it.</EmptyState>
    </div>
  );
}
