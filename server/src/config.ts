import { z } from 'zod';

/**
 * All server configuration comes from environment variables (see .env.example).
 * Secrets live ONLY here on the server — nothing in this file is ever sent to the browser.
 */
const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(4000),
  APP_URL: z.string().default('http://localhost:5173'),
  /** Other hostnames that should forward to APP_URL (comma-separated), e.g. www.addendumsalon.info,app.addendumsalon.com */
  REDIRECT_HOSTS: z.string().default(''),
  /** Postgres connection string. Leave empty to use the embedded database in ./data (great for demo/dev). */
  DATABASE_URL: z.string().optional(),
  PGLITE_DIR: z.string().default('./data/pglite'),
  /** 32+ char secret used to encrypt stored OAuth tokens. Required in production. */
  ENCRYPTION_KEY: z.string().optional(),
  /** Only while rotating the key: the old ENCRYPTION_KEY, so saved secrets can be re-encrypted with the new one. */
  ENCRYPTION_KEY_PREVIOUS: z.string().optional(),
  /**
   * Account recovery when nobody can sign in (hosts without a command line): a new password for OWNER_EMAIL, applied
   * once at start-up. Remove it again afterwards.
   */
  OWNER_RECOVERY_PASSWORD: z.string().optional(),
  DEMO_MODE: bool(true),
  /** Comma-separated origins allowed to embed the app in an iframe, e.g. https://addendumsalon.com */
  ALLOWED_EMBED_ORIGINS: z.string().default(''),
  COOKIE_SECURE: bool(false),
  /**
   * How many reverse proxies sit in front of the app (for the client's real IP), or an Express trust-proxy list
   * such as "loopback, 10.0.0.0/8". Default 1 (one host load balancer).
   */
  TRUST_PROXY: z.string().default('1'),
  /** Recovery switch: when true, Location & Access never blocks anyone (e.g. the salon's IP changed and no admin can get in). */
  ACCESS_ALLOW_ANYWHERE: bool(false),
  SESSION_DAYS: z.coerce.number().default(14),

  // Owner account created on first start (only if no staff exist).
  OWNER_EMAIL: z.string().default('owner@addendumsalon.com'),
  OWNER_PASSWORD: z.string().default('addendum-demo'),

  // ---- Square ----
  SQUARE_ENVIRONMENT: z.enum(['production', 'sandbox']).default('production'),
  SQUARE_APPLICATION_ID: z.string().optional(),
  SQUARE_APPLICATION_SECRET: z.string().optional(),
  /** Alternative to OAuth for a single salon: a personal access token from the Square Developer Console. */
  SQUARE_ACCESS_TOKEN: z.string().optional(),
  SQUARE_WEBHOOK_SIGNATURE_KEY: z.string().optional(),
  /** Must exactly match the notification URL registered in Square (used in signature check). */
  SQUARE_WEBHOOK_URL: z.string().optional(),
  SQUARE_API_VERSION: z.string().default('2026-09-16'),
  SQUARE_SYNC_INTERVAL_MINUTES: z.coerce.number().default(15),
  SQUARE_BACKFILL_DAYS: z.coerce.number().default(400),
  SQUARE_LOOKAHEAD_DAYS: z.coerce.number().default(90),

  /** Public base URL for incoming webhooks (Square), e.g. https://addendumsalon.info */
  PUBLIC_WEBHOOK_BASE_URL: z.string().optional(),

  // ---- HighLevel ----
  HIGHLEVEL_PRIVATE_TOKEN: z.string().optional(),
  HIGHLEVEL_LOCATION_ID: z.string().optional(),
  // Addendum Hair's own HighLevel sub-account (optional; otherwise its clients come from the main one, by tag).
  HIGHLEVEL_HAIR_PRIVATE_TOKEN: z.string().optional(),
  HIGHLEVEL_HAIR_LOCATION_ID: z.string().optional(),
  HIGHLEVEL_API_BASE: z.string().default('https://services.leadconnectorhq.com'),
  HIGHLEVEL_API_VERSION: z.string().default('2021-07-28'),

  // ---- Shopify (optional: remove ordered hair from Shopify inventory) ----
  /** The store's myshopify.com domain, e.g. addendumhair.myshopify.com */
  SQUARE_NAME: z.string().optional(),
  SHOPIFY_NAME: z.string().optional(),
  SHOPIFY_STORE_DOMAIN: z.string().optional(),
  /** Either a legacy custom-app Admin API token (shpat_…)… */
  SHOPIFY_ADMIN_TOKEN: z.string().optional(),
  /** …or a Dev Dashboard app's client ID + secret (exchanged for a 24-hour token automatically). */
  SHOPIFY_CLIENT_ID: z.string().optional(),
  SHOPIFY_CLIENT_SECRET: z.string().optional(),
  /** Location to deduct from. Optional when the store has a single active location. */
  SHOPIFY_LOCATION_ID: z.string().optional(),
  SHOPIFY_API_VERSION: z.string().default('2026-07'),
  // ---- A second Shopify store that shares the same stock and SKUs (e.g. a pro store with its own prices) ----
  SHOPIFY2_NAME: z.string().optional(),
  SHOPIFY2_STORE_DOMAIN: z.string().optional(),
  SHOPIFY2_ADMIN_TOKEN: z.string().optional(),
  SHOPIFY2_CLIENT_ID: z.string().optional(),
  SHOPIFY2_CLIENT_SECRET: z.string().optional(),
  SHOPIFY2_LOCATION_ID: z.string().optional(),
  /** Square location whose stock is kept in step with Shopify. Optional when Square has a single location. */
  SQUARE_INVENTORY_LOCATION_ID: z.string().optional(),

  // ---- Email (inventory order requests + staff alerts) ----
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  /** true for port 465 (implicit TLS); false for 587 (STARTTLS). */
  SMTP_SECURE: bool(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  /** Sender shown on emails, e.g. "Addendum Salon <orders@addendumsalon.com>". */
  EMAIL_FROM: z.string().optional(),

  // ---- AI ----
  ANTHROPIC_API_KEY: z.string().optional(),
  // Website inquiries from Gmail (Settings → Website Inquiries): a Google Cloud OAuth client (web application).
  GOOGLE_CLIENT_ID: z.string().optional(),
  // Instagram (Content calendar → auto-posting): each account's Instagram Business account ID and access token.
  META_APP_ID: z.string().optional(), META_APP_SECRET: z.string().optional(),
  FLODESK_API_KEY: z.string().optional(),
  // Google Gemini (AI writing): used when set, ahead of Anthropic.
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default('gemini-2.5-flash'),
  INSTAGRAM_1_ACCOUNT_ID: z.string().optional(), INSTAGRAM_1_TOKEN: z.string().optional(),
  INSTAGRAM_2_ACCOUNT_ID: z.string().optional(), INSTAGRAM_2_TOKEN: z.string().optional(),
  INSTAGRAM_3_ACCOUNT_ID: z.string().optional(), INSTAGRAM_3_TOKEN: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  AI_MODEL: z.string().default('claude-haiku-5-5'),
});

export type Config = z.infer<typeof schema>;

let cached: Config | null = null;
/** The raw environment the config was built from, and credentials saved in Settings → API & Integrations. */
let envRaw: Record<string, string | undefined> = {};
let overlay: Record<string, string> = {};
/** Settings of switched-off integrations: ignored even when they're in the environment. */
let blocked = new Set<string>();

/** Keys that can never be overridden from the admin screen (they protect the store itself or the server). */
const NOT_OVERLAYABLE = new Set(['ENCRYPTION_KEY', 'ENCRYPTION_KEY_PREVIOUS', 'OWNER_RECOVERY_PASSWORD', 'PGLITE_DIR', 'DATABASE_URL', 'NODE_ENV', 'DEMO_MODE', 'OWNER_PASSWORD', 'OWNER_EMAIL', 'APP_URL', 'PORT']);

function build(env: Record<string, string | undefined>) {
  const merged: Record<string, string | undefined> = { ...env };
  for (const [k, v] of Object.entries(overlay)) if (!NOT_OVERLAYABLE.has(k) && v !== '') merged[k] = v;
  for (const k of blocked) if (!NOT_OVERLAYABLE.has(k)) delete merged[k];
  return schema.parse(merged);
}

export function loadConfig(overrides: Partial<Record<keyof Config, string>> = {}): Config {
  const env: Record<string, string | undefined> = { ...process.env, ...overrides };
  // On Render, the app's own address is known before a custom domain is set up.
  if (!env.APP_URL && env.RENDER_EXTERNAL_URL) env.APP_URL = env.RENDER_EXTERNAL_URL;
  envRaw = env;
  const cfg = build(env);
  if (cfg.NODE_ENV === 'production') {
    if (!cfg.ENCRYPTION_KEY || cfg.ENCRYPTION_KEY.length < 32) {
      throw new Error('ENCRYPTION_KEY (32+ characters) is required in production.');
    }
    if (cfg.OWNER_PASSWORD === 'addendum-demo' && !cfg.DEMO_MODE) {
      throw new Error('Set OWNER_PASSWORD to a strong password before running in production.');
    }
  }
  cached = cfg;
  return cfg;
}

/** Applies credentials saved in the admin screen on top of the environment (saved values win). */
export function setConfigOverlay(values: Record<string, string>, blockedKeys: string[] = []) {
  overlay = { ...values };
  blocked = new Set(blockedKeys);
  cached = build(envRaw);
}

/** Whether a setting comes from the server environment (shown in the admin screen; never the value of a secret). */
export const envHas = (key: string) => !!envRaw[key]?.trim();
export const envValue = (key: string) => envRaw[key];

export function config(): Config {
  return cached ?? loadConfig();
}

export const squareBaseUrl = (c: Config) =>
  c.SQUARE_ENVIRONMENT === 'sandbox' ? 'https://connect.squareupsandbox.com' : 'https://connect.squareup.com';
