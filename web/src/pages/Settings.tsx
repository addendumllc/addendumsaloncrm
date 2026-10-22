import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useIntegrations, useSettings } from '../api/hooks';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import { PageHeader, PageLoading, Toggle, cx, useToast } from '../components/ui';
import { useCan } from './settings/shared';
import { AiSettings, HighLevelSettings, SmsSettings, SquareSettings } from './settings/IntegrationTabs';
import { BusinessSettings, NotificationSettings, RemindersSettings, RulesSettings } from './settings/RulesTabs';
import { TagSettings } from './settings/TagsTab';
import { AppearanceSettings } from './settings/AppearanceTab';
import { InventorySettings } from './settings/InventoryTab';
import { PrivacySettings } from './settings/PrivacyTab';
import { DemoTools } from './settings/DemoTab';
import { RepliesSettings } from './settings/RepliesTab';
import type { AppSettings, SharedSettings } from '@addendum/shared';
import { CredentialsSettings } from './settings/CredentialsTab';
import { UsersSettings } from './settings/UsersTab';
import { RoleTemplatesSettings } from './settings/RoleTemplatesTab';
import { LocationAccessSettings } from './settings/LocationAccessTab';
import { CommissionSettings } from './settings/CommissionTab';
import { BusinessesSettings } from './settings/BusinessesTab';
import { ThemesSettings } from './settings/ThemesTab';
import { Card } from './settings/shared';
import { ServiceRulesEditor } from '../components/domain/Rebooking';
import { DisplayPanel, PasswordPanel, ProfilePanel } from './MySettings';

/** Admins: show this section to the whole team (view only). */
function ShareWithTeam({ section }: { section: keyof SharedSettings }) {
  const { data } = useSettings();
  const qc = useQueryClient();
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const current = data?.settings.sharedSettings;
  const on = !!current?.[section];
  const toggle = async (v: boolean) => {
    setSaving(true);
    try {
      const r = await api.patch<{ settings: AppSettings }>('/settings', { sharedSettings: { [section]: v } });
      qc.setQueryData(['settings'], { settings: r.settings });
      toast(v ? 'Shared with the team (view only)' : 'Only people who can view settings see this now');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl2 border border-line bg-white px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-medium text-ink">Share with the team (view only)</p>
        <p className="text-[12px] text-stone">{on ? 'Everyone can see this section. Only people with the edit permission can change it.' : 'Only people who can view settings see this section.'}</p>
      </div>
      <div className="w-24"><Toggle label="Shared" checked={on} disabled={saving} onChange={(v) => void toggle(v)} /></div>
    </div>
  );
}

/** Appearance: this person's own theme, colours, fonts, buttons, display and calendar colour. */
function LookAndDisplay() {
  return (
    <section>
      <h2 className="h-display mb-1 text-[22px]">Appearance</h2>
      <p className="mb-3 text-[13px] text-stone">Only for you: theme, colors, fonts and text size, buttons, light or dark, and your calendar color.</p>
      <DisplayPanel />
    </section>
  );
}

interface Tab { id: string; label: string; group: string; perm?: string | string[]; demoOnly?: boolean; render: () => JSX.Element; shared?: keyof SharedSettings }

const TABS: Tab[] = [
  // Everyone, first: their own settings (no permission needed).
  { id: 'profile', label: 'My Profile', group: 'Personal preferences', render: () => <ProfilePanel /> },
  // Your own display (everyone), then the salon's brand and appearance (people who can view settings) — one page.
  { id: 'display', label: 'Appearance', group: 'Personal preferences', render: () => <LookAndDisplay /> },
  { id: 'password', label: 'Password', group: 'Personal preferences', render: () => <PasswordPanel /> },
  { id: 'business', label: 'Salon Details', group: 'Salon', perm: 'settings:read', render: () => <BusinessSettings /> },
  { id: 'themes', label: 'Theme Management', group: 'Administration', perm: 'settings:read', render: () => <ThemesSettings /> },
  { id: 'branding', label: 'Organization Branding', group: 'Administration', perm: 'settings:read', render: () => <AppearanceSettings /> },
  { id: 'businesses', label: 'Business & Menu Defaults', group: 'Administration', perm: 'settings:read', render: () => <BusinessesSettings /> },
  { id: 'api', label: 'API & Integrations', group: 'Administration', perm: 'integrations:manage', render: () => <CredentialsSettings /> },
  { id: 'users', label: 'Users & Permissions', group: 'Administration', perm: ['users:manage', 'users:permissions'], render: () => <UsersSettings /> },
  { id: 'roles', label: 'Role Templates', group: 'Administration', perm: 'users:permissions', render: () => <RoleTemplatesSettings /> },
  { id: 'access', label: 'Location & Access', group: 'Administration', perm: 'settings:write', render: () => <LocationAccessSettings /> },
  { id: 'commission', label: 'Commission', group: 'Administration', perm: ['commission:manage', 'commission:approve'], render: () => <CommissionSettings /> },
  { id: 'square', label: 'Square', group: 'Connections', perm: ['settings:read', 'integrations:manage', 'square:sync'], render: () => <SquareSettings /> },
  { id: 'sms', label: 'Texting', group: 'Connections', perm: 'settings:read', render: () => <SmsSettings /> },
  { id: 'replies', label: 'Saved Replies', group: 'Connections', perm: 'settings:read', shared: 'replies', render: () => <RepliesSettings /> },
  { id: 'highlevel', label: 'GoHighLevel', group: 'Connections', perm: 'settings:read', render: () => <HighLevelSettings /> },
  { id: 'ai', label: 'AI Assistance', group: 'Connections', perm: 'settings:read', render: () => <AiSettings /> },
  { id: 'rules', label: 'Follow-Up Rules', group: 'Automation', perm: 'settings:read', shared: 'rules', render: () => <RulesSettings /> },
  { id: 'rebooking', label: 'Rebooking by Service', group: 'Automation', perm: ['rebooking:defaults', 'settings:read'], shared: 'rebooking', render: () => (
    <Card title="Rebooking by service" description="Default schedule for each service. Clients can have their own schedule (on their profile), which overrides the default for them only.">
      <ServiceRulesEditor />
    </Card>
  ) },
  { id: 'reminders', label: 'Reminders & Reviews', group: 'Automation', perm: 'settings:read', shared: 'reminders', render: () => <RemindersSettings /> },
  { id: 'notifications', label: 'Notifications', group: 'Automation', perm: 'settings:read', render: () => <NotificationSettings /> },
  { id: 'inventory', label: 'Order Hair', group: 'Salon', perm: 'settings:read', render: () => <InventorySettings /> },
  { id: 'tags', label: 'Client Tags', group: 'People', perm: ['settings:rules', 'clients:write'], render: () => <TagSettings /> },
  { id: 'privacy', label: 'Privacy & Activity', group: 'People', perm: 'settings:read', render: () => <PrivacySettings /> },
  { id: 'demo', label: 'Demo Tools', group: 'Demo', demoOnly: true, render: () => <DemoTools /> },
];

export function SettingsPage() {
  const [params, setParams] = useSearchParams();
  const { data: settings, isLoading } = useSettings();
  const { data: integ } = useIntegrations();
  const can = useCan();
  const allowed = (perm?: string | string[]) => !perm || (Array.isArray(perm) ? perm.some(can) : can(perm));
  // A section shared with the team (view only) shows for everyone; editing still needs its permission.
  const sharedWithTeam = settings?.settings.sharedSettings;
  const tabs = TABS.filter((t) => (allowed(t.perm) || (t.shared && sharedWithTeam?.[t.shared])) && (!t.demoOnly || integ?.demoMode));
  // Older links to the separate Brand & appearance page open the combined page.
  const wanted = params.get('tab') === 'appearance' ? 'display' : params.get('tab');
  const chosen = tabs.find((t) => t.id === wanted);
  const current = chosen ?? tabs[0];
  const go = (id: string) => {
    const p = new URLSearchParams(params);
    p.set('tab', id);
    // A history step, so the phone's Back button returns to the list of settings.
    setParams(p);
  };
  if (isLoading || !settings) return <PageLoading />;
  if (!current) return <PageHeader title="Settings" subtitle="Nothing here for your account." />;
  const groups = [...new Set(tabs.map((t) => t.group))];

  return (
    <div>
      <PageHeader title="Settings" subtitle={settings.limited ? 'Your own settings, plus the salon settings your permissions allow.' : undefined} />
      <div className="grid gap-6 lg:grid-cols-[210px_minmax(0,1fr)] lg:gap-10">
        {/* Phones: a simple list of sections, then one section at a time. Desktop: grouped list beside the section. */}
        {!chosen ? (
          <nav className="space-y-5 lg:hidden" aria-label="Settings sections">
            {groups.map((g) => (
              <div key={g}>
                <p className="mb-1.5 px-1 text-[12px] font-semibold uppercase tracking-wider text-stone">{g}</p>
                <div className="divide-y divide-line overflow-hidden rounded-xl2 border border-line bg-white">
                  {tabs.filter((t) => t.group === g).map((t) => (
                    <button key={t.id} onClick={() => go(t.id)} className="flex min-h-[52px] w-full items-center justify-between px-4 text-left text-[16px] text-ink active:bg-mist">
                      {t.label}<ChevronRight className="h-4 w-4 text-stone" />
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </nav>
        ) : (
          <button type="button" onClick={() => { const p = new URLSearchParams(); setParams(p, { replace: true }); }} className="-mb-2 inline-flex min-h-[44px] items-center gap-1.5 text-[15px] text-stone lg:hidden">
            <ArrowLeft className="h-4 w-4" />All settings
          </button>
        )}
        <nav className="hidden lg:block" aria-label="Settings sections">
          {groups.map((g) => (
            <div key={g} className="mb-5">
              <p className="mb-1 px-3 text-[11px] font-semibold uppercase tracking-wider text-stone-light">{g}</p>
              {tabs.filter((t) => t.group === g).map((t) => (
                <button key={t.id} onClick={() => go(t.id)} className={cx('block w-full rounded-lg px-3 py-1.5 text-left text-[14.5px]', t.id === current.id ? 'bg-white font-medium text-ink shadow-sm' : 'text-ink-soft hover:bg-mist')}>{t.label}</button>
              ))}
            </div>
          ))}
        </nav>
        <div className={cx('min-w-0 max-w-3xl', !chosen && 'hidden lg:block')}>
          {current.shared && can('settings:write') && <ShareWithTeam section={current.shared} />}
          {current.render()}
        </div>
      </div>
    </div>
  );
}
