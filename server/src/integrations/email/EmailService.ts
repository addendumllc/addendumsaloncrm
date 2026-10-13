import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../../config.js';
import { IntegrationError } from '../../lib/errors.js';

export interface EmailMessage {
  to: string;
  cc?: string[];
  replyTo?: string | null;
  subject: string;
  text: string;
  html?: string;
}

/** Outgoing email (inventory order requests, staff alerts). Swap providers by implementing this. */
export interface EmailService {
  readonly provider: 'smtp' | 'demo';
  readonly from: string;
  send(msg: EmailMessage): Promise<{ messageId: string }>;
}

/**
 * Any SMTP provider: Google Workspace, Microsoft 365, Postmark, SendGrid, Mailgun, Amazon SES…
 * Credentials live only in server environment variables.
 */
export class SmtpEmailService implements EmailService {
  readonly provider = 'smtp' as const;
  private transport: Transporter;
  readonly from: string;
  constructor() {
    const c = config();
    this.from = c.EMAIL_FROM ?? c.SMTP_USER ?? 'no-reply@addendumsalon.com';
    this.transport = nodemailer.createTransport({
      host: c.SMTP_HOST,
      port: c.SMTP_PORT,
      secure: c.SMTP_SECURE,
      auth: c.SMTP_USER ? { user: c.SMTP_USER, pass: c.SMTP_PASS } : undefined,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
    });
  }
  async send(msg: EmailMessage) {
    try {
      const info = await this.transport.sendMail({
        from: this.from, to: msg.to, cc: msg.cc?.length ? msg.cc : undefined, replyTo: msg.replyTo ?? undefined,
        subject: msg.subject, text: msg.text, html: msg.html,
      });
      return { messageId: String(info.messageId ?? '') };
    } catch (e: any) {
      const auth = e?.code === 'EAUTH' || e?.responseCode === 535;
      throw new IntegrationError(
        'email',
        auth ? 'Email login was rejected. Check the SMTP username and password.' : 'The email could not be sent right now. It will be retried.',
        !auth, auth, `${e?.code ?? ''} ${e?.response ?? e?.message ?? e}`,
      );
    }
  }
}

/** DEMO MODE: nothing leaves the app. The rendered email is saved on the request so you can preview it. */
export class MockEmailService implements EmailService {
  readonly provider = 'demo' as const;
  readonly from = 'Addendum Salon (demo) <no-reply@addendumsalon.demo>';
  static outbox: EmailMessage[] = [];
  async send(msg: EmailMessage) {
    MockEmailService.outbox.push(msg);
    return { messageId: `demo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` };
  }
}
