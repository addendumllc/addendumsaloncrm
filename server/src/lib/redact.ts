/**
 * Keeps secrets out of the server log. Every secret the server knows (saved integration credentials, keys and
 * passwords from the environment) is replaced with [redacted] in anything written to the console — including errors
 * from other services that echo a token back. Bearer tokens and URL passwords are masked whatever their value.
 */
let secrets: string[] = [];

export function setRedactedSecrets(values: string[]) {
  // Longest first, so a secret containing another is masked whole. Very short values would mask ordinary words.
  secrets = [...new Set(values.map((v) => v.trim()).filter((v) => v.length >= 6))].sort((a, b) => b.length - a.length);
}

export function redact(text: string): string {
  let out = text;
  for (const s of secrets) if (out.includes(s)) out = out.split(s).join('[redacted]');
  return out
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[redacted]')
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^:/\s@]+:)[^@\s/]+@/gi, '$1[redacted]@')
    .replace(/("?(?:access_token|refresh_token|client_secret|password|api[_-]?key|x-shopify-access-token)"?\s*[:=]\s*"?)[^"\s,}&]+/gi, '$1[redacted]');
}

const scrub = (v: unknown): unknown => {
  if (typeof v === 'string') return redact(v);
  if (v instanceof Error) {
    const e = new Error(redact(v.message));
    e.name = v.name;
    e.stack = v.stack ? redact(v.stack) : undefined;
    return e;
  }
  if (v && typeof v === 'object') {
    try {
      const json = JSON.stringify(v);
      const clean = redact(json);
      return clean === json ? v : clean;
    } catch {
      return v;
    }
  }
  return v;
};

let installed = false;
/** Wraps console.log/info/warn/error once, at start-up. */
export function installLogRedaction() {
  if (installed) return;
  installed = true;
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const original = console[m].bind(console);
    console[m] = (...args: unknown[]) => original(...args.map(scrub));
  }
}
