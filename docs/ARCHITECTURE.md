# Architecture

## Stack

| Layer | Choice | Why |
|---|---|---|
| Web app | React 18 + TypeScript + Vite + Tailwind, TanStack Query, React Router | Component-based, fast, typed end to end |
| API | Node 20 + Express + TypeScript, Zod validation | Simple REST, one deployable |
| Database | **PostgreSQL** (production) / **PGlite** — real Postgres compiled to WASM — for demo & tests | One SQL dialect everywhere; demo needs no install |
| Shared | `@addendum/shared` — types and constants used by both sides | API and UI can't drift |
| Charts | Recharts, colour-blind-validated palette | |

```
/shared      types + constants (DTOs, statuses, labels)
/server
  src/config.ts               every env var (secrets live only here)
  src/db/                      pg / PGlite adapter + SQL migrations
  src/integrations/            ← swappable services, never imported by the UI
     square/  SquareApiService | MockSquareService   (+ OAuth, webhook signature)
     shopify/ ShopifyApiService | MockShopifyService  (Order Hair inventory)
     highlevel/ HighLevelApiService | MockHighLevelService
     ai/      AnthropicAIService | RuleBasedAIService
     email/   SmtpEmailService | MockEmailService
     notifications/ NotificationService
     registry.ts               picks live vs demo implementation from config
  src/domain/                  business logic
     squareSync.ts   import + change detection (new / cancelled / rescheduled / no-show)
     rulesEngine.ts  data → follow-ups (dedupe keys, auto-resolve)
     dashboard.ts    "Today's Priorities" + recommended actions
     rebooking.ts    per-client booking rhythm (overall)
     newClients.ts   new clients (first-ever visit) → rebooked / booked ahead, by stylist (dashboard + My Commission)
     rebookingSchedule.ts per client + service schedules (service defaults, client overrides) → rebooking follow-ups
     inventorySync.ts Square ↔ Shopify stock sync (baseline merge, compare-and-set, idempotent writes, one run at a time)
     commission.ts   Square orders/payments → commission records (attribution, rules, refunds, tiers, finalizing)
     users.ts        accounts, roles, per-person permission overrides, password links (all safety rules)
     messaging.ts    inbound pipeline, sending, drafts, opt-outs, optional auto-reply
     highlevelPush.ts contact matching, task push, retry queue
     autoSend.ts     reminders / review requests (only when enabled)
     inventory.ts    Addendum Hair order requests: save, email, retry, status
     scheduler.ts    background jobs
  src/routes/                  REST endpoints (thin: validate → domain → DTO)
  src/auth/permissions.ts      permission checks + the deny-by-default API gate (API_RULES)
  src/auth/scope.ts            record-level filtering (own clients only, hidden contact details)
  src/integrations/credentials.ts encrypted credential store (Settings → API & Integrations) layered over env vars
  src/cli/users.ts             command-line account recovery (day-to-day: Settings → Users & Permissions)
  test/                        workflow tests (supertest + PGlite)
/web
  src/pages/                   one file per screen; settings/ split by section
  src/components/ui            design-system primitives
  src/components/domain        TaskCard, ComposerModal, HighLevelButton, pickers…
  public/embed.js              website embed script
```

Each integration is an interface with a live and a demo implementation. Texting has no server
integration: the browser opens Apple Messages with an `sms:` link (`web/src/lib/sms.ts`), and the server
only logs the hand-off and what staff report afterwards (`startText` / `finishText` in `domain/messaging.ts`).

## Core flow

```
Square ──webhook / poll──▶ squareSync ──▶ appointments (+ events) ─┐
Staff ──Text button─────▶ messaging  ──▶ conversations / leads ───┤
                                                                   ▼
                                 rulesEngine (every 5 min + on every change)
                                   ├─ creates follow-ups (deduped)   ──▶ Follow-Ups / Dashboard
                                   ├─ auto-closes ones no longer needed (client rebooked, lead booked…)
                                   └─ queues HighLevel pushes for enabled events ──▶ retry queue ──▶ HighLevel
Staff: Text (AI draft → review → send) · Call · Book in Square · Push to HighLevel · Complete
```

**Square is the source of truth.** Appointments are a read-only mirror keyed by Square booking ID
and `version`. Follow-ups and tasks live in a separate `tasks` table and are never displayed as
bookings. "Book" buttons open Square's booking flow; the app never writes to Square.

## Data model (PostgreSQL)

`staff`, `sessions`, `locations`, `services`, `clients`, `client_staff`, `leads`, `appointments`,
`appointment_services`, `appointment_events`, `conversations`, `messages`, `tasks` (follow-ups +
internal tasks), `notes`, `tags`, `client_tags`, `automation_runs`, `notifications`,
`integrations` (encrypted credentials), `webhook_events` (idempotency), `audit_logs`, `settings`,
`inventory_requests`, `inventory_request_items`, `square_inventory`, `integration_credentials` (encrypted keys),
`inventory_sync_links`, `inventory_sync_runs`, `service_rebooking_rules`, `client_service_rebooking` (client overrides,
kept apart from the defaults), `role_templates`, `role_permissions`, `staff_permission_overrides`,
`password_reset_tokens` (hashes only), `commission_rules` (effective-dated, never edited in place), `commission_orders`,
`commission_payments`, `commission_attributions`, `commission_review_accepted`, `commission_periods`,
`commission_entries` (each with its rate and calculation; unique `source_key` per order + line + stylist),
`commission_entry_events` (history), `commission_sync_runs`.

All tables use UUID keys and `created_at` / `updated_at`. External IDs are stored and unique
(`square_booking_id`, `square_customer_id`, `square_team_member_id`, `hl_contact_id`,
`hl_task_id`, `provider_message_id`). There are 20 indexes on lookup paths: phone, start time,
status + due date, dedupe keys. Schema: `server/src/db/migrations/` (`001_init.sql` … `010_commission.sql`). Migrations run
automatically on start and only add — existing data is kept.

## External APIs — verified, not assumed

Checked on 7 Oct 2026 against primary sources: Square's developer docs and official Node SDK
(`square@46`), HighLevel's official OpenAPI repository. Shopify's Admin GraphQL docs checked 9 Oct 2026.

**Square** (`Square-Version: 2026-09-16`, the version pinned by the official SDK):
`GET /v2/bookings` (31-day windows, cursor paging), `GET /v2/bookings/{id}`,
`POST /v2/customers/bulk-retrieve`, `POST /v2/team-members/search`,
`GET /v2/catalog/list?types=ITEM` (filtered to `APPOINTMENTS_SERVICE`), `GET /v2/locations`,
`GET /v2/merchants`; OAuth `/oauth2/authorize`, `/oauth2/token` (with refresh), `/oauth2/revoke`,
`/oauth2/token/status` (permissions check in Test connection).
Inventory: `POST /v2/inventory/counts/batch-retrieve`, `POST /v2/inventory/changes/batch-create` (`PHYSICAL_COUNT` with
`occurred_at` = when Square was read, so later sales still apply; idempotency keys). Commission: `POST /v2/orders/search`
(`updated_at` filter with matching `UPDATED_AT` sort, ≤10 locations, ≤1000 per page) and `GET /v2/payments`
(`begin_time`/`end_time`). Verified in the SDK types: order line items carry **no team member**, payments and refunds
carry `team_member_id`, and Square has no commission API — so attribution comes from bookings and commission is
calculated in the CRM. Webhook `inventory.count.updated` triggers a debounced stock sync.
Webhooks `booking.created`, `booking.updated`, verified with HMAC-SHA256 over
`notification URL + raw body` (`x-square-hmacsha256-signature`). Statuses used exactly as the SDK
defines them; there is no "completed" status (see SETUP §3).

**HighLevel** (`services.leadconnectorhq.com`, `Version: 2021-07-28`; the v3 spec has identical
paths and payloads for these): see the endpoint table in SETUP §4. The deprecated
`GET /users/?locationId=` is deliberately **not** used; `GET /users/search` is.

**Shopify:** Admin GraphQL `inventorySetQuantities` with the `@idempotent` directive and `changeFromQuantity`
(compare-and-set: the sync passes the quantity it read, and a `CHANGE_FROM_QUANTITY_STALE` error means a sale happened
mid-sync, so it retries next run instead of overwriting); `productVariants` → `inventoryItem.inventoryLevel(locationId)`
→ `quantities(names: ["available"])` to read stock; `currentAppInstallation.accessScopes` to check permissions.
Tokens from the client credentials grant (Dev Dashboard apps) or a legacy `shpat_` token.

**Email:** standard SMTP via `nodemailer` (any provider). Failed sends are kept and retried with backoff.

**Anthropic:** Messages API (`/v1/messages`, `anthropic-version: 2023-06-01`), server-side only,
with a template fallback if the API is unreachable.

## Security

- **Auth:** email + password (bcrypt, cost 12) → random session token in an **HttpOnly** cookie (`Secure; SameSite=None` in production for the embed); sessions stored server-side and revoked on deactivation.
- **Roles & permissions:** templates Admin / Reception / Stylist / Assistant (new accounts) + per-person grants and
  denials; effective permissions are read from the database on every request (changes apply immediately). A
  deny-by-default gate refuses any API path not listed with its permissions; routes add record-level rules (own
  appointments, own clients, own commission, hidden contact details). No self-changes, no granting what you don't hold,
  no managing people with more access, sensitive grants need confirmation, and the last permission manager can't be
  removed.
- **Credentials:** entered in Settings → API & Integrations, encrypted at rest, never returned to the browser
  (only "set / where from"), never logged (the audit log records field names only).
- **Password links:** one-time, hashed, expiring; setting a password signs the person out everywhere else.
- **CSRF:** every state-changing request needs a custom header that other sites can't send cross-origin.
- **Rate limits:** API (600/min), sign-in (10 per 15 min), webhooks (300/min).
- **Webhooks:** Square HMAC signatures checked with timing-safe comparison; webhook IDs deduped.
- **Secrets:** only in env vars; Square OAuth tokens encrypted at rest (AES-256-GCM with `ENCRYPTION_KEY`). The browser only talks to this server.
- **Headers:** Helmet with a strict CSP (`script-src 'self'`, `frame-ancestors` allow-list), HSTS via HTTPS.
- **Validation:** Zod on every input; parameterised SQL only.
- **Errors:** friendly messages for staff, technical detail only in server logs.
- **Audit log:** who did what, with record IDs only (never message text, phone numbers or notes).

## Privacy

Full JSON export (owner), per-client export / archive / permanent delete, internal client-profile notes kept
separate from client messages and never sent to AI or HighLevel (a follow-up's own notes *are* included in its HighLevel task), and
STOP / START opt-out handling. Auto-sending of AI, reminders and reviews is off by default.

## What was added beyond the brief

Things a busy salon would trip over that the original spec didn't mention:

1. **A2P 10DLC registration.** US carriers block unregistered business texting. Called out in setup and in Settings.
2. **SMS consent + STOP/START** handling, with sending blocked to opted-out numbers.
3. **Quiet hours** for any automatic text.
4. **"Completed" doesn't exist in Square.** Derived honestly from past `ACCEPTED` bookings, and labelled as such.
5. **Auto-closing follow-ups.** When a client rebooks in Square, their cancellation / no-show / rebook follow-ups close themselves, so nobody texts a client who already booked.
6. **Dedupe keys on every rule.** The engine can run every few minutes without ever creating duplicate follow-ups or HighLevel tasks.
7. **Smart rebooking only with enough history** (configurable minimum visits). Otherwise it says nothing.
8. **Confirmations by text.** A reply of "C" / "yes" to a reminder marks the next appointment confirmed.
9. **Unknown texters become leads** automatically, with service + timeframe detected.
10. **Review-request throttle:** at most one ask per client per 90 days.
11. **Consultation completed → "help them book"** follow-up.
12. **Safari / third-party-cookie embed issue:** subdomain guidance, plus an in-app fallback.
13. **Square OAuth can't run inside an iframe:** it opens in a new tab when embedded.
14. **HighLevel has no task priority field:** priority goes in the title so it's visible there.
15. **Booked value ≠ revenue:** analytics labels catalog-price value honestly, excluding tips and discounts.
16. **Demo tools** that drive the real sync, webhook and retry code paths, so staff can rehearse before go-live.

## Known limits / next steps

- **Email** needs SMTP credentials on the server (see SETUP §7). Until then, inventory requests are saved and sent automatically once it's configured.
- **Commission attribution** depends on Square bookings matching sales (same customer, same day). Walk-in sales with no
  booking use the payment's team member, otherwise they go to Needs review. Square's own tip-pooling isn't in its API.
- **Payments and refunds are processed in Square**, not in the CRM, so there are no "process payment" permissions.
- **Booking and rescheduling** happen in Square (the CRM opens the booking link); the CRM has no booking permissions.
- **Multiple locations:** data is location-aware (Square location IDs are stored), but there's no location filter in the UI yet.
- **Background jobs** run in-process (one server). Move them to a worker if you ever run several instances.
- **Two-factor sign-in** for owner accounts is a sensible addition before many staff accounts exist.
