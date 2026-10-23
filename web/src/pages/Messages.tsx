import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { ConversationDTO, MessageDTO } from '@addendum/shared';
import {
  ArrowLeft, CalendarDays, Check, CheckCheck, MessageSquare, MessageSquareOff, Phone, Plus, Send, Sparkles, UserPlus, AlertCircle, FlaskConical, Trash2 } from 'lucide-react';
import { api } from '../api/client';
import { useCanDo, useConversation, useConversations, useIntegrations, useRefreshAll, useSettings } from '../api/hooks';
import { dateShort, dateTime, phone as fmtPhone, relative, time } from '../lib/format';
import { Avatar, Badge, Button, EmptyState, ErrorNote, Field, Modal, PageLoading, Segmented, cx, useToast } from '../components/ui';
import { useActions } from '../components/domain/ActionsProvider';
import { ContactPicker, type PickedContact } from '../components/domain/ContactPicker';
import { SavedRepliesPicker } from '../components/domain/SavedRepliesPicker';
import { Tc } from '../lib/titleCase';
import { SectionPicker } from '../components/layout/subNav';
import { useStoreNames } from '../lib/storeNames';
import { RepliesSettings } from './settings/RepliesTab';
import { RemindersSettings } from './settings/RulesTabs';

/**
 * Texting history. Texts are sent from Apple Messages on the staff member's device: the CRM opens Messages
 * with the number and text filled in. Saved replies or AI help write the text; a person always sends it.
 */
/** Default messages (side menu → Default messages): the same settings as in Settings, without leaving Messages. */
const DEFAULT_MESSAGES: Record<string, { title: string; render: () => JSX.Element }> = {
  replies: { title: 'Saved replies', render: () => <RepliesSettings /> },
  reminders: { title: 'Reminder & review texts', render: () => <RemindersSettings /> },
};

export function MessagesPage() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const canDo = useCanDo();
  const names = useStoreNames();
  // Default messages: for people who can view settings, or everyone when that section is shared with the team.
  const shared = useSettings().data?.settings.sharedSettings;
  const view = params.get('view') ?? '';
  const mayOpen = canDo('settings:read') || (view === 'replies' && !!shared?.replies) || (view === 'reminders' && !!shared?.reminders);
  const defaults = !id && mayOpen ? DEFAULT_MESSAGES[view] : undefined;
  const filter = params.get('filter') ?? 'all';
  const [q, setQ] = useState('');
  const { data: convos, isLoading, error, refetch } = useConversations(filter, q);
  const { data: integ } = useIntegrations();
  const [newOpen, setNewOpen] = useState(params.get('compose') === '1');
  const [simOpen, setSimOpen] = useState(false);
  const nav = useNavigate();

  const setFilter = (v: string) => {
    const p = new URLSearchParams(params);
    if (v === 'all') p.delete('filter'); else p.set('filter', v);
    setParams(p, { replace: true });
  };

  if (defaults) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="app-content mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          <h1 className="h-display mb-4 text-[32px] leading-none">{defaults.title}</h1>
          <SectionPicker path="/messages" names={names} can={canDo} className="mb-4" />
          {defaults.render()}
        </div>
      </div>
    );
  }

  // Signature & texting moved to Settings (administrators).
  if (view === 'texting') return <Navigate to="/settings?tab=sms" replace />;
  return (
    <div className="flex min-h-0 flex-1">
      {/* Conversation list */}
      <section className={cx('flex w-full flex-col border-r border-line bg-white md:w-[340px] md:shrink-0', id && 'hidden md:flex')}>
        <div className="border-b border-line px-4 pb-3 pt-5">
          <div className="flex items-center justify-between gap-2">
            <h1 className="h-display text-[32px] leading-none"><Tc>Messages</Tc></h1>
            <div className="flex gap-1.5">
              {integ?.demoMode && <Button size="sm" variant="ghost" icon={<FlaskConical className="h-4 w-4" />} onClick={() => setSimOpen(true)} title="Simulate a client texting the salon">Simulate</Button>}
              <Button size="sm" variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setNewOpen(true)}>New</Button>
            </div>
          </div>
          {/* Phones: the side menu's sections (inbox, default messages) as a dropdown. */}
          <SectionPicker path="/messages" names={names} can={canDo} className="mt-3" />
          <div className="mt-3 flex items-center gap-2">
            <Segmented value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All' }, { value: 'unread', label: 'Unread' }]} />
            <input className="field h-9 flex-1 py-1 text-sm" placeholder="Search name or number" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search conversations" />
          </div>
          {integ && !integ.demoMode && (
            <p className="mt-3 flex items-start gap-2 rounded-lg bg-mist px-3 py-2 text-[13px] text-ink-soft"><MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-stone" />Texts are sent from Apple Messages on your device. Replies arrive in Messages, not here.</p>
          )}
        </div>
        <div className="flex-1 overflow-y-auto">
          {isLoading && <PageLoading />}
          {error && <div className="p-4"><ErrorNote error={error} onRetry={refetch} /></div>}
          {convos && convos.length === 0 && (
            <EmptyState icon={<MessageSquare className="h-8 w-8" />} title={filter === 'unread' ? 'No unread texts' : 'No conversations'}>
              {filter === 'unread' ? "You've replied to everyone." : 'Texts you start from the CRM appear here.'}
            </EmptyState>
          )}
          <ul>
            {convos?.map((c) => <ConversationRow key={c.id} c={c} active={c.id === id} onClick={() => nav(`/messages/${c.id}${filter !== 'all' ? `?filter=${filter}` : ''}`)} />)}
          </ul>
        </div>
      </section>

      {/* Thread */}
      <section className={cx('min-w-0 flex-1 flex-col bg-paper', id ? 'flex' : 'hidden md:flex')}>
        {id ? <Thread key={id} id={id} /> : (
          <div className="flex flex-1 items-center justify-center">
            <EmptyState icon={<MessageSquare className="h-10 w-10" />} title="Pick a conversation">Texts you send from the CRM are logged here. They open in Apple Messages to send, and client replies arrive in Messages.</EmptyState>
          </div>
        )}
      </section>

      {newOpen && <NewMessageModal onClose={() => { setNewOpen(false); if (params.get('compose')) { const p = new URLSearchParams(params); p.delete('compose'); setParams(p, { replace: true }); } }} />}
      {simOpen && <SimulateInboundModal onClose={() => setSimOpen(false)} />}
    </div>
  );
}

function ConversationRow({ c, active, onClick }: { c: ConversationDTO; active: boolean; onClick: () => void }) {
  const unread = c.unreadCount > 0;
  return (
    <li>
      <button onClick={onClick} className={cx('flex w-full gap-3 border-b border-line/70 px-4 py-3 text-left transition-colors', active ? 'bg-plum-tint/60' : 'hover:bg-mist/60')}>
        <Avatar name={c.displayName} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className={cx('truncate text-[15px]', unread ? 'font-semibold text-ink' : 'text-ink')}>{c.displayName}</span>
            <span className="shrink-0 text-xs text-stone">{c.lastMessageAt ? relative(c.lastMessageAt) : ''}</span>
          </span>
          <span className="mt-0.5 flex items-center gap-2">
            <span className={cx('flex-1 truncate text-[13px]', unread ? 'text-ink-soft' : 'text-stone')}>{c.lastMessagePreview ?? 'No messages yet'}</span>
            {unread && <span className="num rounded-full bg-plum px-1.5 text-[11px] font-semibold leading-5 text-white">{c.unreadCount}</span>}
          </span>
          <span className="mt-1 flex flex-wrap gap-1">
            {c.clientId && <Badge>Client</Badge>}
            {!c.clientId && c.leadId && <Badge tone="plum">New client</Badge>}
            {!c.clientId && !c.leadId && c.insight?.isPotentialLead && <Badge tone="amber">Potential client</Badge>}
            {c.optedOut && <Badge tone="rose">Opted out</Badge>}
          </span>
        </span>
      </button>
    </li>
  );
}

const STATUS_LABEL: Partial<Record<MessageDTO['status'], string>> = {
  queued: 'Sending…', sent: 'Sent', delivered: 'Delivered', failed: 'Not delivered', undelivered: 'Not delivered',
  opened_in_messages: 'Opened in Messages · not confirmed', marked_sent: 'Marked sent', not_sent: 'Not sent',
};

function Thread({ id }: { id: string }) {
  const { data, isLoading, error, refetch } = useConversation(id);
  const { data: settings } = useSettings();
  const { data: integ } = useIntegrations();
  const { newFollowUp, compose } = useActions();
  const refresh = useRefreshAll();
  const toast = useToast();
  const nav = useNavigate();
  const [body, setBody] = useState('');
  const [aiUsed, setAiUsed] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [sending, setSending] = useState(false);
  const [leadOpen, setLeadOpen] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const aiEnabled = settings?.settings.ai.enabled !== false;
  const canDelete = useCanDo()('messages:delete');

  // Opening a conversation marks it read.
  useEffect(() => {
    if (data?.conversation.unreadCount) api.post(`/messages/conversations/${id}/read`).then(refresh).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, data?.conversation.unreadCount]);
  // A block body: newer browsers return a value from scrollIntoView, and an effect must return nothing (or a cleanup
  // function) — otherwise React crashes when leaving the conversation (e.g. Open Client Profile showed a blank page).
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [data?.messages.length]);

  if (isLoading) return <PageLoading />;
  if (error || !data) return <div className="p-6"><ErrorNote error={error} onRetry={refetch} /></div>;
  const { conversation: c, messages, upcomingAppointment } = data;

  const draft = async () => {
    setDrafting(true);
    try {
      const r = await api.post<{ draft: string }>('/messages/draft', { conversationId: id });
      setBody(r.draft);
      setAiUsed(true);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setDrafting(false);
    }
  };
  // Replies are sent from Apple Messages: hand the text to the composer, which opens Messages.
  const send = () => {
    compose({
      name: c.displayName, phone: c.phone, clientId: c.clientId, leadId: c.leadId, conversationId: id,
      initialBody: body, initialAiGenerated: aiUsed,
    });
    setBody('');
    setAiUsed(false);
  };
  const markOutcome = async (messageId: string, outcome: 'sent' | 'not_sent') => {
    setSending(true);
    try {
      await api.post(`/messages/${messageId}/outcome`, { outcome });
      refresh();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSending(false);
    }
  };
  const contactKind = c.clientId ? 'client' : c.leadId ? 'lead' : null;
  const insight = c.insight;
  // Deleting removes it from the CRM only — texts on anyone's phone are untouched.
  const removeMessage = async (messageId: string) => {
    if (!window.confirm('Delete this message from the CRM? It stays on the phone it was sent from. This can’t be undone.')) return;
    try { await api.del(`/messages/${messageId}`); toast('Message deleted'); refresh(); } catch (e) { toast((e as Error).message, 'error'); }
  };
  const removeConversation = async () => {
    if (!window.confirm(`Delete the whole conversation with ${c.displayName} (${messages.length} message${messages.length === 1 ? '' : 's'}) from the CRM? This can’t be undone.`)) return;
    try { await api.del(`/messages/conversations/${id}`); toast('Conversation deleted'); refresh(); nav('/messages'); } catch (e) { toast((e as Error).message, 'error'); }
  };

  // Group messages by day for readable separators.
  let lastDay = '';
  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-line bg-white px-4 py-3">
          <button className="rounded-lg p-1.5 text-stone hover:bg-mist md:hidden" onClick={() => nav('/messages')} aria-label="Back to conversations"><ArrowLeft className="h-5 w-5" /></button>
          <Avatar name={c.displayName} />
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium text-ink">
              {c.clientId ? <Link to={`/clients/${c.clientId}`} className="hover:underline">{c.displayName}</Link>
                : c.leadId ? <Link to={`/leads?open=${c.leadId}`} className="hover:underline">{c.displayName}</Link> : c.displayName}
            </p>
            <p className="text-[13px] text-stone">{fmtPhone(c.phone)}{contactKind ? ` · ${contactKind === 'client' ? 'Client' : 'New client'}` : ' · Unknown number'}</p>
          </div>
          <a href={`tel:${c.phone}`} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line-strong bg-white px-2.5 text-[13px] font-medium hover:bg-mist"><Phone className="h-4 w-4" /><span className="hidden sm:inline">Call</span></a>
          <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => newFollowUp({
            contact: c.clientId ? { kind: 'client', id: c.clientId, name: c.displayName, phone: c.phone } : c.leadId ? { kind: 'lead', id: c.leadId, name: c.displayName, phone: c.phone } : undefined,
          })}><span className="hidden sm:inline">Follow-up</span></Button>
          {canDelete && <Button size="sm" variant="ghost" aria-label="Delete conversation" title="Delete conversation" icon={<Trash2 className="h-4 w-4" />} onClick={removeConversation} />}
        </header>

        {insight && (insight.isPotentialLead || insight.service || insight.timeframe) && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-plum-tint/50 px-4 py-2.5 text-[13px]">
            <span className="inline-flex items-center gap-1.5 font-medium text-plum"><Sparkles className="h-4 w-4" />{insight.isPotentialLead ? 'Potential client' : 'Request'}</span>
            {insight.service && <span className="text-ink-soft"><span className="text-stone">Service:</span> {insight.service}</span>}
            {insight.timeframe && <span className="text-ink-soft"><span className="text-stone">Timeframe:</span> {insight.timeframe}</span>}
            <span className="ml-auto flex gap-2">
              {!contactKind && <Button size="sm" variant="secondary" icon={<UserPlus className="h-4 w-4" />} onClick={() => setLeadOpen(true)}>Save as client</Button>}
              {aiEnabled && <Button size="sm" variant="primary" icon={<Sparkles className="h-4 w-4" />} onClick={draft} loading={drafting}>Generate reply</Button>}
            </span>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-4 py-5 sm:px-6">
          {messages.length === 0 && <p className="py-10 text-center text-sm text-stone">No messages yet. Say hello below.</p>}
          <div className="mx-auto max-w-2xl space-y-2">
            {messages.map((m) => {
              const day = dateShort(m.createdAt);
              const sep = day !== lastDay;
              lastDay = day;
              const out = m.direction === 'outbound';
              return (
                <div key={m.id}>
                  {sep && <p className="py-3 text-center text-[11px] uppercase tracking-wider text-stone-light">{day}</p>}
                  <div className={cx('flex', out ? 'justify-end' : 'justify-start')}>
                    <div className={cx('max-w-[80%] rounded-2xl px-3.5 py-2 text-[15px] leading-snug shadow-sm', out ? 'rounded-br-md bg-plum text-white' : 'rounded-bl-md bg-white text-ink ring-1 ring-line')}>
                      <p className="whitespace-pre-wrap break-words">{m.body}</p>
                      <p className={cx('mt-1 flex items-center justify-end gap-1 text-[10.5px]', out ? 'text-white/60' : 'text-stone')}>
                        {m.aiGenerated && <Sparkles className="h-3 w-3" aria-label="Drafted with AI" />}
                        {out && m.sentByName && <span>{m.sentByName} ·</span>}
                        {time(m.createdAt)}
                        {out && m.status === 'delivered' && <CheckCheck className="h-3.5 w-3.5" aria-label="Delivered" />}
                        {out && m.status === 'sent' && <Check className="h-3.5 w-3.5" aria-label="Sent" />}
                        {out && (m.status === 'failed' || m.status === 'undelivered' || m.status === 'queued') && <span className={cx(m.status !== 'queued' && 'text-rose-tint')}>{STATUS_LABEL[m.status]}</span>}
                        {out && (m.status === 'opened_in_messages' || m.status === 'marked_sent' || m.status === 'not_sent') && <span>· {STATUS_LABEL[m.status]}</span>}
                      </p>
                      {out && m.status === 'opened_in_messages' && (
                        <p className="mt-1.5 flex justify-end gap-1.5 text-[11px]">
                          <button className="rounded-full bg-white/15 px-2 py-0.5 hover:bg-white/25 disabled:opacity-50" disabled={sending} onClick={() => markOutcome(m.id, 'sent')}>I sent it</button>
                          <button className="rounded-full px-2 py-0.5 text-white/70 hover:bg-white/10 disabled:opacity-50" disabled={sending} onClick={() => markOutcome(m.id, 'not_sent')}>Not sent</button>
                        </p>
                      )}
                      {m.errorMessage && <p className="mt-1 flex items-center gap-1 text-[11px] text-rose-tint"><AlertCircle className="h-3 w-3" />{m.errorMessage}</p>}
                    </div>
                    {canDelete && <button className={cx('self-center rounded-lg p-1.5 text-stone-light hover:bg-mist hover:text-rose', out ? 'order-first mr-1' : 'ml-1')} onClick={() => removeMessage(m.id)} aria-label="Delete message" title="Delete message"><Trash2 className="h-3.5 w-3.5" /></button>}
                  </div>
                </div>
              );
            })}
            <div ref={endRef} />
          </div>
        </div>

        <div className="border-t border-line bg-white px-3 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-4">
          {c.optedOut ? (
            <p className="flex items-center gap-2 rounded-lg bg-rose-tint px-3 py-2 text-sm text-rose"><MessageSquareOff className="h-4 w-4" />This person replied STOP and has opted out of texts. Call them instead.</p>
          ) : (
            <div className="mx-auto max-w-2xl">
              {aiUsed && <p className="mb-1.5 text-xs text-stone">AI draft — review and edit it. It opens in Messages for you to send.</p>}
              <div className="flex items-end gap-2">
                <textarea
                  className="field max-h-48 min-h-[44px] flex-1 resize-none py-2.5 leading-snug"
                  rows={body.split('\n').length > 2 || body.length > 90 ? 4 : 1}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && body.trim()) send(); }}
                  placeholder={drafting ? 'Writing a draft…' : 'Text message'}
                  maxLength={1600}
                  aria-label="Reply"
                />
                <SavedRepliesPicker placement="up" size="md" context={{ clientId: c.clientId, leadId: c.leadId, conversationId: id }} onPick={(text) => { setBody(text); setAiUsed(false); }} />
                {aiEnabled && (
                  <Button variant="secondary" className="h-11" icon={<Sparkles className="h-4 w-4 text-plum" />} onClick={draft} loading={drafting} title="Draft a reply with AI">
                    <span className="hidden sm:inline">Draft</span>
                  </Button>
                )}
                <Button variant="primary" className="h-11" icon={<Send className="h-4 w-4" />} onClick={send} disabled={!body.trim()}>Text</Button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Context panel */}
      <aside className="hidden w-[280px] shrink-0 overflow-y-auto border-l border-line bg-white px-5 py-5 xl:block">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-stone">Who this is</p>
        {contactKind ? (
          <div className="mt-2">
            <p className="font-display text-xl">{c.displayName}</p>
            <Badge tone={contactKind === 'lead' ? 'plum' : 'neutral'} className="mt-1">{contactKind === 'client' ? 'Client' : 'New client'}</Badge>
            <Button size="sm" className="mt-3 w-full" onClick={() => nav(contactKind === 'client' ? `/clients/${c.clientId}` : `/leads?open=${c.leadId}`)}>Open {contactKind === 'client' ? 'client profile' : 'client'}</Button>
          </div>
        ) : (
          <div className="mt-2 text-sm text-stone">
            Not matched to a client yet.
            <Button size="sm" className="mt-3 w-full" icon={<UserPlus className="h-4 w-4" />} onClick={() => setLeadOpen(true)}>Save as client</Button>
          </div>
        )}
        <p className="mt-6 text-[11px] font-semibold uppercase tracking-wider text-stone">Next appointment</p>
        {upcomingAppointment ? (
          <div className="mt-2 rounded-xl border border-line p-3">
            <p className="flex items-center gap-2 text-sm font-medium"><CalendarDays className="h-4 w-4 text-stone" />{dateTime(upcomingAppointment.startAt)}</p>
            {upcomingAppointment.services && <p className="mt-1 text-[13px] text-ink-soft">{upcomingAppointment.services}</p>}
            {upcomingAppointment.staffName && <p className="text-[13px] text-stone">with {upcomingAppointment.staffName}</p>}
            <p className="mt-2 text-[11px] text-stone-light">From Square</p>
          </div>
        ) : <p className="mt-2 text-sm text-stone">None booked in Square.</p>}
        {insight?.summary && (
          <>
            <p className="mt-6 text-[11px] font-semibold uppercase tracking-wider text-stone">Latest message</p>
            <p className="mt-2 text-sm text-ink-soft">{insight.summary}</p>
          </>
        )}
      </aside>

      {leadOpen && <SaveLeadModal convo={c} onClose={() => setLeadOpen(false)} />}
    </div>
  );
}

function SaveLeadModal({ convo, onClose }: { convo: ConversationDTO; onClose: () => void }) {
  const [name, setName] = useState(/^Text (lead|client)\b/.test(convo.displayName) || convo.displayName.startsWith('+') ? '' : convo.displayName);
  const [saving, setSaving] = useState(false);
  const toast = useToast();
  const refresh = useRefreshAll();
  const save = async () => {
    setSaving(true);
    try {
      await api.post(`/messages/conversations/${convo.id}/create-lead`, { name });
      toast('Saved as a client · follow-up created');
      refresh();
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal open onClose={onClose} title="Save as client" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save} loading={saving} disabled={!name.trim()}>Save client</Button></>}>
      <Field label="Their name" hint={`${fmtPhone(convo.phone)}${convo.insight?.service ? ` · interested in ${convo.insight.service}` : ''}`}>
        <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Jordan Lee" />
      </Field>
    </Modal>
  );
}

function NewMessageModal({ onClose }: { onClose: () => void }) {
  const { compose } = useActions();
  const [picked, setPicked] = useState<PickedContact | null>(null);
  const [rawPhone, setRawPhone] = useState('');
  const go = () => {
    onClose();
    if (picked) compose({ name: picked.name, phone: picked.phone, clientId: picked.kind === 'client' ? picked.id : null, leadId: picked.kind === 'lead' ? picked.id : null });
    else compose({ name: rawPhone, phone: rawPhone });
  };
  return (
    <Modal open onClose={onClose} title="New message" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={go} disabled={!picked && rawPhone.replace(/\D/g, '').length < 10}>Continue</Button></>}>
      <Field label="To a client"><ContactPicker value={picked} onChange={setPicked} /></Field>
      {!picked && (
        <Field label="Or a phone number" className="mt-4" hint="Only text people who have given you permission to text them.">
          <input className="field" inputMode="tel" value={rawPhone} onChange={(e) => setRawPhone(e.target.value)} placeholder="(619) 555-0123" />
        </Field>
      )}
    </Modal>
  );
}

const SAMPLE_TEXTS = [
  "Hi, I'm looking to get my hair colored next week. Do you have anything Thursday?",
  'Hey! How much are extensions? Thinking about getting them before a wedding in June',
  'Yes, confirming my appointment tomorrow, thank you!',
  "So sorry, something came up — can I move my appointment to next week?",
];

/** DEMO ONLY: pretend a client texted the salon, to try reply drafting and saved replies. */
function SimulateInboundModal({ onClose }: { onClose: () => void }) {
  const [from, setFrom] = useState('');
  const [picked, setPicked] = useState<PickedContact | null>(null);
  const [body, setBody] = useState(SAMPLE_TEXTS[0]);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const refresh = useRefreshAll();
  const nav = useNavigate();
  const send = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ conversationId: string }>('/demo/inbound-sms', {
        body, clientId: picked?.kind === 'client' ? picked.id : undefined, from: picked?.kind === 'lead' ? picked.phone ?? undefined : from || undefined,
      });
      toast('Incoming text received');
      refresh();
      onClose();
      if (r.conversationId) nav(`/messages/${r.conversationId}`);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title="Simulate an incoming text" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={send} loading={busy} disabled={!body.trim()}>Receive text</Button></>}>
      <p className="mb-4 rounded-lg bg-plum-tint px-3 py-2 text-[13px] text-plum">Demo Mode: pretends a client texted the salon so you can try drafting and saved replies. In real use, client replies arrive in Apple Messages, not in the CRM.</p>
      <Field label="From an existing client (optional)"><ContactPicker value={picked} onChange={setPicked} /></Field>
      {!picked && <Field label="Or a new number" className="mt-3" hint="Leave blank to use a random unknown number."><input className="field" value={from} onChange={(e) => setFrom(e.target.value)} placeholder="(619) 555-0199" /></Field>}
      <Field label="Message" className="mt-3"><textarea className="field min-h-[90px]" value={body} onChange={(e) => setBody(e.target.value)} /></Field>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {SAMPLE_TEXTS.map((t) => <button key={t} onClick={() => setBody(t)} className="rounded-full bg-mist px-2.5 py-1 text-xs text-ink-soft hover:bg-line">{t.slice(0, 32)}…</button>)}
      </div>
    </Modal>
  );
}
