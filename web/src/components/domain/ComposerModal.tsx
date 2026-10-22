import { useEffect, useState } from 'react';
import { AlertCircle, Check, Copy, ExternalLink, MessageSquare, Phone, Sparkles } from 'lucide-react';
import type { MessageDTO } from '@addendum/shared';
import { api } from '../../api/client';
import { useRefreshAll, useSettings } from '../../api/hooks';
import { phone as fmtPhone } from '../../lib/format';
import { openSmsLink, smsLink } from '../../lib/sms';
import { Button, Modal, useToast } from '../ui';
import { SavedRepliesPicker } from './SavedRepliesPicker';

export interface ComposerTarget {
  name: string;
  phone?: string | null;
  clientId?: string | null;
  leadId?: string | null;
  conversationId?: string | null;
  taskId?: string | null;
  /** Generate a draft immediately (e.g. "Text" on a follow-up). */
  autoDraft?: boolean;
  initialBody?: string;
  /** The initial body came from an AI draft. */
  initialAiGenerated?: boolean;
}

/**
 * Text composer. Staff review (or AI-draft) the message here, then it opens in Apple Messages with the
 * number and text filled in, and they send it there. The CRM can't see Messages, so afterwards it asks
 * whether the text was sent instead of assuming it was.
 */
export function ComposerModal({ target, onClose }: { target: ComposerTarget; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefreshAll();
  const { data: settings } = useSettings();
  const [body, setBody] = useState(target.initialBody ?? '');
  const [aiUsed, setAiUsed] = useState(!!target.initialAiGenerated);
  const [drafting, setDrafting] = useState(false);
  const [opening, setOpening] = useState(false);
  const [completeTask, setCompleteTask] = useState(!!target.taskId);
  // After hand-off: the logged message, the number it went to, and whether Messages appeared to open.
  const [handoff, setHandoff] = useState<{ message: MessageDTO; phone: string; href: string; opened: boolean | null } | null>(null);
  const [marking, setMarking] = useState<'sent' | 'not_sent' | null>(null);
  const aiEnabled = settings?.settings.ai.enabled !== false;
  // The booking link only goes in when someone ticks "Add booking link" (drafts leave it out).
  const bookingUrl = settings?.settings.business.bookingUrl?.trim() ?? '';
  const bookingLine = bookingUrl ? `Book here: ${bookingUrl}` : '';
  const hasBooking = !!bookingLine && body.includes(bookingLine);
  const toggleBooking = (on: boolean) => setBody((b) => (on
    ? (b.includes(bookingLine) ? b : `${b.trimEnd()}${b.trim() ? '\n' : ''}${bookingLine}`)
    : b.replace(`\n${bookingLine}`, '').replace(bookingLine, '').trimEnd()));

  const draft = async () => {
    setDrafting(true);
    try {
      const r = await api.post<{ draft: string }>('/messages/draft', {
        clientId: target.clientId ?? undefined, leadId: target.leadId ?? undefined,
        conversationId: target.conversationId ?? undefined, taskId: target.taskId ?? undefined,
      });
      setBody(r.draft);
      setAiUsed(true);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setDrafting(false);
    }
  };

  useEffect(() => {
    if (target.autoDraft && aiEnabled && !body) void draft();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openInMessages = async () => {
    setOpening(true);
    try {
      // Checks the number and opt-outs, and logs the text as "opened in Messages". Nothing is sent by the CRM.
      const r = await api.post<{ phone: string; message: MessageDTO }>('/messages/handoff', {
        body, aiGenerated: aiUsed,
        clientId: target.clientId ?? undefined, leadId: target.leadId ?? undefined,
        conversationId: target.conversationId ?? undefined, phone: target.phone ?? undefined,
        taskId: target.taskId ?? undefined,
      });
      const href = smsLink(r.phone, body);
      setHandoff({ message: r.message, phone: r.phone, href, opened: null });
      refresh();
      const opened = await openSmsLink(href);
      setHandoff((h) => (h ? { ...h, opened } : h));
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setOpening(false);
    }
  };

  const mark = async (outcome: 'sent' | 'not_sent') => {
    if (!handoff) return;
    setMarking(outcome);
    try {
      await api.post(`/messages/${handoff.message.id}/outcome`, { outcome, completeTaskId: outcome === 'sent' && completeTask && target.taskId ? target.taskId : undefined });
      toast(outcome === 'sent' ? (completeTask && target.taskId ? 'Marked as sent · follow-up completed' : 'Marked as sent') : 'Noted — not sent');
      refresh();
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setMarking(null);
    }
  };

  const copy = (text: string, what: string) =>
    navigator.clipboard?.writeText(text).then(() => toast(`${what} copied`), () => toast('Copy failed — select the text and copy it instead', 'error'));

  if (handoff) {
    return (
      <Modal
        open onClose={onClose} title={`Text ${target.name}`}
        footer={
          <>
            <Button variant="ghost" className="mr-auto" loading={marking === 'not_sent'} disabled={!!marking} onClick={() => mark('not_sent')}>I didn't send it</Button>
            <Button variant="primary" icon={<Check className="h-4 w-4" />} loading={marking === 'sent'} disabled={!!marking} onClick={() => mark('sent')}>I sent it</Button>
          </>
        }
      >
        {handoff.opened === false ? (
          <div className="rounded-xl bg-amber-tint px-4 py-3 text-sm text-ink-soft">
            <p className="flex items-center gap-2 font-medium text-amber"><AlertCircle className="h-4 w-4" />Messages didn't seem to open</p>
            <p className="mt-1.5">This computer may not have Messages set up, or the browser blocked it. You can:</p>
            <ul className="mt-1.5 list-disc space-y-1 pl-5">
              <li><a className="font-medium text-plum underline" href={handoff.href}>Try opening Messages again</a> (if the browser asks, allow it to open Messages).</li>
              <li>Copy the number and message below and send them from your phone.</li>
              <li>On a Mac, open Messages and sign in with the salon's Apple Account. To text Android phones, also turn on Text Message Forwarding on the iPhone (Settings → Apps → Messages).</li>
            </ul>
          </div>
        ) : (
          <p className="flex items-start gap-2 rounded-xl bg-mist px-4 py-3 text-sm text-ink-soft">
            <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-plum" />
            <span>{handoff.opened === null ? 'Opening Messages…' : 'Messages should now be open with the text filled in.'} Review it and press send there, then come back and tell us whether it went out.</span>
          </p>
        )}
        <div className="mt-4 space-y-2">
          <div className="flex items-center justify-between gap-2 rounded-xl border border-line px-3 py-2">
            <span className="text-sm"><span className="text-stone">To </span>{fmtPhone(handoff.phone)}</span>
            <Button size="sm" variant="quiet" icon={<Copy className="h-4 w-4" />} onClick={() => copy(handoff.phone, 'Number')}>Copy</Button>
          </div>
          <div className="rounded-xl border border-line px-3 py-2">
            <p className="whitespace-pre-wrap text-sm text-ink-soft">{body}</p>
            <div className="mt-1 flex justify-end"><Button size="sm" variant="quiet" icon={<Copy className="h-4 w-4" />} onClick={() => copy(body, 'Message')}>Copy</Button></div>
          </div>
        </div>
        {handoff.opened !== false && <a href={handoff.href} className="mt-3 inline-flex items-center gap-1.5 text-[13px] text-stone hover:text-ink"><ExternalLink className="h-3.5 w-3.5" />Open Messages again</a>}
        {target.taskId && (
          <label className="mt-4 flex items-center gap-2 text-sm text-ink-soft">
            <input type="checkbox" className="h-4 w-4 accent-plum" checked={completeTask} onChange={(e) => setCompleteTask(e.target.checked)} />
            Mark this follow-up complete when I confirm it was sent
          </label>
        )}
        <p className="mt-3 text-xs text-stone">The CRM can't see Messages, so it only records what you tell it here — not delivery.</p>
      </Modal>
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Text ${target.name}`}
      footer={
        <>
          {target.phone && <a href={`tel:${target.phone}`} className="mr-auto inline-flex items-center gap-1.5 text-sm text-stone hover:text-ink"><Phone className="h-4 w-4" /> Call instead</a>}
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={<MessageSquare className="h-4 w-4" />} onClick={openInMessages} loading={opening} disabled={!body.trim()}>Open in Messages</Button>
        </>
      }
    >
      {target.phone && <p className="mb-3 text-sm text-stone">To {fmtPhone(target.phone)} · sends from Messages on this device</p>}
      <textarea
        className="field min-h-[150px] resize-y leading-relaxed"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={drafting ? 'Writing a draft…' : 'Write a message…'}
        maxLength={1600}
        aria-label="Message"
      />
      <div className="mt-2 flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-1 flex-wrap items-center gap-1">
          {aiEnabled && (
            <Button variant="quiet" size="sm" icon={<Sparkles className="h-4 w-4" />} onClick={draft} loading={drafting}>
              {body ? 'Write a new draft' : 'Draft it for me'}
            </Button>
          )}
        </div>
        <span className="pt-2 text-xs text-stone">{body.length} characters</span>
      </div>
      {bookingLine && (
        <label className="mt-1 flex items-center gap-2 text-[13px] text-ink-soft">
          <input type="checkbox" className="h-4 w-4 accent-plum" checked={hasBooking} onChange={(e) => toggleBooking(e.target.checked)} />Add booking link
        </label>
      )}
      <SavedRepliesPicker
        placement="inline" className="mt-1"
        context={{ clientId: target.clientId, leadId: target.leadId, conversationId: target.conversationId, taskId: target.taskId }}
        onPick={(text) => { setBody(text); setAiUsed(false); }}
      />
      <p className="mt-2 text-xs text-stone">{aiUsed ? 'Drafted with AI — review it. ' : ''}You can still edit the text in Messages before you send it. Nothing is sent from the CRM.</p>
    </Modal>
  );
}
