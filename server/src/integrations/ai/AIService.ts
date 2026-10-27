import type { DraftKind, MessageInsight } from '@addendum/shared';

export interface DraftContext {
  kind: DraftKind;
  firstName: string;
  salonName: string;
  tone: string;
  signature: string;
  bookingUrl: string;
  reviewUrl: string;
  service?: string | null;
  staffName?: string | null;
  appointmentText?: string | null; // e.g. "Thursday, October 9 at 2:00 PM"
  lastVisitText?: string | null;
  insight?: MessageInsight | null;
  recentMessages?: { direction: 'inbound' | 'outbound'; body: string }[];
}

/**
 * AI boundary. Drafts are ALWAYS returned to staff for review; this service never sends anything.
 */
export interface AIService {
  readonly provider: 'anthropic' | 'gemini' | 'built_in';
  analyze(text: string): Promise<MessageInsight>;
  draft(ctx: DraftContext): Promise<string>;
  /** Free-form writing (e.g. content drafts); only with a real model — the built-in service has none. */
  write?(system: string, user: string, maxTokens?: number): Promise<string>;
}
