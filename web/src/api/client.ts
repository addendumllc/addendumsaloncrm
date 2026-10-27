/** Thin fetch wrapper. All requests go to our own server; no third-party secrets ever live in the browser. */
export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string, public details?: unknown) {
    super(message);
  }
}

type Json = object | undefined;

/** Touch-first devices (iPads report a desktop browser) follow the phone rules in Location & Access. */
const touchFirst = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches && !window.matchMedia?.('(any-pointer: fine)').matches;

async function request<T>(method: string, url: string, body?: Json): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${url}`, {
      method,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        // Required by the server for any change (CSRF protection).
        'X-Requested-With': 'addendum-crm',
        ...(touchFirst ? { 'X-Addendum-Device': 'touch' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, "Can't reach the salon server. Check your internet connection.");
  }
  if (res.status === 401 && !url.startsWith('/auth/')) {
    window.dispatchEvent(new CustomEvent('addendum:signed-out'));
  }
  // Refused: the user's role may have just changed, so the app re-checks who they are.
  if (res.status === 403) window.dispatchEvent(new CustomEvent('addendum:forbidden'));
  const data = await res.json().catch(() => ({}));
  // This computer isn't on the salon network (Location & Access): the app shows how to get access.
  if (res.status === 403 && data?.error?.code === 'network_restricted') window.dispatchEvent(new CustomEvent('addendum:network'));
  if (!res.ok) {
    throw new ApiError(res.status, data?.error?.message ?? 'Something went wrong. Please try again.', data?.error?.code, data?.error?.details);
  }
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body: Json = {}) => request<T>('POST', url, body),
  patch: <T>(url: string, body: Json = {}) => request<T>('PATCH', url, body),
  put: <T>(url: string, body: Json = {}) => request<T>('PUT', url, body),
  del: <T>(url: string) => request<T>('DELETE', url),
  /** Uploads one file as the request body (e.g. Content calendar photos and videos). */
  upload: async <T>(url: string, file: File): Promise<T> => {
    const res = await fetch(`/api${url}`, {
      method: 'POST', credentials: 'same-origin', body: file,
      headers: { Accept: 'application/json', 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name), 'X-Requested-With': 'addendum-crm', ...(touchFirst ? { 'X-Addendum-Device': 'touch' } : {}) },
    }).catch(() => { throw new ApiError(0, "Can't reach the salon server. Check your internet connection."); });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data?.error?.message ?? (res.status === 413 ? 'That file is too big.' : 'The upload didn’t go through.'), data?.error?.code);
    return data as T;
  },
};

export const qs = (params: Record<string, string | number | boolean | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};
