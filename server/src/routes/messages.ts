import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../auth/session.js';
import { db } from '../db/index.js';
import { notFound } from '../lib/errors.js';
import { draftMessage, finishText, suggestReplies, getConversation, listConversations, markConversationRead, startText } from '../domain/messaging.js';
import { runRules } from '../domain/rulesEngine.js';
import { ah, logAction, parse } from './util.js';

export const messagesRouter = Router();

messagesRouter.get('/conversations', requirePermission('messages:read'), ah(async (req, res) => {
  res.json({ conversations: await listConversations({ unread: req.query.filter === 'unread', q: req.query.q as string | undefined }) });
}));

messagesRouter.get('/conversations/:id', requirePermission('messages:read'), ah(async (req, res) => {
  const data = await getConversation(req.params.id);
  // Appointment context for the side panel.
  let upcoming = null;
  if (data.conversation.clientId) {
    upcoming = await db().one(
      `SELECT a.id, a.start_at AS "startAt", s.name AS "staffName",
              (SELECT string_agg(service_name, ', ') FROM appointment_services x WHERE x.appointment_id = a.id) AS services
         FROM appointments a LEFT JOIN staff s ON s.id = a.staff_id
        WHERE a.client_id = $1 AND a.square_status IN ('ACCEPTED','PENDING') AND a.start_at >= now() ORDER BY a.start_at LIMIT 1`,
      [data.conversation.clientId],
    );
  }
  res.json({ ...data, upcomingAppointment: upcoming });
}));

messagesRouter.post('/conversations/:id/read', requirePermission('messages:read'), ah(async (req, res) => {
  await markConversationRead(req.params.id);
  res.json({ ok: true });
}));

messagesRouter.post('/conversations/:id/create-lead', requirePermission('leads:write'), ah(async (req, res) => {
  const { name } = parse(z.object({ name: z.string().trim().min(1).max(120) }), req.body);
  const convo = await db().one<any>('SELECT * FROM conversations WHERE id = $1', [req.params.id]);
  if (!convo) throw notFound('That conversation');
  const insight = convo.insight ?? {};
  const lead = await db().one<{ id: string }>(
    `INSERT INTO leads(name, phone, source, service_interest, status, last_inbound_at) VALUES ($1,$2,'Text message',$3,'new',$4) RETURNING id`,
    [name, convo.phone, insight.service ?? null, convo.last_inbound_at],
  );
  await db().query('UPDATE conversations SET lead_id = $2 WHERE id = $1', [convo.id, lead!.id]);
  await logAction(req, 'lead.create_from_text', 'lead', lead!.id);
  await runRules();
  res.status(201).json({ id: lead!.id });
}));

/** Step 1 of texting from Apple Messages: log the text and return the number to open Messages with. Nothing is sent from here. */
messagesRouter.post('/handoff', requirePermission('messages:send'), ah(async (req, res) => {
  const b = parse(z.object({
    conversationId: z.string().uuid().optional(),
    clientId: z.string().uuid().optional(),
    leadId: z.string().uuid().optional(),
    phone: z.string().max(40).optional(),
    body: z.string().trim().min(1, 'is empty').max(1600),
    aiGenerated: z.boolean().optional(),
    taskId: z.string().uuid().optional(),
  }), req.body);
  const result = await startText({ ...b, staffId: req.user!.id });
  await logAction(req, 'message.handoff', 'conversation', result.conversationId, { aiGenerated: !!b.aiGenerated });
  res.json(result);
}));

/** Step 2: the staff member says whether they sent it from Messages. */
messagesRouter.post('/:id/outcome', requirePermission('messages:send'), ah(async (req, res) => {
  const b = parse(z.object({ outcome: z.enum(['sent', 'not_sent']), completeTaskId: z.string().uuid().optional() }), req.body);
  const message = await finishText(req.params.id, req.user!.id, b.outcome, b.completeTaskId);
  await logAction(req, 'message.outcome', 'message', message.id, { outcome: b.outcome });
  res.json({ message });
}));

/** Generate a draft for staff to review. Drafts are never sent automatically from here. */
messagesRouter.post('/draft', requirePermission('messages:send'), ah(async (req, res) => {
  const b = parse(z.object({
    kind: z.enum(['lead_reply', 'general_reply', 'appointment_follow_up', 'rebooking', 'no_show', 'cancellation', 'review_request', 'appointment_reminder']).optional(),
    conversationId: z.string().uuid().optional(),
    clientId: z.string().uuid().optional(),
    leadId: z.string().uuid().optional(),
    taskId: z.string().uuid().optional(),
  }), req.body);
  res.json(await draftMessage(b));
}));

/** The salon's saved replies, filled in for this person, with the ones that fit the situation first. */
messagesRouter.post('/replies/suggest', requirePermission('messages:send'), ah(async (req, res) => {
  const b = parse(z.object({
    conversationId: z.string().uuid().optional(),
    clientId: z.string().uuid().optional(),
    leadId: z.string().uuid().optional(),
    taskId: z.string().uuid().optional(),
  }), req.body);
  res.json(await suggestReplies(b));
}));
