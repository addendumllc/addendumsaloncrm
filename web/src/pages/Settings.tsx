import { useSearchParams } from 'react-router-dom';
import { useIntegrations, useSettings } from '../api/hooks';
import { PageHeader, PageLoading, cx } from '../components/ui';
import { useCan } from './settings/shared';
import { AiSettings, HighLevelSettings, SmsSettings, SquareSettings } from './settings/IntegrationTabs';
import { BusinessSettings, NotificationSettings, RemindersSettings, RulesSettings } from './settings/RulesTabs';
import { TagSettings } from './settings/TagsTab';
import { AppearanceSettings } from './settings/AppearanceTab';
import { InventorySettings } from './settings/InventoryTab';
import { PrivacySettings } from './settings/PrivacyTab';
import { DemoTools } from './settings/DemoTab';
import { RepliesSettings } from './settings/RepliesTab';
import { CredentialsSettings } from './settings/CredentialsTab';
import { UsersSettings } from './settings/UsersTab';
import { CommissionSettings } from './settings/CommissionTab';
import { Card } from './settings/shared';
import { ServiceRulesEditor } from '../components/domain/Rebooking';

interface Tab { id: string; label: string; group: string; perm?: string | string[]; demoOnly?: boolean; render: () => JSX.Element }

const TABS: Tab[] = [
  { id: 'business', label: 'Salon details', group: 'Salon', perm: 'settings:read', render: () => <BusinessSettings /> },
  { id: 'api', label: 'API & Integrations', group: 'Admin', perm: 'integrations:manage', render: () => <CredentialsSettings /> },
  { id: 'users', label: 'Users & Permissions', group: 'Admin', perm: ['users:manage', 'users:permissions'], render: () => <UsersSettings /> },
  { id: 'commission', label: 'Commission', group: 'Admin', perm: ['commission:manage', 'commission:approve'], render: () => <CommissionSettings /> },
  { id: 'square', label: 'Square', group: 'Connections', perm: ['settings:read', 'integrations:manage', 'square:sync'], render: () => <SquareSettings /> },
  { id: 'sms', label: 'Texting', group: 'Connections', perm: 'settings:read', render: () => <SmsSettings /> },
  { id: 'replies', label: 'Saved replies', group: 'Connections', perm: 'settings:read', render: () => <RepliesSettings /> },
  { id: 'highlevel', label: 'GoHighLevel', group: 'Connections', perm: 'settings:read', render: () => <HighLevelSettings /> },
  { id: 'ai', label: 'AI assistance', group: 'Connections', perm: 'settings:read', render: () => <AiSettings /> },
  { id: 'rules', label: 'Follow-up rules', group: 'Automation', perm: 'settings:read', render: () => <RulesSettings /> },
  { id: 'rebooking', label: 'Rebooking by service', group: 'Automation', perm: ['rebooking:defaults', 'settings:read'], render: () => (
    <Card title="Rebooking by service" description="Default schedule for each service. Clients can have their own schedule (on their profile), which overrides the default for them only.">
      <ServiceRulesEditor />
    </Card>
  ) },
  { id: 'reminders', label: 'Reminders & reviews', group: 'Automation', perm: 'settings:read', render: () => <RemindersSettings /> },
  { id: 'notifications', label: 'Notifications', group: 'Automation', perm: 'settings:read', render: () => <NotificationSettings /> },
  { id: 'appearance', label: 'Brand & appearance', group: 'Salon', perm: 'settings:read', render: () => <AppearanceSettings /> },
  { id: 'inventory', label: 'Order Hair', group: 'Salon', perm: 'settings:read', render: () => <InventorySettings /> },
  { id: 'tags', label: 'Client tags', group: 'People', perm: ['settings:rules', 'clients:write'], render: () => <TagSettings /> },
  { id: 'privacy', label: 'Privacy & activity', group: 'People', perm: 'settings:read', render: () => <PrivacySettings /> },
  { id: 'demo', label: 'Demo tools', group: 'Demo', demoOnly: true, render: () => <DemoTools /> },
];

export function SettingsPage() {
  const [params, setParams] = useSearchParams();
  const { data: settings, isLoading } = useSettings();
  const { data: integ } = useIntegrations();
  const can = useCan();
  const allowed = (perm?: string | string[]) => !perm || (Array.isArray(perm) ? perm.some(can) : can(perm));
  const tabs = TABS.filter((t) => allowed(t.perm) && (!t.demoOnly || integ?.demoMode));
  const current = tabs.find((t) => t.id === params.get('tab')) ?? tabs[0];
  const go = (id: string) => {
    const p = new URLSearchParams(params);
    p.set('tab', id);
    setParams(p, { replace: true });
  };
  if (isLoading || !settings) return <PageLoading />;
  if (!current) return <PageHeader title="Settings" subtitle="Nothing here for your account." />;
  const groups = [...new Set(tabs.map((t) => t.group))];

  return (
    <div>
      <PageHeader title="Settings" subtitle={settings.limited ? 'You see the settings your permissions allow.' : undefined} />
      <div className="grid gap-6 lg:grid-cols-[210px_minmax(0,1fr)] lg:gap-10">
        {/* Mobile: scrollable chips. Desktop: grouped list. */}
        <nav className="scrollbar-none -mx-4 flex gap-1.5 overflow-x-auto px-4 lg:hidden" aria-label="Settings sections">
          {tabs.map((t) => (
            <button key={t.id} onClick={() => go(t.id)} className={cx('shrink-0 rounded-full px-3 py-1.5 text-[13px] font-medium', t.id === current.id ? 'bg-ink text-white' : 'bg-mist text-ink-soft')}>{t.label}</button>
          ))}
        </nav>
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
        <div className="min-w-0 max-w-3xl">{current.render()}</div>
      </div>
    </div>
  );
}
