import { useState } from 'react';
import { Plus, X, Bell } from 'lucide-react';
import { Button, Field, Toggle, useToast } from '../../components/ui';
import { Card, NumberField, SaveBar, useCan, useSection } from './shared';
import { Tc } from '../../lib/titleCase';

const TIMEZONES = ['America/Los_Angeles', 'America/Denver', 'America/Phoenix', 'America/Chicago', 'America/New_York', 'America/Anchorage', 'Pacific/Honolulu'];

export function BusinessSettings({ onSaved }: { onSaved?: () => void }) {
  const b = useSection('business');
  const can = useCan();
  if (!b.draft) return null;
  const d = b.draft;
  const locked = !can('settings:write');
  return (
    <Card
      title="Salon details"
      description="Used in texts, review requests and AI drafts."
      footer={<SaveBar dirty={b.dirty} saving={b.saving} onSave={async () => { if (await b.save()) onSaved?.(); }} onReset={b.reset} disabled={locked} />}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Salon name"><input className="field" value={d.name} disabled={locked} onChange={(e) => b.set('name', e.target.value)} /></Field>
        <Field label="Phone"><input className="field" inputMode="tel" value={d.phone} disabled={locked} onChange={(e) => b.set('phone', e.target.value)} /></Field>
        <Field label="Address" className="sm:col-span-2"><input className="field" value={d.address} disabled={locked} onChange={(e) => b.set('address', e.target.value)} /></Field>
        <Field label="Website"><input className="field" value={d.website} disabled={locked} onChange={(e) => b.set('website', e.target.value)} placeholder="https://" /></Field>
        <Field label="Online booking link" hint="Your Square booking page — added to rebooking texts."><input className="field" value={d.bookingUrl} disabled={locked} onChange={(e) => b.set('bookingUrl', e.target.value)} placeholder="https://" /></Field>
        <Field label="Review link" hint="Google or Yelp review page."><input className="field" value={d.reviewUrl} disabled={locked} onChange={(e) => b.set('reviewUrl', e.target.value)} placeholder="https://g.page/r/…" /></Field>
        <Field label="Time zone">
          <select className="field" value={d.timezone} disabled={locked} onChange={(e) => b.set('timezone', e.target.value)}>
            {[...new Set([d.timezone, ...TIMEZONES])].map((t) => <option key={t} value={t}>{t.replace('America/', '').replace('Pacific/', '').replace('_', ' ')}</option>)}
          </select>
        </Field>
        <Field label="Hours" className="sm:col-span-2"><textarea className="field min-h-[64px]" value={d.hours} disabled={locked} onChange={(e) => b.set('hours', e.target.value)} placeholder="Tue–Fri 10–7, Sat 9–5, closed Sun & Mon" /></Field>
      </div>
      {locked && <p className="mt-3 text-[13px] text-stone">Only administrators (with “Edit business settings”) can change salon details.</p>}
    </Card>
  );
}

export function RulesSettings({ onSaved }: { onSaved?: () => void }) {
  const r = useSection('rules');
  const can = useCan();
  if (!r.draft) return null;
  const d = r.draft;
  const locked = !can('settings:rules');
  return (
    <Card
      title="Follow-up rules"
      description="When the app should create a follow-up for you. Follow-ups are internal reminders — they are never shown as booked appointments."
      footer={<SaveBar dirty={r.dirty} saving={r.saving} onSave={async () => { if (await r.save()) onSaved?.(); }} onReset={r.reset} disabled={locked} />}
    >
      <RuleGroup title="New clients">
        <NumberField label="Contact a new client within" unit="hours" value={d.newLeadHours} min={0} max={168} onChange={(v) => r.set('newLeadHours', v)} disabled={locked} hint="0 = right away" />
        <NumberField label="If they don't reply, follow up after" unit="hours" value={d.leadNoResponseHours} min={1} max={720} onChange={(v) => r.set('leadNoResponseHours', v)} disabled={locked} />
        <NumberField label="Second follow-up after" unit="hours" value={d.leadSecondNoResponseHours} min={1} max={1440} onChange={(v) => r.set('leadSecondNoResponseHours', v)} disabled={locked} />
      </RuleGroup>
      <RuleGroup title="Cancellations" toggle={<Toggle label="Follow up when a client cancels and hasn't rebooked" checked={d.cancellationEnabled} onChange={(v) => r.set('cancellationEnabled', v)} disabled={locked} />}>
        <NumberField label="Wait before following up" unit="hours" value={d.cancellationDelayHours} max={720} onChange={(v) => r.set('cancellationDelayHours', v)} disabled={locked || !d.cancellationEnabled} />
      </RuleGroup>
      <RuleGroup title="No-shows" toggle={<Toggle label="Follow up after a no-show" checked={d.noShowEnabled} onChange={(v) => r.set('noShowEnabled', v)} disabled={locked} />}>
        <NumberField label="Wait before following up" unit="hours" value={d.noShowDelayHours} max={720} onChange={(v) => r.set('noShowDelayHours', v)} disabled={locked || !d.noShowEnabled} />
      </RuleGroup>
      <RuleGroup title="Review requests" toggle={<Toggle label="Remind us to ask for a review after a visit" checked={d.reviewRequestEnabled} onChange={(v) => r.set('reviewRequestEnabled', v)} disabled={locked} />}>
        <NumberField label="Ask after" unit="hours" value={d.reviewDelayHours} max={720} onChange={(v) => r.set('reviewDelayHours', v)} disabled={locked || !d.reviewRequestEnabled} />
      </RuleGroup>
      <RuleGroup title="Smart rebooking" toggle={<Toggle label="Suggest contacting clients who are overdue" description="Based on each client's own booking rhythm in Square." checked={d.rebookingEnabled} onChange={(v) => r.set('rebookingEnabled', v)} disabled={locked} />}>
        <NumberField label="Overdue once past their usual gap by" unit="days" value={d.rebookingGraceDays} max={120} onChange={(v) => r.set('rebookingGraceDays', v)} disabled={locked || !d.rebookingEnabled} />
        <NumberField label="Stop following up when the last visit was over" unit="days ago (0 = never stop)" value={d.rebookingStopAfterDays ?? 365} max={3650} onChange={(v) => r.set('rebookingStopAfterDays', v)} disabled={locked || !d.rebookingEnabled} hint="365 = a year. Their open rebooking follow-ups close automatically." />
        <NumberField label="Only with at least" unit="past visits" value={d.rebookingMinVisits} min={2} max={20} onChange={(v) => r.set('rebookingMinVisits', v)} disabled={locked || !d.rebookingEnabled} hint="Fewer visits isn't enough history to guess a pattern." />
      </RuleGroup>
      <RuleGroup title="Unanswered texts" last>
        <NumberField label="Flag a text as needing a reply after" unit="minutes" value={d.unreadMessageMinutes} min={1} max={1440} onChange={(v) => r.set('unreadMessageMinutes', v)} disabled={locked} />
      </RuleGroup>
    </Card>
  );
}

function RuleGroup({ title, toggle, children, last }: { title: string; toggle?: React.ReactNode; children: React.ReactNode; last?: boolean }) {
  return (
    <div className={last ? 'pt-4' : 'border-b border-line py-4 first:pt-0'}>
      <h3 className="text-[13px] font-semibold uppercase tracking-wider text-stone"><Tc>{title}</Tc></h3>
      {toggle}
      <div className="mt-2 grid gap-4 sm:grid-cols-3">{children}</div>
    </div>
  );
}

export function RemindersSettings() {
  const rem = useSection('reminders');
  const rev = useSection('reviews');
  const can = useCan();
  const [newOffset, setNewOffset] = useState(4);
  if (!rem.draft || !rev.draft) return null;
  const locked = !can('settings:rules');
  const offsets = [...rem.draft.offsetsHours].sort((a, b) => b - a);
  const label = (h: number) => (h % 24 === 0 ? `${h / 24} day${h === 24 ? '' : 's'} before` : `${h} hour${h === 1 ? '' : 's'} before`);
  return (
    <div className="space-y-6">
      <Card title="Appointment reminders" description="Creates a reminder for each upcoming Square appointment at the times you choose." footer={<SaveBar dirty={rem.dirty} saving={rem.saving} onSave={() => rem.save()} onReset={rem.reset} disabled={locked} />}>
        <Toggle label="Appointment reminders" checked={rem.draft.enabled} onChange={(v) => rem.set('enabled', v)} disabled={locked} />
        <span className="label mt-2">Remind clients</span>
        <div className="flex flex-wrap items-center gap-2">
          {offsets.map((h) => (
            <span key={h} className="inline-flex items-center gap-1 rounded-full bg-plum-tint px-3 py-1 text-sm text-plum">
              {label(h)}
              {!locked && <button onClick={() => rem.set('offsetsHours', offsets.filter((x) => x !== h))} aria-label={`Remove ${label(h)}`}><X className="h-3.5 w-3.5" /></button>}
            </span>
          ))}
          {!locked && offsets.length < 5 && (
            <span className="inline-flex items-center gap-1">
              <input type="number" min={1} max={336} className="field h-8 w-20 py-1 text-sm" value={newOffset} onChange={(e) => setNewOffset(Number(e.target.value))} aria-label="Hours before" />
              <span className="text-sm text-stone">hours</span>
              <Button size="sm" icon={<Plus className="h-4 w-4" />} disabled={!newOffset || offsets.includes(newOffset)} onClick={() => rem.set('offsetsHours', [...offsets, newOffset])}>Add</Button>
            </span>
          )}
        </div>
        <Field label="Reminder text" className="mt-4" hint="Use {firstName}, {date}, {time}, {service}, {stylist}, {salon}.">
          <textarea className="field min-h-[80px]" value={rem.draft.template} maxLength={500} disabled={locked} onChange={(e) => rem.set('template', e.target.value)} />
        </Field>
        <p className="mt-3 text-[13px] text-stone">A reminder follow-up appears for staff to text from Apple Messages. Nothing is sent automatically.</p>
      </Card>

      <Card title="Review requests" description="Thank clients after a completed visit and invite a review." footer={<SaveBar dirty={rev.dirty} saving={rev.saving} onSave={() => rev.save()} onReset={rev.reset} disabled={locked} />}>
        <Field label="Message" hint="Use {firstName}, {salon}, {reviewUrl}. The delay and review link are set in Follow-up rules and Salon details.">
          <textarea className="field min-h-[80px]" value={rev.draft.message} maxLength={500} disabled={locked} onChange={(e) => rev.set('message', e.target.value)} />
        </Field>
        <p className="mt-3 text-[13px] text-stone">Staff send them from Follow-ups, through Apple Messages.</p>
      </Card>
    </div>
  );
}

export function NotificationSettings() {
  const n = useSection('notifications');
  const toast = useToast();
  if (!n.draft) return null;
  const browserPerm = typeof Notification !== 'undefined' ? Notification.permission : 'unsupported';
  return (
    <Card title="Notifications" description="How the team hears about new texts, new clients and Square changes." footer={<SaveBar dirty={n.dirty} saving={n.saving} onSave={() => n.save()} onReset={n.reset} />}>
      <Toggle
        label="Browser notifications"
        description={browserPerm === 'denied' ? 'Blocked in this browser — allow notifications in browser settings.' : browserPerm === 'unsupported' ? 'Not supported in this browser.' : 'Pop-up alerts while the app is open.'}
        checked={n.draft.browser}
        onChange={async (v) => {
          if (v && browserPerm === 'default') {
            const p = await Notification.requestPermission();
            if (p !== 'granted') return toast('Notifications were not allowed.', 'error');
          }
          n.set('browser', v);
        }}
      />
      <Toggle label="Email summaries" description="A morning email with today's priorities (needs an email provider on the server)." checked={n.draft.email} onChange={(v) => n.set('email', v)} />
      <Field label="Send email alerts to" className="mt-2"><input className="field sm:w-80" type="email" value={n.draft.notifyEmail} onChange={(e) => n.set('notifyEmail', e.target.value)} placeholder="owner@addendumsalon.com" /></Field>
      <p className="mt-3 flex items-center gap-1.5 text-[13px] text-stone"><Bell className="h-3.5 w-3.5" />In-app notifications (the bell) are always on.</p>
    </Card>
  );
}
