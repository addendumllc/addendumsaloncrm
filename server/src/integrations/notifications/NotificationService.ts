import { db } from '../../db/index.js';
import { getSettings } from '../../repos/settings.js';
import { emailService } from '../registry.js';

/**
 * In-app notifications (bell + optional browser notifications in the web app).
 * Email/SMS staff alerts are architected here: plug a mail provider into `deliverExternal`.
 */
export class NotificationService {
  /** `external: false` keeps it in the CRM only (e.g. a task sent to one person — not the salon's alert email). */
  async notify(n: { staffId?: string | null; kind: string; title: string; body?: string; link?: string; external?: boolean }) {
    await db().query('INSERT INTO notifications(staff_id, kind, title, body, link) VALUES ($1,$2,$3,$4,$5)', [
      n.staffId ?? null, n.kind, n.title, n.body ?? null, n.link ?? null,
    ]);
    if (n.external !== false) await this.deliverExternal(n);
  }

  private async deliverExternal(n: { title: string; body?: string; link?: string }) {
    const s = await getSettings();
    const email = emailService();
    if (!s.notifications.email || !s.notifications.notifyEmail || !email) return;
    // Best effort: an alert email failing must never break the action that triggered it.
    await email.send({ to: s.notifications.notifyEmail, subject: `${s.business.name}: ${n.title}`, text: [n.body, n.link].filter(Boolean).join('\n\n') || n.title })
      .catch((e) => console.warn('[notifications] email alert failed:', (e as Error).message));
  }
}

export const notifications = new NotificationService();
