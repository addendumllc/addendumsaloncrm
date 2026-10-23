import { useQuery } from '@tanstack/react-query';
import { Download, ShieldCheck } from 'lucide-react';
import { api } from '../../api/client';
import { dateTime } from '../../lib/format';
import { PageLoading } from '../../components/ui';
import { Card, useCan } from './shared';

interface AuditEntry { id: string; action: string; entityType: string | null; entityId: string | null; createdAt: string; staffName: string | null }

const ACTION_LABELS: Record<string, string> = {
  'auth.login': 'Signed in', 'auth.login_failed': 'Failed sign-in attempt',
  'message.send': 'Sent a text', 'note.create': 'Added a note', 'note.delete': 'Deleted a note',
  'client.create': 'Added a client', 'client.update': 'Edited a client', 'client.archive': 'Archived a client', 'client.restore': 'Restored a client',
  'client.delete': 'Permanently deleted a client', 'client.export': 'Exported a client’s data', 'privacy.export_all': 'Exported all salon data',
  'lead.create': 'Added a new client', 'lead.update': 'Updated a new client', 'lead.convert': 'Moved a new client to clients', 'lead.archive': 'Archived a new client',
  'lead.create_from_text': 'Saved a texter as a client',
  'task.create': 'Created a follow-up', 'task.update': 'Edited a follow-up', 'task.complete': 'Completed a follow-up',
  'task.snooze': 'Snoozed a follow-up', 'task.cancel': 'Cancelled a follow-up', 'task.highlevel_push': 'Pushed a follow-up to HighLevel',
  'settings.update': 'Changed settings', 'staff.create': 'Added a team member', 'staff.update': 'Edited a team member',
  'integration.square_connected': 'Connected Square', 'integration.square_disconnected': 'Disconnected Square', 'integration.square_sync': 'Synced Square',
};

export function PrivacySettings() {
  const can = useCan();
  const { data, isLoading } = useQuery({
    queryKey: ['audit'], enabled: can('audit:read'),
    queryFn: () => api.get<{ entries: AuditEntry[] }>('/audit?limit=150').then((r) => r.entries),
  });
  return (
    <div className="space-y-6">
      <Card title="Your data" description="Client information stays in your salon's own database. Secrets for Square, HighLevel, Shopify, email and AI live only on the server.">
        <ul className="space-y-2 text-sm text-ink-soft">
          <li className="flex gap-2"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-sage" />Internal client notes are never included in texts, AI drafts or HighLevel tasks. (A follow-up's own notes do go into its HighLevel task.)</li>
          <li className="flex gap-2"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-sage" />The activity log records who did what — never message text, phone numbers or notes.</li>
          <li className="flex gap-2"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-sage" />To archive, export or permanently delete one client (e.g. a privacy request), open their profile → ⋯ menu.</li>
        </ul>
        {can('privacy:export_all') && (
          <a href="/api/privacy/export" download className="mt-4 inline-flex h-10 items-center gap-1.5 rounded-lg border border-line-strong bg-white px-3.5 text-sm font-medium text-ink hover:bg-mist/60">
            <Download className="h-4 w-4" />Export all salon data (JSON)
          </a>
        )}
      </Card>
      {can('audit:read') && (
        <Card title="Activity log" description="The latest 150 actions.">
          {isLoading ? <PageLoading /> : (
            <ul className="max-h-[480px] divide-y divide-line overflow-y-auto text-sm">
              {data?.length === 0 && <li className="py-4 text-center text-stone">Nothing yet.</li>}
              {data?.map((e) => (
                <li key={e.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2">
                  <span><span className="font-medium text-ink">{e.staffName ?? 'System'}</span> <span className="text-ink-soft">{ACTION_LABELS[e.action] ?? e.action.replace(/[._]/g, ' ')}</span></span>
                  <span className="text-xs text-stone">{dateTime(e.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}
