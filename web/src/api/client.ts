/** Thin fetch wrapper. All requests go to our own server; no third-party secrets ever live in the browser. */
export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string, public details?: unknown) {
    super(message);
  }
}

type Json = object | undefined;

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
};

export const qs = (params: Record<string, string | number | boolean | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};
