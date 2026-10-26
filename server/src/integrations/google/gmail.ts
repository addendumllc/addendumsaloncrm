import { config } from '../../config.js';
import { randomToken } from '../../lib/crypto.js';
import { IntegrationError } from '../../lib/errors.js';
import { getCredentials, getIntegration, upsertIntegration } from '../../repos/integrations.js';
import { getKV, setKV } from '../../repos/settings.js';

/**
 * Gmail (Website Inquiries): the salon's inbox, connected with Google's OAuth 2.0 sign-in. Only the refresh token is
 * kept, encrypted on the server. The CRM reads only messages from verified Showit senders, and adds its label to them;
 * it never sends, deletes, archives or marks anything read, so Showit's emails stay in the inbox as before.
 */
export const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.modify', 'openid', 'email'];
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

export interface GmailMessage { id: string; threadId: string; from: string; subject: string; date: string; snippet: string; text: string; labelIds: string[] }
/** What the CRM uses from Gmail (a simulated one in tests and Demo Mode). */
export interface GmailClient {
  email(): Promise<string>;
  ensureLabel(name: string): Promise<string>;
  search(q: string, max: number): Promise<string[]>;
  get(id: string): Promise<GmailMessage>;
  addLabel(id: string, labelId: string): Promise<void>;
}

export const gmailRedirectUri = () => `${config().APP_URL.replace(/\/$/, '')}/api/integrations/gmail/callback`;

export async function gmailAuthorizeUrl(account: string) {
  const c = config();
  if (!c.GOOGLE_CLIENT_ID || !c.GOOGLE_CLIENT_SECRET) throw new IntegrationError('gmail', 'Add the Google OAuth client under Settings → API & Integrations first.', false);
  const state = randomToken(24);
  await setKV('gmail.oauthState', { state, createdAt: Date.now() });
  return `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
    client_id: c.GOOGLE_CLIENT_ID, redirect_uri: gmailRedirectUri(), response_type: 'code', scope: GMAIL_SCOPES.join(' '),
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', login_hint: account, state,
  })}`;
}

async function token(body: Record<string, string>) {
  const c = config();
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.GOOGLE_CLIENT_ID ?? '', client_secret: c.GOOGLE_CLIENT_SECRET ?? '', ...body }),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new IntegrationError('gmail', 'Google didn’t accept the connection. Connect the mailbox again.', false, true, JSON.stringify(j));
  return j as { access_token: string; refresh_token?: string; expires_in: number; scope?: string };
}

/** Google's redirect back: checks the state, keeps the refresh token, and only accepts the designated mailbox. */
export async function gmailCallback(code: string, state: string, account: string) {
  const saved = await getKV<{ state: string; createdAt: number }>('gmail.oauthState');
  if (!saved || saved.state !== state || Date.now() - saved.createdAt > 15 * 60_000) throw new IntegrationError('gmail', 'The connection link expired. Try connecting again.', false);
  await setKV('gmail.oauthState', null);
  const t = await token({ grant_type: 'authorization_code', code, redirect_uri: gmailRedirectUri() });
  if (!t.refresh_token) throw new IntegrationError('gmail', 'Google didn’t give a lasting connection. Remove the CRM’s access in the Google account’s security settings, then connect again.', false);
  const live = new GmailApi(t.refresh_token, { token: t.access_token, until: Date.now() + (t.expires_in - 60) * 1000 });
  const email = (await live.email()).toLowerCase();
  if (email !== account.toLowerCase()) {
    await revoke(t.refresh_token);
    throw new IntegrationError('gmail', `That was ${email}. Connect ${account} — the mailbox chosen for website inquiries.`, false);
  }
  await upsertIntegration('gmail', { status: 'connected', credentials: { refresh_token: t.refresh_token }, meta: { email, scopes: t.scope ?? GMAIL_SCOPES.join(' '), connectedAt: new Date().toISOString() } });
  return email;
}

async function revoke(refreshToken: string) {
  await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refreshToken)}`, { method: 'POST' }).catch(() => undefined);
}

export async function disconnectGmail() {
  const creds = await getCredentials<{ refresh_token: string }>('gmail');
  if (creds?.refresh_token) await revoke(creds.refresh_token);
  await upsertIntegration('gmail', { status: 'disconnected', credentials: null, meta: { disconnectedAt: new Date().toISOString() } });
}

const b64 = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
const strip = (html: string) => html.replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"').replace(/[ \t]+/g, ' ').replace(/\n\s+/g, '\n');

/** The real Gmail API, with the access token refreshed from the stored refresh token as needed. */
export class GmailApi implements GmailClient {
  constructor(private refresh: string, private cached: { token: string; until: number } | null = null) {}
  private async auth() {
    if (!this.cached || this.cached.until < Date.now()) {
      const t = await token({ grant_type: 'refresh_token', refresh_token: this.refresh });
      this.cached = { token: t.access_token, until: Date.now() + (t.expires_in - 60) * 1000 };
    }
    return this.cached.token;
  }
  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${API}${path}`, { ...init, headers: { Authorization: `Bearer ${await this.auth()}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new IntegrationError('gmail', res.status === 401 || res.status === 403 ? 'Gmail access was removed or expired. Connect the mailbox again.' : 'Gmail didn’t answer. It will try again shortly.', res.status >= 500, res.status === 401 || res.status === 403, JSON.stringify(j.error ?? j));
    return j as T;
  }
  async email() { return (await this.call<{ emailAddress: string }>('/profile')).emailAddress; }
  async ensureLabel(name: string) {
    const list = await this.call<{ labels: { id: string; name: string }[] }>('/labels');
    const found = list.labels?.find((l) => l.name.toLowerCase() === name.toLowerCase());
    if (found) return found.id;
    return (await this.call<{ id: string }>('/labels', { method: 'POST', body: JSON.stringify({ name, labelListVisibility: 'labelShow', messageListVisibility: 'show' }) })).id;
  }
  async search(q: string, max: number) {
    return ((await this.call<{ messages?: { id: string }[] }>(`/messages?${new URLSearchParams({ q, maxResults: String(max) })}`)).messages ?? []).map((m) => m.id);
  }
  async get(id: string): Promise<GmailMessage> {
    const m = await this.call<any>(`/messages/${encodeURIComponent(id)}?format=full`);
    const header = (n: string) => m.payload?.headers?.find((h: any) => h.name.toLowerCase() === n)?.value ?? '';
    let plain = ''; let html = '';
    const walk = (p: any) => {
      if (!p) return;
      if (p.mimeType === 'text/plain' && p.body?.data && !plain) plain = b64(p.body.data);
      if (p.mimeType === 'text/html' && p.body?.data && !html) html = b64(p.body.data);
      for (const c of p.parts ?? []) walk(c);
    };
    walk(m.payload);
    return { id: m.id, threadId: m.threadId, from: header('from'), subject: header('subject'), date: new Date(Number(m.internalDate) || header('date')).toISOString(), snippet: m.snippet ?? '', text: plain || strip(html), labelIds: m.labelIds ?? [] };
  }
  async addLabel(id: string, labelId: string) {
    await this.call(`/messages/${encodeURIComponent(id)}/modify`, { method: 'POST', body: JSON.stringify({ addLabelIds: [labelId] }) });
  }
}

let override: GmailClient | null | undefined;
/** Tests: a simulated mailbox (null = not connected). */
export const setGmailOverride = (c: GmailClient | null | undefined) => { override = c; };

/** The connected mailbox, or null when it isn't connected. */
export async function gmailClient(): Promise<GmailClient | null> {
  if (override !== undefined) return override;
  const row = await getIntegration('gmail');
  if (row?.status !== 'connected') return null;
  const creds = await getCredentials<{ refresh_token: string }>('gmail');
  return creds?.refresh_token ? new GmailApi(creds.refresh_token) : null;
}
