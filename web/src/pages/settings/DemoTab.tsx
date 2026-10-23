import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { CalendarX, CalendarClock, UserX, CalendarPlus, RotateCcw, CloudOff, Cloud, MessageSquare } from 'lucide-react';
import { api } from '../../api/client';
import { useAppointments, useIntegrations, useRefreshAll } from '../../api/hooks';
import { dateShort, dateTime, time } from '../../lib/format';
import { Badge, Button, Field, Modal, Toggle, useToast } from '../../components/ui';
import { ContactPicker, type PickedContact } from '../../components/domain/ContactPicker';
import { Card } from './shared';

interface DemoHL {
  outage: boolean;
  contacts: { id: string; name: string }[];
  tasks: { id: string; contactId: string; title: string; body: string; dueDate: string; assignedTo: string | null; completed: boolean }[];
  users: { id: string; name: string }[];
}

/**
 * DEMO MODE ONLY. These buttons play the part of Square, a client's phone and HighLevel so every
 * workflow can be tried end to end. Changes flow through the exact same sync / webhook code as live.
 */
export function DemoTools() {
  const { data: integ } = useIntegrations();
  const { data: upcoming } = useAppointments({ range: 'upcoming' });
  const { data: hl, refetch: refetchHL } = useQuery({ queryKey: ['demo-hl'], queryFn: () => api.get<DemoHL>('/demo/highlevel') });
  const refresh = useRefreshAll();
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();
  const [apptId, setApptId] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [bookFor, setBookFor] = useState<PickedContact | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  if (!integ?.demoMode) return null;
  const active = upcoming?.filter((a) => a.squareStatus === 'ACCEPTED' || a.squareStatus === 'PENDING') ?? [];
  const run = async (key: string, fn: () => Promise<unknown>, msg: string) => {
    setBusy(key);
    try {
      await fn();
      toast(msg);
      refresh();
      refetchHL();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };
  const squareAction = (action: string, msg: string) => run(action, () => api.post(`/demo/square/${apptId}/${action}`), msg);

  return (
    <div className="space-y-6">
      <p className="rounded-xl bg-plum-tint px-4 py-3 text-sm text-plum">
        <b>Demo tools.</b> Pretend to be Square, a client's phone, or HighLevel. Every change goes through the same code the live integrations use, so you can watch the app react.
      </p>

      <Card title="Act as Square" description="Change a booking “in Square”, then the app detects it like a booking.updated webhook.">
        <Field label="Upcoming Square appointment">
          <select className="field" value={apptId} onChange={(e) => setApptId(e.target.value)}>
            <option value="">Choose an appointment…</option>
            {active.slice(0, 40).map((a) => <option key={a.id} value={a.id}>{dateShort(a.startAt)} {time(a.startAt)} · {a.clientName ?? 'Walk-in'} · {a.serviceNames.join(', ')}</option>)}
          </select>
        </Field>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button disabled={!apptId} loading={busy === 'cancel'} icon={<CalendarX className="h-4 w-4" />} onClick={() => squareAction('cancel', 'Cancelled in Square → cancellation follow-up created')}>Client cancels</Button>
          <Button disabled={!apptId} loading={busy === 'reschedule'} icon={<CalendarClock className="h-4 w-4" />} onClick={() => squareAction('reschedule', 'Rescheduled in Square (moved 2 days later)')}>Reschedule</Button>
          <Button disabled={!apptId} loading={busy === 'no-show'} icon={<UserX className="h-4 w-4" />} onClick={() => squareAction('no-show', 'Marked no-show in Square → follow-up created')}>Mark no-show</Button>
        </div>
        <div className="mt-5 border-t border-line pt-4">
          <Field label="A client books online in Square"><ContactPicker value={bookFor} onChange={setBookFor} /></Field>
          <Button className="mt-3" disabled={!bookFor || bookFor.kind !== 'client'} loading={busy === 'book'} icon={<CalendarPlus className="h-4 w-4" />}
            onClick={() => run('book', () => api.post('/demo/square/book', { clientId: bookFor!.id, daysFromNow: 5 }), `${bookFor!.name} booked in Square → open follow-ups close automatically`)}>
            Create booking in 5 days
          </Button>
        </div>
      </Card>

      <Card title="Act as a client's phone" description="Pretend a client texted the salon, to try reply drafting and saved replies. In real use, replies arrive in Apple Messages.">
        <Button icon={<MessageSquare className="h-4 w-4" />} onClick={() => nav('/messages')}>Open Messages → Simulate</Button>
      </Card>

      <Card title="Act as HighLevel" description="A simulated HighLevel sub-account. Nothing is sent to the real HighLevel.">
        <Toggle
          label="Simulate a HighLevel outage"
          description="Pushes will fail and wait in the retry queue. Turn off and they go through automatically (or press Retry)."
          checked={!!hl?.outage}
          onChange={(on) => run('outage', () => api.post('/demo/highlevel/outage', { on }).then(() => qc.invalidateQueries({ queryKey: ['integrations'] })), on ? 'HighLevel is now “down”' : 'HighLevel is back up')}
        />
        <p className="mt-2 flex items-center gap-2 text-sm font-medium">{hl?.outage ? <CloudOff className="h-4 w-4 text-amber" /> : <Cloud className="h-4 w-4 text-sage" />}Tasks in demo HighLevel ({hl?.tasks.length ?? 0})</p>
        <ul className="mt-2 max-h-72 divide-y divide-line overflow-y-auto rounded-xl border border-line text-sm">
          {hl?.tasks.length === 0 && <li className="px-3 py-3 text-stone">No tasks yet — press “Push to HighLevel” on any follow-up.</li>}
          {[...(hl?.tasks ?? [])].reverse().map((t) => (
            <li key={t.id} className="px-3 py-2">
              <p className="flex items-center justify-between gap-2"><span className="font-medium text-ink">{t.title}</span>{t.completed ? <Badge tone="sage">Completed</Badge> : <Badge>Open</Badge>}</p>
              <p className="text-xs text-stone">Due {dateTime(t.dueDate)} · {hl!.contacts.find((c) => c.id === t.contactId)?.name ?? 'Contact'} · {hl!.users.find((u) => u.id === t.assignedTo)?.name ?? 'Unassigned'} · <code>{t.id}</code></p>
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Start over" description="Replace everything with fresh demo data (dates move to today).">
        <Button variant="danger" icon={<RotateCcw className="h-4 w-4" />} onClick={() => setConfirmReset(true)}>Reset demo data</Button>
      </Card>

      <Modal open={confirmReset} onClose={() => setConfirmReset(false)} title="Reset demo data?" footer={<><Button variant="ghost" onClick={() => setConfirmReset(false)}>Cancel</Button><Button variant="danger" loading={busy === 'reset'} onClick={() => run('reset', () => api.post('/demo/reset').then(() => qc.invalidateQueries()), 'Demo data reset').then(() => setConfirmReset(false))}>Reset</Button></>}>
        <p className="text-sm text-ink-soft">All demo clients, texts and follow-ups will be replaced. You'll be asked to sign in again.</p>
      </Modal>
    </div>
  );
}
