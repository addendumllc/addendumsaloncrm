import { IntegrationError } from '../lib/errors.js';

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

  async publish(containerId: string) {
    const { id } = await this.call<{ id: string }>('POST', `/${this.accountId}/media_publish`, { creation_id: containerId });
    const info = await this.call<{ permalink?: string }>('GET', `/${id}`, { fields: 'permalink' }).catch(() => ({ permalink: undefined }));
    return { mediaId: id, permalink: info.permalink ?? null };
  }
}
