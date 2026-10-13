import type { ConversationDTO, DraftKind, MessageDTO, MessageInsight, ReplySituation, SuggestedReply } from '@addendum/shared';
import { db } from '../db/index.js';
import { badRequest, IntegrationError, notFound } from '../lib/errors.js';
import { toE164 } from '../lib/phone.js';
import { formatDateShort, formatTime, localHourMinute } from '../lib/time.js';
import { aiService } from '../integrations/registry.js';
import { notifications } from '../integrations/notifications/NotificationService.js';
import { getSettings } from '../repos/settings.js';
import { iso } from '../lib/time.js';
import { renderTemplate } from '../lib/template.js';
import { completeTask } from './tasks.js';
import { syncCompletionToHighLevel } from './highlevelPush.js';

const OPT_OUT = /^\s*(stop|stopall|unsubscribe|cancel|end|quit)\s*$/i;
const OPT_IN = /^\s*(start|unstop|yes)\s*$/i;

const CONVO_SELECT = `
  SELECT cv.*, COALESCE(NULLIF(trim(c.first_name || ' ' || c.last_name), ''), l.name) AS display_name,
         COALESCE(c.sms_opted_out, l.sms_opted_out, false) AS opted_out,
         (SELECT body FROM messages m WHERE m.conversation_id = cv.id ORDER BY m.created_at DESC LIMIT 1) AS preview
    FROM conversations cv LEFT JOIN clients c ON c.id = cv.client_id LEFT JOIN leads l ON l.id = cv.lead_id`;

export function toConversationDTO(r: any): ConversationDTO {
  return {
    id: r.id,
    phone: r.phone,
    displayName: r.display_name || r.phone,
    clientId: r.client_id,
    leadId: r.lead_id,
    unreadCount: r.unread_count,
    lastMessageAt: iso(r.last_message_at),
    lastMessagePreview: r.preview ?? null,
    optedOut: !!r.opted_out,
    insight: r.insight ?? null,
  };
}

export async function listConversations(filter: { unread?: boolean; q?: string; staffClientIds?: string[] } = {}) {
  const where: string[] = ['cv.archived_at IS NULL'];
  const p: unknown[] = [];
  if (filter.unread) where.push('cv.unread_count > 0');
  if (filter.q) {
    p.push(`%${filter.q}%`);
    where.push(`(COALESCE(c.first_name || ' ' || c.last_name, l.name, '') ILIKE $${p.length} OR cv.phone ILIKE $${p.length})`);
  }
  const rows = await db().query(`${CONVO_SELECT} WHERE ${where.join(' AND ')} ORDER BY cv.last_message_at DESC NULLS LAST LIMIT 200`, p);
  return rows.map(toConversationDTO);
}

export async function getConversation(id: string) {
  const row = await db().one(`${CONVO_SELECT} WHERE cv.id = $1`, [id]);
  if (!row) throw notFound('That conversation');
  const msgs = await db().query<any>(
    `SELECT m.*, s.name AS sent_by_name FROM messages m LEFT JOIN staff s ON s.id = m.sent_by_staff_id
      WHERE m.conversation_id = $1 ORDER BY m.created_at`,
    [id],
  );
  return { conversation: toConversationDTO(row), messages: msgs.map(toMessageDTO) };
}

export function toMessageDTO(m: any): MessageDTO {
  return {
    id: m.id,
    conversationId: m.conversation_id,
    direction: m.direction,
    body: m.body,
    status: m.status,
    aiGenerated: m.ai_generated,
    sentByName: m.sent_by_name ?? null,
    createdAt: iso(m.created_at)!,
    errorMessage: m.error_message,
  };
}

/** Finds or creates the conversation for a phone number and links it to the matching client or lead. */
export async function conversationForPhone(phone: string) {
  const existing = await db().one<any>('SELECT * FROM conversations WHERE phone = $1', [phone]);
  const client = await db().one<{ id: string }>('SELECT id FROM clients WHERE phone = $1 AND archived_at IS NULL ORDER BY created_at LIMIT 1', [phone]);
  const lead = await db().one<{ id: string }>(
    `SELECT id FROM leads WHERE phone = $1 AND archived_at IS NULL ORDER BY created_at DESC LIMIT 1`, [phone]);
  if (existing) {
    if ((!existing.client_id && client) || (!existing.lead_id && lead)) {
      await db().query('UPDATE conversations SET client_id = COALESCE(client_id, $2), lead_id = COALESCE(lead_id, $3) WHERE id = $1', [
        existing.id, client?.id ?? null, lead?.id ?? null,
      ]);
    }
    return { ...existing, client_id: existing.client_id ?? client?.id ?? null, lead_id: existing.lead_id ?? lead?.id ?? null };
  }
  const rows = await db().query<any>(
    `INSERT INTO conversations(phone, client_id, lead_id) VALUES ($1,$2,$3)
     ON CONFLICT (phone) DO UPDATE SET updated_at = now() RETURNING *`,
    [phone, client?.id ?? null, lead?.id ?? null],
  );
  return rows[0];
}

/** Handles an inbound SMS from the provider webhook (or the demo simulator). */
export async function handleInboundSms(input: { from: string; body: string; providerMessageId?: string }) {
  const phone = toE164(input.from);
  if (!phone) throw badRequest('Invalid sender number');
  if (input.providerMessageId) {
    const dup = await db().one('SELECT id FROM messages WHERE provider_message_id = $1', [input.providerMessageId]);
    if (dup) return { duplicate: true };
  }
  const settings = await getSettings();
  let convo = await conversationForPhone(phone);
  const body = input.body.slice(0, 2000);

  // Carrier-required keywords: STOP opts out, START opts back in. (Twilio also enforces these.)
  if (OPT_OUT.test(body)) {
    await db().query('UPDATE clients SET sms_opted_out = true WHERE phone = $1', [phone]);
    await db().query('UPDATE leads SET sms_opted_out = true WHERE phone = $1', [phone]);
  } else if (OPT_IN.test(body) && /^\s*(start|unstop)\s*$/i.test(body)) {
    await db().query('UPDATE clients SET sms_opted_out = false WHERE phone = $1', [phone]);
    await db().query('UPDATE leads SET sms_opted_out = false WHERE phone = $1', [phone]);
  }

  const insight: MessageInsight = settings.ai.enabled ? await aiService().analyze(body) : { intent: 'general', isPotentialLead: false, service: null, timeframe: null, summary: '' };

  // Unknown number asking about services → create a lead automatically (configurable).
  if (!convo.client_id && !convo.lead_id && insight.isPotentialLead && settings.messaging.autoCreateLeadFromUnknown) {
    const lead = await db().one<{ id: string }>(
      `INSERT INTO leads(name, phone, source, service_interest, status, last_inbound_at, notes)
       VALUES ($1,$2,'Text message',$3,'new', now(), $4) RETURNING id`,
      [`Text lead ${phone.slice(-4)}`, phone, insight.service, insight.timeframe ? `Timeframe: ${insight.timeframe}` : null],
    );
    await db().query('UPDATE conversations SET lead_id = $2 WHERE id = $1', [convo.id, lead!.id]);
    convo = { ...convo, lead_id: lead!.id };
  }
  if (convo.lead_id) {
    await db().query(
      `UPDATE leads SET last_inbound_at = now(),
         status = CASE WHEN status IN ('contacted','waiting','follow_up_needed') THEN 'interested' ELSE status END,
         service_interest = COALESCE(service_interest, $2), updated_at = now() WHERE id = $1`,
      [convo.lead_id, insight.service],
    );
  }
  // "C" / "yes" after a reminder confirms the next appointment.
  if (insight.intent === 'confirm' && convo.client_id) {
    await db().query(
      `UPDATE appointments SET client_confirmed_at = now() WHERE id = (
         SELECT id FROM appointments WHERE client_id = $1 AND square_status = 'ACCEPTED' AND start_at > now() AND start_at < now() + interval '4 days'
          ORDER BY start_at LIMIT 1)`,
      [convo.client_id],
    );
  }

  const msg = await db().one<any>(
    `INSERT INTO messages(conversation_id, direction, body, status, provider_message_id) VALUES ($1,'inbound',$2,'received',$3) RETURNING *`,
    [convo.id, body, input.providerMessageId ?? null],
  );
  await db().query(
    `UPDATE conversations SET unread_count = unread_count + 1, last_message_at = now(), last_inbound_at = now(), insight = $2::jsonb, archived_at = NULL, updated_at = now() WHERE id = $1`,
    [convo.id, JSON.stringify(insight)],
  );
  const name = await displayNameFor(convo);
  await notifications.notify({ kind: 'message', title: `New text from ${name}`, body: body.slice(0, 120), link: `/messages/${convo.id}` });
  return { conversationId: convo.id, messageId: msg!.id, insight };
}

async function displayNameFor(convo: any) {
  if (convo.client_id) {
    const c = await db().one<any>("SELECT trim(first_name || ' ' || last_name) AS n FROM clients WHERE id = $1", [convo.client_id]);
    if (c?.n) return c.n;
  }
  if (convo.lead_id) {
    const l = await db().one<any>('SELECT name FROM leads WHERE id = $1', [convo.lead_id]);
    if (l?.name) return l.name;
  }
  return convo.phone;
}

export async function markConversationRead(id: string) {
  await db().query('UPDATE conversations SET unread_count = 0, updated_at = now() WHERE id = $1', [id]);
}

/**
 * Texts go out from Apple Messages on the staff member's own device, never from the server.
 * Step 1 (startText): check there's a number and the person hasn't opted out, then log the text as
 * "opened in Messages" and hand back the number so the browser can open Messages with it prefilled.
 * Step 2 (finishText): the staff member says whether they sent it. The CRM can't see Messages, so
 * "marked sent" means "a person said so", never a delivery receipt.
 */
export async function startText(input: {
  conversationId?: string;
  phone?: string;
  clientId?: string;
  leadId?: string;
  body: string;
  staffId: string;
  aiGenerated?: boolean;
  taskId?: string;
}) {
  const body = input.body.trim();
  if (!body) throw badRequest('Message is empty.');
  if (body.length > 1600) throw badRequest('That message is too long for a text (1,600 characters max).');

  let phone = input.phone ? toE164(input.phone) : null;
  if (!phone && input.conversationId) phone = (await db().one<any>('SELECT phone FROM conversations WHERE id = $1', [input.conversationId]))?.phone ?? null;
  if (!phone && input.clientId) phone = (await db().one<any>('SELECT phone FROM clients WHERE id = $1', [input.clientId]))?.phone ?? null;
  if (!phone && input.leadId) phone = (await db().one<any>('SELECT phone FROM leads WHERE id = $1', [input.leadId]))?.phone ?? null;
  if (!phone) throw badRequest('There is no mobile number on file for this person.');

  const optedOut = await db().one<any>(
    `SELECT 1 FROM clients WHERE phone = $1 AND sms_opted_out UNION SELECT 1 FROM leads WHERE phone = $1 AND sms_opted_out LIMIT 1`, [phone]);
  if (optedOut) throw badRequest('This person opted out of texts (replied STOP). Call them instead.');

  const convo = await conversationForPhone(phone);
  if (input.leadId && !convo.lead_id) await db().query('UPDATE conversations SET lead_id = $2 WHERE id = $1', [convo.id, input.leadId]);
  if (input.clientId && !convo.client_id) await db().query('UPDATE conversations SET client_id = $2 WHERE id = $1', [convo.id, input.clientId]);

  const msg = await db().one<any>(
    `INSERT INTO messages(conversation_id, direction, body, status, ai_generated, sent_by_staff_id, task_id)
     VALUES ($1,'outbound',$2,'opened_in_messages',$3,$4,$5) RETURNING *`,
    [convo.id, body, !!input.aiGenerated, input.staffId, input.taskId ?? null],
  );
  await db().query('UPDATE conversations SET last_message_at = now(), unread_count = 0, archived_at = NULL, updated_at = now() WHERE id = $1', [convo.id]);
  return { conversationId: convo.id, phone, message: toMessageDTO({ ...msg, sent_by_name: null }) };
}

/** Records what the staff member says happened in Messages. Only a text still "opened in Messages" can change. */
export async function finishText(messageId: string, staffId: string, outcome: 'sent' | 'not_sent', completeTaskId?: string) {
  const msg = await db().one<any>(
    `UPDATE messages SET status = $2, updated_at = now() WHERE id = $1 AND direction = 'outbound' AND status = 'opened_in_messages' RETURNING *`,
    [messageId, outcome === 'sent' ? 'marked_sent' : 'not_sent'],
  );
  if (!msg) {
    const exists = await db().one('SELECT 1 FROM messages WHERE id = $1', [messageId]);
    if (!exists) throw notFound('That text');
    throw badRequest('This text was already marked.');
  }
  if (outcome === 'sent') {
    const convo = await db().one<any>('SELECT lead_id FROM conversations WHERE id = $1', [msg.conversation_id]);
    if (convo?.lead_id) {
      await db().query(
        `UPDATE leads SET last_contact_at = now(),
           status = CASE WHEN status IN ('new','follow_up_needed') THEN 'waiting' ELSE status END, updated_at = now() WHERE id = $1`,
        [convo.lead_id],
      );
    }
    const taskId = completeTaskId ?? null;
    if (taskId) {
      await completeTask(taskId, staffId, 'Texted from Apple Messages.');
      await syncCompletionToHighLevel(taskId, true);
    }
  }
  return toMessageDTO({ ...msg, sent_by_name: null });
}

export function inQuietHours(now: Date, start: string, end: string, tz: string) {
  const { h, m } = localHourMinute(now, tz);
  const cur = h * 60 + m;
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  const s = sh * 60 + sm;
  const e = eh * 60 + em;
  return s > e ? cur >= s || cur < e : cur >= s && cur < e;
}

type DraftInput = { kind?: DraftKind; conversationId?: string; clientId?: string; leadId?: string; taskId?: string };

/** Everything known about the person being texted: used by AI drafts and saved replies alike. */
async function messageContext(input: DraftInput) {
  const settings = await getSettings();
  const tz = settings.business.timezone;
  let { clientId, leadId } = input;
  let kind: DraftKind = input.kind ?? 'general_reply';
  let insight: MessageInsight | null = null;
  let recent: { direction: 'inbound' | 'outbound'; body: string }[] = [];
  let appointmentText: string | null = null;
  let service: string | null = null;
  let staffName: string | null = null;
  let appointmentDate: string | null = null;
  let appointmentTime: string | null = null;
  let taskType: string | null = null;

  if (input.taskId) {
    const t = await db().one<any>('SELECT * FROM tasks WHERE id = $1', [input.taskId]);
    if (t) {
      taskType = t.type;
      clientId ??= t.client_id;
      leadId ??= t.lead_id;
      if (!input.kind) {
        kind = ({ rebook: 'rebooking', no_show: 'no_show', cancellation: 'cancellation', review_request: 'review_request',
          appointment_reminder: 'appointment_reminder', new_lead: 'lead_reply', consultation: 'appointment_follow_up' } as Record<string, DraftKind>)[t.type] ?? 'general_reply';
      }
      if (t.appointment_id) {
        const a = await db().one<any>(
          `SELECT a.start_at, s.name AS staff, (SELECT string_agg(service_name, ', ') FROM appointment_services x WHERE x.appointment_id = a.id) AS svc
             FROM appointments a LEFT JOIN staff s ON s.id = a.staff_id WHERE a.id = $1`, [t.appointment_id]);
        if (a) {
          appointmentDate = formatDateShort(a.start_at, tz);
          appointmentTime = formatTime(a.start_at, tz);
          appointmentText = `${appointmentDate} at ${appointmentTime}`;
          service = a.svc;
          staffName = a.staff;
        }
      }
    }
  }
  if (input.conversationId) {
    const c = await db().one<any>('SELECT * FROM conversations WHERE id = $1', [input.conversationId]);
    if (c) {
      clientId ??= c.client_id;
      leadId ??= c.lead_id;
      insight = c.insight;
      recent = (await db().query<any>('SELECT direction, body FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 8', [c.id])).reverse();
      if (!input.kind && insight?.isPotentialLead && !clientId) kind = 'lead_reply';
    }
  }
  let firstName = '';
  let lastVisitText: string | null = null;
  if (clientId) {
    const c = await db().one<any>(
      `SELECT c.first_name, s.name AS pref FROM clients c LEFT JOIN staff s ON s.id = c.preferred_staff_id WHERE c.id = $1`, [clientId]);
    firstName = c?.first_name ?? '';
    staffName ??= c?.pref ?? null;
    const last = await db().one<any>(
      `SELECT a.start_at, (SELECT string_agg(service_name, ', ') FROM appointment_services x WHERE x.appointment_id = a.id) AS svc
         FROM appointments a WHERE a.client_id = $1 AND a.square_status = 'ACCEPTED' AND a.end_at < now() ORDER BY a.start_at DESC LIMIT 1`, [clientId]);
    if (last) {
      lastVisitText = `${formatDateShort(last.start_at, tz)} — ${last.svc}`;
      service ??= last.svc;
    }
  } else if (leadId) {
    const l = await db().one<any>('SELECT name, service_interest FROM leads WHERE id = $1', [leadId]);
    firstName = l?.name?.startsWith('Text lead') ? '' : (l?.name?.split(' ')[0] ?? '');
    service ??= l?.service_interest ?? null;
    if (!input.kind && kind === 'general_reply') kind = 'lead_reply';
  }
  return {
    settings, kind, clientId, leadId, insight, recent, appointmentText, appointmentDate, appointmentTime,
    service, staffName, firstName, lastVisitText, taskType,
  };
}

/** Builds an AI (or template) draft for staff to review. Never sends. */
export async function draftMessage(input: DraftInput) {
  const { settings, kind, insight, recent, appointmentText, appointmentDate, appointmentTime, service, staffName, firstName, lastVisitText } = await messageContext(input);
  // Reminders and review requests use the owner's own wording from Settings, so they read the same every time.
  const vars = {
    firstName: firstName || 'there', salon: settings.business.name, reviewUrl: settings.business.reviewUrl,
    service: service ?? 'your', stylist: staffName ?? '', date: appointmentDate, time: appointmentTime,
  };
  if (kind === 'appointment_reminder' && settings.reminders.template && appointmentDate) {
    return { draft: renderTemplate(settings.reminders.template, vars), kind, provider: 'template' as const };
  }
  if (kind === 'review_request' && settings.reviews.message) {
    return { draft: renderTemplate(settings.reviews.message, vars), kind, provider: 'template' as const };
  }
  const text = await aiService().draft({
    kind, firstName, salonName: settings.business.name, tone: settings.ai.tone, signature: settings.messaging.signature,
    bookingUrl: settings.business.bookingUrl, reviewUrl: settings.business.reviewUrl,
    service, staffName, appointmentText, lastVisitText, insight, recentMessages: recent,
  });
  return { draft: text, kind, provider: aiService().provider };
}

// ---------------- Saved replies ----------------

const TASK_SITUATION: Record<string, ReplySituation> = {
  new_lead: 'new_lead', follow_up: 'no_reply', rebook: 'rebooking', cancellation: 'cancellation', no_show: 'no_show',
  review_request: 'review', appointment_reminder: 'reminder', consultation: 'consultation',
};
const INTENT_SITUATION: Record<string, ReplySituation> = {
  pricing_question: 'pricing', reschedule: 'reschedule', cancel: 'cancellation', thanks: 'thanks', confirm: 'confirmed',
};

/** Works out what kind of reply is needed: the follow-up's type first, then what their last text was about. */
export function detectSituation(ctx: { taskType: string | null; insight: MessageInsight | null; clientId?: string | null; leadId?: string | null }): ReplySituation {
  if (ctx.taskType && TASK_SITUATION[ctx.taskType]) return TASK_SITUATION[ctx.taskType];
  const intent = ctx.insight?.intent;
  if (intent && INTENT_SITUATION[intent]) return INTENT_SITUATION[intent];
  if (intent === 'booking_request') return ctx.clientId ? 'booking' : 'new_lead';
  if (!ctx.clientId && ctx.leadId) return 'new_lead';
  return 'general';
}

/** The salon's saved replies, filled in for this person, with the ones that fit the situation first. */
export async function suggestReplies(input: DraftInput) {
  const ctx = await messageContext(input);
  const s = ctx.settings;
  const situation = detectSituation(ctx);
  const vars = {
    firstName: ctx.firstName || 'there', salon: s.business.name, stylist: ctx.staffName ?? '', service: ctx.service ?? '',
    date: ctx.appointmentDate ?? '', time: ctx.appointmentTime ?? '', bookingUrl: s.business.bookingUrl, reviewUrl: s.business.reviewUrl,
    signature: s.messaging.signature,
  };
  const replies: SuggestedReply[] = s.replies.items.map((r) => ({ ...r, text: renderTemplate(r.body, vars), matches: r.situations.includes(situation) }));
  replies.sort((a, b) => Number(b.matches) - Number(a.matches));
  return { situation, replies };
}
