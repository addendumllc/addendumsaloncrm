import type { MessageInsight } from '@addendum/shared';
import { config } from '../../config.js';
import type { AIService, DraftContext } from './AIService.js';
import { RuleBasedAIService, ruleBasedInsight } from './RuleBasedAIService.js';

/**
 * Claude via the Anthropic Messages API (server-side only; the key never reaches the browser).
 * Falls back to the built-in templates if the API is unavailable, so drafting never blocks staff.
 */
export class AnthropicAIService implements AIService {
  readonly provider = 'anthropic' as const;
  private fallback = new RuleBasedAIService();

  private async complete(system: string, user: string, maxTokens = 400): Promise<string> {
    const c = config();
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': c.ANTHROPIC_API_KEY!,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: c.AI_MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`Anthropic API ${res.status}`);
    const json: any = await res.json();
    return (json.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('').trim();
  }

  async analyze(text: string): Promise<MessageInsight> {
    try {
      const out = await this.complete(
        'You classify inbound text messages to a hair salon. Reply with ONLY a JSON object: {"intent": one of booking_request|pricing_question|confirm|cancel|reschedule|thanks|opt_out|general, "isPotentialLead": boolean, "service": string|null (e.g. "Hair Color","Extensions","Haircut","Balayage / Blonding","Treatment","Blowout"), "timeframe": string|null (e.g. "Next week"), "summary": short string}.',
        text,
        200,
      );
      const parsed = JSON.parse(out.replace(/^```(json)?|```$/g, '').trim());
      return {
        intent: String(parsed.intent ?? 'general'),
        isPotentialLead: !!parsed.isPotentialLead,
        service: parsed.service ?? null,
        timeframe: parsed.timeframe ?? null,
        summary: String(parsed.summary ?? ''),
      };
    } catch {
      return ruleBasedInsight(text);
    }
  }

  async draft(ctx: DraftContext): Promise<string> {
    try {
      const convo = (ctx.recentMessages ?? []).slice(-8).map((m) => `${m.direction === 'inbound' ? 'Client' : 'Salon'}: ${m.body}`).join('\n');
      const facts = [
        `Draft type: ${ctx.kind}`,
        `Client first name: ${ctx.firstName || 'unknown'}`,
        ctx.service && `Service: ${ctx.service}`,
        ctx.staffName && `Stylist: ${ctx.staffName}`,
        ctx.appointmentText && `Appointment: ${ctx.appointmentText}`,
        ctx.lastVisitText && `Last visit: ${ctx.lastVisitText}`,
        ctx.bookingUrl && `Booking link (include only if inviting them to book): ${ctx.bookingUrl}`,
        ctx.reviewUrl && ctx.kind === 'review_request' && `Review link: ${ctx.reviewUrl}`,
        ctx.signature && `End with signature: ${ctx.signature}`,
      ].filter(Boolean).join('\n');
      const text = await this.complete(
        `You write SMS replies for ${ctx.salonName}, a premium hair salon. Tone: ${ctx.tone}. Keep it under 320 characters, warm and specific, no hashtags, at most one emoji. Never invent prices, availability, or facts not given. Output only the message text.`,
        `${facts}\n\nRecent conversation:\n${convo || '(none)'}`,
      );
      return text || this.fallback.draft(ctx);
    } catch {
      return this.fallback.draft(ctx);
    }
  }
}
