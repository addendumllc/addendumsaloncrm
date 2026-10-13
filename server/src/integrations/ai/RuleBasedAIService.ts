import type { MessageInsight } from '@addendum/shared';
import type { AIService, DraftContext } from './AIService.js';

const SERVICE_PATTERNS: [RegExp, string][] = [
  [/\b(extension|extensions|k-?tips?|tape[- ]?ins?|wefts?|sew[- ]?in|move[- ]?up)\b/i, 'Extensions'],
  [/\b(balayage|highlights?|blonde|bleach|lightening)\b/i, 'Balayage / Blonding'],
  [/\b(colou?r(ed|ing)?|gloss|roots?|brunette|grey|gray|toner?)\b/i, 'Hair Color'],
  [/\b(botox|polish|milbon|treatment|keratin)\b/i, 'Treatment'],
  [/\b(blow ?out|blowdry|blow-dry|style|styling)\b/i, 'Blowout'],
  [/\b(cut|trim|haircut|bangs|layers)\b/i, 'Haircut'],
  [/\b(consult|consultation)\b/i, 'Consultation'],
];

const TIMEFRAME_PATTERNS: [RegExp, string][] = [
  [/\btoday\b/i, 'Today'],
  [/\btomorrow\b/i, 'Tomorrow'],
  [/\bthis week(end)?\b/i, 'This week'],
  [/\bnext week(end)?\b/i, 'Next week'],
  [/\bnext month\b/i, 'Next month'],
  [/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i, ''],
  [/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i, ''],
  [/\b(asap|soon|as soon as)\b/i, 'As soon as possible'],
];

export function ruleBasedInsight(text: string): MessageInsight {
  const t = text.trim();
  let service: string | null = null;
  for (const [re, name] of SERVICE_PATTERNS) if (re.test(t)) { service = name; break; }
  let timeframe: string | null = null;
  for (const [re, label] of TIMEFRAME_PATTERNS) {
    const m = t.match(re);
    if (m) { timeframe = label || m[0][0].toUpperCase() + m[0].slice(1).toLowerCase(); break; }
  }
  let intent = 'general';
  if (/^\s*(stop|unsubscribe|cancel all|end|quit)\s*$/i.test(t)) intent = 'opt_out';
  else if (/^\s*(c|confirm|confirmed|yes|yep|see you|i'?ll be there)\b/i.test(t)) intent = 'confirm';
  else if (/\b(cancel|can'?t make|cannot make)\b/i.test(t)) intent = 'cancel';
  else if (/\b(reschedule|move my|different time|change my appointment)\b/i.test(t)) intent = 'reschedule';
  else if (/\b(how much|price|pricing|cost|quote)\b/i.test(t)) intent = 'pricing_question';
  else if (/\b(book|appointment|availability|available|looking to get|want to get|interested|openings?|schedule)\b/i.test(t) || service) intent = 'booking_request';
  else if (/\b(thank|thanks|love it|obsessed)\b/i.test(t)) intent = 'thanks';
  const isPotentialLead = intent === 'booking_request' || intent === 'pricing_question';
  const parts = [isPotentialLead ? 'Potential lead' : intent.replace('_', ' ')];
  if (service) parts.push(`Service: ${service}`);
  if (timeframe) parts.push(`Timeframe: ${timeframe}`);
  return { intent, isPotentialLead, service, timeframe, summary: parts.join(' · ') };
}

/** Built-in drafting with salon-voice templates. Used in Demo Mode or when no AI key is configured. */
export class RuleBasedAIService implements AIService {
  readonly provider = 'built_in' as const;

  async analyze(text: string) {
    return ruleBasedInsight(text);
  }

  async draft(c: DraftContext): Promise<string> {
    const hi = `Hi ${c.firstName || 'there'}!`;
    const svc = c.service ?? c.insight?.service ?? null;
    const when = c.insight?.timeframe ? ` ${c.insight.timeframe.toLowerCase()}` : '';
    const book = c.bookingUrl ? ` You can grab a time here: ${c.bookingUrl}` : '';
    let body: string;
    switch (c.kind) {
      case 'lead_reply':
        body = svc
          ? `${hi} Thank you for reaching out to ${c.salonName}. We'd love to help with your ${svc.toLowerCase()}${when}. Is this your first visit with us? If you share a photo of your hair now and your inspiration, we'll match you with the right stylist and timing.${book}`
          : `${hi} Thank you for reaching out to ${c.salonName}. What service are you interested in, and what days work best for you? We'll find the perfect stylist and time.${book}`;
        break;
      case 'appointment_follow_up':
        body = `${hi} Thank you for coming in${c.staffName ? ` to see ${c.staffName}` : ''}. How are you loving your hair? If anything feels off, just reply here and we'll take care of you.`;
        break;
      case 'rebooking':
        body = `${hi} It's been a little while since your last visit${c.lastVisitText ? ` (${c.lastVisitText})` : ''} — you're right on time for your next ${svc ? svc.toLowerCase() : 'appointment'}. Would you like us to find you a spot${c.staffName ? ` with ${c.staffName}` : ''}?${book}`;
        break;
      case 'no_show':
        body = `${hi} We missed you at your appointment${c.appointmentText ? ` on ${c.appointmentText}` : ''} — we hope everything is okay. Reply here and we'll help you find a new time that works.`;
        break;
      case 'cancellation':
        body = `${hi} We saw your appointment${c.appointmentText ? ` for ${c.appointmentText}` : ''} was cancelled — no worries at all. Would you like to rebook? Reply with a few days that work and we'll find you a time.${book}`;
        break;
      case 'review_request':
        body = `${hi} Thank you for visiting ${c.salonName}! We'd love to hear about your experience${c.reviewUrl ? `: ${c.reviewUrl}` : '.'}`;
        break;
      case 'appointment_reminder':
        body = `${hi} A friendly reminder of your ${svc ? svc.toLowerCase() + ' ' : ''}appointment${c.appointmentText ? ` on ${c.appointmentText}` : ''}${c.staffName ? ` with ${c.staffName}` : ''}. Reply C to confirm, or let us know if you need to reschedule.`;
        break;
      default: {
        const intent = c.insight?.intent;
        if (intent === 'confirm') body = `Perfect, you're all set! See you soon.`;
        else if (intent === 'reschedule' || intent === 'cancel') body = `${hi} No problem — what days and times work better for you? We'll get you moved.`;
        else if (intent === 'pricing_question') body = `${hi} Great question! Pricing depends on your hair length, density and goals, so we recommend a quick consultation. Would you like us to set one up?${book}`;
        else if (intent === 'thanks') body = `We're so happy you love it! Thank you for trusting us. 🤍`;
        else body = `${hi} Thanks for your message — we'll get right back to you.`;
      }
    }
    return c.signature ? `${body} ${c.signature}` : body;
  }
}
