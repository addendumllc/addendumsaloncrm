# Integrations — developer guide

How Square, Shopify, GoHighLevel, email and AI are wired in, how to configure them in development (VS Code), what
administrators can change in the app, and how to add a new integration. Secrets handling and recovery:
[SECURITY-AND-DATA.md](SECURITY-AND-DATA.md). Connecting each service step by step: [SETUP.md](SETUP.md).

## 1. Working in VS Code

1. `npm ci` (Node 20+; the project pins 22 in `.node-version`).
2. `cp .env.example .env` and leave `DEMO_MODE=true` to start: every integration runs against a built-in simulator
   (Square, Shopify, HighLevel, email), so nothing real is touched. `.env` is git-ignored — never commit real keys.
3. **Terminal → Run Task → "Run the app (dev)"** (or `npm run dev:nobrowser`): web on :5173, API on :4000.
   **Run and Debug → "Server (debug, reads .env)"** to set breakpoints in the server.
4. **Run Task → "Run all tests"** (`npm test`) and **"Type check"** (`npm run typecheck`) before committing. The Vitest
   extension shows the tests in the Testing panel.
5. To try a real service in development, put its *sandbox / development* credentials in `.env` (or in the app under
   Settings → API & Integrations) and set `DEMO_MODE=false` — keep production keys out of development.

## 2. How integrations are built

```
server/src/integrations/
  <service>/                 one folder per service
    <Service>Service.ts        the interface the rest of the app uses (+ a Mock implementation for demo/tests)
    <Service>ApiService.ts     the real implementation (HTTP calls, auth, retries, friendly errors)
  registry.ts                picks real vs simulated per service (demo mode, configured or not, turned off)
  credentials.ts             which settings each service has, encrypted storage, status, turn off/on
  connectionTests.ts         "Test connection": one real, read-only call per service
server/src/domain/           business logic (orders, sync, commission…) — uses the interfaces, never HTTP directly
server/src/routes/           thin HTTP layer: validate → domain → response
web/                         UI only; it never sees a secret and never calls a provider directly
```

- **Configuration** is read through `config()`. A value saved in Settings → API & Integrations (encrypted with
  `ENCRYPTION_KEY`) overrides the environment, and is applied immediately — no rebuild or restart. An empty environment
  value never erases a saved one.
- **Errors** from providers become `IntegrationError` with a staff-friendly `userMessage`; technical detail goes to the
  server log, which is scrubbed of secrets.
- **Business rules stay in the domain layer.** Settings can't bypass them: e.g. Order Hair always checks Shopify stock and
  uses compare-and-set + idempotency keys (`domain/inventory.ts`), whatever is configured; Square calls are limited to
  the permissions granted to the Square app.

## 3. What can be changed in the app vs in code

| Change | Where | Who |
|---|---|---|
| Keys/tokens/passwords for Square, Shopify, HighLevel, SMTP, AI; replacing one (tested first) | Settings → API & Integrations | Owner/Admin + password |
| Shopify store address, inventory location; Square environment, inventory location, webhook URL; HighLevel location | Settings → API & Integrations | Owner/Admin |
| Turn an integration off/on, test a connection, see status / last success / errors / change history | Settings → API & Integrations | Admin |
| Connect / disconnect Square (OAuth) | Settings → Square | Owner/Admin + password |
| Hair order email recipient, quick picks; reminders, rules, texts; salon network access | Settings | Admin |
| New API permissions (scopes) | In the provider's app (Square Developer Console, Shopify Dev Dashboard, HighLevel), then **Test connection** | Owner + developer |
| A new integration, a new kind of data, changed inventory logic | Code (below), tests, deploy | Developer |
| Database, `ENCRYPTION_KEY`, `APP_URL`, `DEMO_MODE`, `TRUST_PROXY` | Server environment | Whoever hosts the app |

API base URLs and API versions (`HIGHLEVEL_API_BASE`, `SQUARE_API_VERSION`, `SHOPIFY_API_VERSION`) are deliberately
**not** editable in the app: pointing a service at another address would send its token there. Change them in the
server environment after testing.

## 4. Permissions each service needs

- **Square:** `APPOINTMENTS_READ APPOINTMENTS_ALL_READ CUSTOMERS_READ EMPLOYEES_READ ITEMS_READ MERCHANT_PROFILE_READ
  INVENTORY_READ INVENTORY_WRITE ORDERS_READ PAYMENTS_READ`. Webhooks: `booking.created`, `booking.updated`,
  `inventory.count.updated` to `https://<your address>/api/webhooks/square` (the same URL in the app's Square settings).
- **Shopify** (Dev Dashboard app, client credentials; or an older store app's `shpat_` token):
  `read_products read_inventory write_inventory read_locations`. Test connection lists what's granted and warns about
  missing or unneeded scopes. Order Hair deducts stock with `inventorySetQuantities` (compare-and-set, idempotent).
  The CRM doesn't receive Shopify webhooks, so no webhook secret is needed.
- **GoHighLevel:** sub-account Private Integration token with `contacts.readonly contacts.write users.readonly
  locations.readonly`, and the Location ID.
- **Email:** any SMTP account allowed to send (Microsoft 365: SMTP AUTH on for the mailbox; Google: an app password).

## 5. Adding a new integration

1. **Interface + implementations:** `server/src/integrations/<name>/<Name>Service.ts` with the interface the app needs,
   a `Mock<Name>Service` (used in Demo Mode and tests), and `<Name>ApiService.ts` calling the real API. Throw
   `IntegrationError` with a friendly message; never include a secret in a message.
2. **Settings:** add the environment keys to `server/src/config.ts` (zod schema) and `.env.example` (no real values), and
   a `CREDENTIAL_SPECS` entry in `credentials.ts` — mark secrets `secret: true`, add validators. The admin screen,
   encryption, status, turn off/on, change history and log scrubbing then work automatically.
3. **Registry:** a factory in `registry.ts` returning the mock in Demo Mode, `null` when not configured or turned off,
   otherwise the real service. Register a `onCredentialsChanged` hook if the client caches tokens.
4. **Connection test:** a case in `connectionTests.ts` — one read-only call that proves the credentials and permissions.
5. **Use it from the domain layer**, behind the interface; add API routes with the permission they need in
   `auth/permissions.ts` (`API_RULES` is deny-by-default).
6. **Tests:** workflow tests against the mock (and the connection-test override for failures); `npm test`.
7. **Docs:** permissions/scopes and setup steps here and in SETUP.md. If it needs a database table, add the next
   numbered migration (add-only — never edit an applied one).
