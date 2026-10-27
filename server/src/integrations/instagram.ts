import { config } from '../config.js';
import { randomToken } from '../lib/crypto.js';
import { IntegrationError } from '../lib/errors.js';
import { getKV, setKV } from '../repos/settings.js';

/**
 * Instagram Graph API (content publishing) for one Instagram Business/Creator account:
 *  POST /{ig-user}/media          (a container: an image, a video/Reel, a Story, a carousel item or the carousel)
 *  GET  /{container}?fields=status_code   (videos are processed before they can be published)
 *  POST /{ig-user}/media_publish  (publishes a finished container)
 * Media is given as public URLs that Instagram downloads (the CRM's signed media links).
 */
const GRAPH = 'https://graph.facebook.com/v21.0';

export type IgSlot = 'a1' | 'a2' | 'a3';
export function instagramAccounts(cfg: object) {
  const c = cfg as Record<string, string | undefined>;
  return ([1, 2, 3] as const).map((n) => ({ slot: `a${n}` as IgSlot, accountId: c[`INSTAGRAM_${n}_ACCOUNT_ID`]?.trim(), token: c[`INSTAGRAM_${n}_TOKEN`]?.trim() }))
    .filter((a): a is { slot: IgSlot; accountId: string; token: string } => !!a.accountId && !!a.token);
}

export class InstagramApi {
  constructor(private accountId: string, private token: string) {}

  private async call<T>(method: 'GET' | 'POST', path: string, params: Record<string, string | boolean | string[]> = {}): Promise<T> {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...params, access_token: this.token })) body.set(k, Array.isArray(v) ? v.join(',') : String(v));
    const res = await fetch(method === 'GET' ? `${GRAPH}${path}?${body}` : `${GRAPH}${path}`, method === 'GET' ? {} : { method, body });
    const json = await res.json().catch(() => ({})) as any;
    if (!res.ok || json.error) {
      const e = json.error ?? {};
      const auth = res.status === 401 || e.code === 190 || e.type === 'OAuthException';
      throw new IntegrationError('instagram', `Instagram: ${e.error_user_msg || e.message || `error ${res.status}`}`, !auth && res.status >= 500, auth, JSON.stringify(e).slice(0, 500));
    }
    return json as T;
  }

  async username() {
    return (await this.call<{ username?: string }>('GET', `/${this.accountId}`, { fields: 'username' })).username ?? this.accountId;
  }

  /** A container for one piece of media; `as` says what it's for. */
  async container(m: { url: string; video: boolean }, as: { kind: 'feed' | 'reel' | 'story' | 'carousel_item'; caption?: string }) {
    const p: Record<string, string | boolean> = {};
    if (as.kind === 'reel') Object.assign(p, { media_type: 'REELS', video_url: m.url });
    else if (as.kind === 'story') Object.assign(p, { media_type: 'STORIES', [m.video ? 'video_url' : 'image_url']: m.url });
    else if (m.video) Object.assign(p, { media_type: 'VIDEO', video_url: m.url });
    else p.image_url = m.url;
    if (as.kind === 'carousel_item') p.is_carousel_item = true;
    if (as.caption && as.kind !== 'story' && as.kind !== 'carousel_item') p.caption = as.caption;
    return (await this.call<{ id: string }>('POST', `/${this.accountId}/media`, p)).id;
  }

  async carousel(children: string[], caption: string) {
    return (await this.call<{ id: string }>('POST', `/${this.accountId}/media`, { media_type: 'CAROUSEL', children, caption })).id;
  }

  /** FINISHED, IN_PROGRESS, ERROR, EXPIRED or PUBLISHED. */
  async status(containerId: string) {
    return (await this.call<{ status_code?: string }>('GET', `/${containerId}`, { fields: 'status_code' })).status_code ?? 'FINISHED';
  }

  /** A published post's numbers (whatever Instagram offers for its type; older metrics are skipped if refused). */
  async insights(mediaId: string): Promise<Record<string, number>> {
    const NAMES: Record<string, string> = { reach: 'reach', views: 'views', likes: 'likes', comments: 'comments', saved: 'saves', shares: 'shares', total_interactions: '' };
    for (const metric of ['reach,views,likes,comments,saved,shares', 'reach,likes,comments,saved,shares', 'reach,likes,comments']) {
      try {
        const r = await this.call<{ data?: { name: string; values?: { value: number }[]; total_value?: { value: number } }[] }>('GET', `/${mediaId}/insights`, { metric });
        const out: Record<string, number> = {};
        for (const d of r.data ?? []) { const key = NAMES[d.name]; const v = d.total_value?.value ?? d.values?.[0]?.value; if (key && typeof v === 'number') out[key] = v; }
        return out;
      } catch (e) { if ((e as IntegrationError).authProblem) throw e; }
    }
    return {};
  }

  async publish(containerId: string) {
    const { id } = await this.call<{ id: string }>('POST', `/${this.accountId}/media_publish`, { creation_id: containerId });
    const info = await this.call<{ permalink?: string }>('GET', `/${id}`, { fields: 'permalink' }).catch(() => ({ permalink: undefined }));
    return { mediaId: id, permalink: info.permalink ?? null };
  }
}

// ---------------- Connect Instagram (Facebook login) ----------------
/**
 * One sign-in with Facebook finds the Instagram Business accounts behind the person's Pages. Their Page tokens (made
 * from a long-lived user token, so they don't expire) are what posting uses. Needs the Meta app ID and secret once.
 */
const SCOPES = ['instagram_basic', 'instagram_content_publish', 'instagram_manage_insights', 'pages_show_list', 'pages_read_engagement', 'business_management'];
export const metaRedirectUri = () => `${config().APP_URL.replace(/\/$/, '')}/api/integrations/instagram/callback`;
export async function metaAuthorizeUrl() {
  const c = config();
  if (!c.META_APP_ID || !c.META_APP_SECRET) throw new IntegrationError('instagram', 'Add your Meta app ID and secret first (Settings → API & Integrations → Instagram).', false);
  const state = randomToken(24);
  await setKV('instagram.oauthState', { state, createdAt: Date.now() });
  return `https://www.facebook.com/v21.0/dialog/oauth?${new URLSearchParams({ client_id: c.META_APP_ID, redirect_uri: metaRedirectUri(), state, scope: SCOPES.join(','), response_type: 'code' })}`;
}
async function graphGet<T>(path: string, params: Record<string, string>) {
  const res = await fetch(`${GRAPH}${path}?${new URLSearchParams(params)}`);
  const j = await res.json().catch(() => ({})) as any;
  if (!res.ok || j.error) throw new IntegrationError('instagram', `Facebook: ${j.error?.message ?? `error ${res.status}`}`, false, true, JSON.stringify(j.error ?? {}).slice(0, 500));
  return j as T;
}
/** The Instagram accounts the sign-in can post to: { username, accountId, token }. */
export async function metaCallback(code: string, state: string) {
  const c = config();
  const saved = await getKV<{ state: string; createdAt: number }>('instagram.oauthState');
  if (!saved || saved.state !== state || Date.now() - saved.createdAt > 15 * 60_000) throw new IntegrationError('instagram', 'The connection link expired. Try Connect Instagram again.', false);
  const short = await graphGet<{ access_token: string }>('/oauth/access_token', { client_id: c.META_APP_ID!, client_secret: c.META_APP_SECRET!, redirect_uri: metaRedirectUri(), code });
  const long = await graphGet<{ access_token: string }>('/oauth/access_token', { grant_type: 'fb_exchange_token', client_id: c.META_APP_ID!, client_secret: c.META_APP_SECRET!, fb_exchange_token: short.access_token });
  const pages = await graphGet<{ data?: { name: string; access_token: string; instagram_business_account?: { id: string; username?: string } }[] }>('/me/accounts', { fields: 'name,access_token,instagram_business_account{id,username}', limit: '100', access_token: long.access_token });
  return (pages.data ?? []).filter((p) => p.instagram_business_account).map((p) => ({ username: p.instagram_business_account!.username ?? p.name, accountId: p.instagram_business_account!.id, token: p.access_token, page: p.name }));
}
