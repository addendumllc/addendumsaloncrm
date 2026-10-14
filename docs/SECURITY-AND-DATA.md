# Accounts, secrets and data safety

How sign-in, passwords, integration keys and the database stay safe — and survive updates, restarts and
redeployments. For day-to-day setup see [SETUP.md](SETUP.md).

## 1. Where everything is stored

| What | Where | Protected by |
|---|---|---|
| Accounts (name, email, role, approval) | `staff` table | database access |
| Passwords | `staff.password_hash` | bcrypt, cost 12, salted (never stored or logged in plain text) |
| Sign-in sessions | `sessions` table (SHA-256 of the cookie token only) | HttpOnly, Secure cookie; 14 days, renewed while in use |
| Password links | `password_reset_tokens` (SHA-256 only) | one use, 7 days (set-up) / 2 hours (reset) |
| Custom sign-in codes | `staff_login_codes` | Argon2id (19 MiB, 2 iterations, unique 16-byte salt); never stored or logged in plain text |
| Integration keys (Square, Shopify, GoHighLevel, email, AI) | `integration_credentials` | AES-256-GCM with `ENCRYPTION_KEY` |
| Square "Connect" (OAuth) tokens | `integrations` | AES-256-GCM with `ENCRYPTION_KEY`; refreshed automatically |

**The database must be durable.** Use PostgreSQL (`DATABASE_URL`) in production — on Render, a VPS (Docker
Compose includes PostgreSQL with a volume), or any managed Postgres. Without `DATABASE_URL` the app uses an embedded
database in `PGLITE_DIR`; the default (`./data/pglite`, inside the app folder) **can be erased by a redeployment**.
The server logs a warning and Admins see a banner when that's the case. If you must use the embedded database, set
`PGLITE_DIR` to an absolute path on a persistent disk.

Nothing about accounts lives in the browser except the session cookie, so clearing the browser, reinstalling the
home-screen app or restarting a device only means signing in again — accounts and passwords are on the server.
Browsers' password managers (iCloud Keychain on Apple devices, Google Password Manager on Android) can save the
password: the sign-in and password forms use the standard `username` / `current-password` / `new-password` fields.

## 2. Updates (database migrations)

- Schema changes are numbered files in `server/src/db/migrations/` (`001_…` → `014_…`), applied in order at start-up,
  each in its own transaction, and recorded in `schema_migrations` so none runs twice. They only **add** tables and
  columns: existing accounts, passwords and settings are kept. The database is never reset or recreated.
- Several servers starting at once take turns (a database lock).
- **A failed update is rolled back completely** and the server refuses to start with a clear message ("Database update
  … failed and was rolled back…"). Hosts that health-check (Render, Airo) keep the previous version running.
- The embedded database is copied to `<PGLITE_DIR>-backups/` before each update (newest 3 kept).
- A database already updated by a newer version is used as it is (warning only), so rolling the app back is safe.
- Never edit or delete an applied migration file; add a new numbered one.

## 3. Backups and restore

- **PostgreSQL:** turn on daily backups at your host (Render, Neon, etc.). With Docker Compose on a VPS,
  `deploy/server-setup.sh` installs a nightly `pg_dump` to `backups/` (14 days kept). Restore:
  `gunzip -c backups/addendum-YYYY-MM-DD.sql.gz | docker compose exec -T db psql -U addendum addendum` (into an empty
  database).
- **Keep `ENCRYPTION_KEY` with your backups** (in a password manager). A database backup without its key restores
  accounts and data, but not the saved integration keys — those would need entering again.
- Owners can also download a full data export (Settings → Privacy & activity).

## 4. Server settings (environment variables)

Set these in your host's environment / secrets settings — never in the code or Git (`.env` is git-ignored).

| Variable | Needed | Notes |
|---|---|---|
| `NODE_ENV=production`, `DEMO_MODE=false` | yes | `DEMO_MODE` defaults to **true** — set it. Demo data never replaces a database with real accounts. |
| `DATABASE_URL` | yes (recommended) | PostgreSQL connection string. |
| `ENCRYPTION_KEY` | yes | 32+ random characters (`openssl rand -base64 48`). Set once; keep a copy. |
| `ENCRYPTION_KEY_PREVIOUS` | only while rotating | The old key — see §5. |
| `OWNER_EMAIL`, `OWNER_PASSWORD` | first start | Creates the first Admin only when there are no accounts. Ignored afterwards. |
| `OWNER_RECOVERY_PASSWORD` | only for recovery | See §6. Remove after use. |
| `APP_URL`, `COOKIE_SECURE=true`, `TRUST_PROXY` | yes | See SETUP.md. |
| Square / Shopify / GoHighLevel / SMTP / AI keys | optional | Prefer entering them in **Settings → API & Integrations** (encrypted in the database). A value saved there wins over the environment, and an empty environment value never erases it. |

Development and production are separate: development uses Demo Mode (simulated Square, Shopify, HighLevel, email) and
its own database; the server refuses to start in production without a strong `ENCRYPTION_KEY` and owner password.

## 5. Rotating secrets

**Integration keys** (Settings → API & Integrations, Owner/Admin + password confirmation):
1. Create the new key at the provider (keep the old one active where the provider allows it).
2. Paste it in and **Save**. If the integration was working, the new key is **tested first**; if the test fails,
   nothing is changed and the working key stays in use ("Save anyway" exists for when the provider itself is down).
3. Revoke the old key at the provider.

- **Square:** a production access token (Developer Console → Credentials → replace token), or **Connect with Square**
  (OAuth: tokens are refreshed automatically; *Disconnect* revokes them).
- **Shopify:** a Dev Dashboard app's client ID + secret (the CRM exchanges them for 24-hour tokens itself — no
  long-lived token to rotate; rotating the secret in the Dev Dashboard is enough), or an older store app's `shpat_`
  token. Test connection shows the store and the permissions granted, and warns about missing or unneeded ones.
- **GoHighLevel:** a sub-account Private Integration token. Rotate it in HighLevel (Settings → Private Integrations →
  Rotate; HighLevel keeps the old token working for a few days), paste the new one, then let the old one expire.
- **Turn off** keeps an integration's keys but stops using them; **Remove** deletes the saved keys.

**`ENCRYPTION_KEY`:**
1. Set the new key as `ENCRYPTION_KEY` and the old one as `ENCRYPTION_KEY_PREVIOUS`; restart.
2. The log says "re-encrypted N saved secrets"; then remove `ENCRYPTION_KEY_PREVIOUS` and restart.

If the key is changed *without* `ENCRYPTION_KEY_PREVIOUS`, saved integration keys can't be read: Admins see a banner,
and either the old key is restored or the keys are entered again. Accounts and passwords are not affected (they don't
depend on this key).

## 6. Account recovery

- **Forgot password:** the sign-in screen emails a one-time link (needs email set up). An Admin can also create a
  reset link from Users & Permissions.
- **Change password:** the key icon next to *Sign out*; needs the current password and signs out other devices.
- **No Admin can sign in:** set `OWNER_RECOVERY_PASSWORD` (10–72 characters, letters + a number/symbol) and restart.
  The `OWNER_EMAIL` account gets that password, is made an active, approved Admin, and is signed out everywhere. It's
  applied once (a restart with the same value does nothing); remove the variable afterwards — Admins see a reminder.
  On a server with a shell: `npm run users -w server -- set-password --email <owner email>`.

## 7. Custom sign-in codes

An alternative to a password, for team members: on the sign-in screen choose **Sign-in code**, then enter email + code.
The code is the CRM's own credential — it isn't a Square passcode, PIN or API key, and Square never sees it.

- **Owners/Admins** manage codes on each person's page in Users & Permissions → *Sign-in code* (password confirmation
  required): generate a code (shown once, to hand over), choose one, turn it off/on, revoke it, and pick the Square
  location they work at (from the locations synced from Square). The status shows on/off, locked, last used — never the
  code. A Square link comes only from the team member ID the Square sync verified (Edit details); a code is never
  granted from a Square employee or location ID alone.
- **Strength:** at least 6 characters, or 8+ digits if numbers only; common codes, repeats, sequences and the person's
  name/email are refused. "Generate" makes a random 8-digit code.
- **Guessing:** every attempt names one account (the email), so a guess can't land on someone else's account. After 5
  wrong codes the account's code sign-in locks (15 min, then 1 h, 4 h, 24 h if it keeps happening) — even the right
  code is refused until it unlocks or an Owner sets a new code — and Admins get an alert. Sign-in is also limited per
  network address. Password sign-in isn't affected by a code lock.
- **Changes apply at once:** a new code works immediately and the old one stops; turning a code off or revoking it
  ends every session that code opened (password sessions stay). Approval and deactivation apply exactly as for passwords.
- Codes are kept in the database like passwords (migration `015_login_codes.sql`), so they survive updates and
  restarts and are included in database backups. If a code is forgotten, an Owner generates a new one.

## 8. Who can do what with secrets

- Viewing integration *status* (never values): `integrations:manage`.
- Saving, replacing, removing, turning off/on keys, and connecting/disconnecting Square: the **Owner/Admin role** with
  `integrations:manage`, **and** a password confirmed in the last 10 minutes. An individual permission grant can't give
  this to anyone else. Enforced on the server for every request.
- Secret values are never sent to the browser, never echoed in errors, and never written to the activity log (it
  records which fields changed). Anything the server logs is scrubbed of known secrets, bearer tokens and URL
  passwords. Settings → API & Integrations → **Recent changes** lists who changed which keys.

## 9. Deploying an update

1. Make sure `DATABASE_URL` (or a persistent `PGLITE_DIR`) and `ENCRYPTION_KEY` are set on the host — unchanged.
2. Publish/deploy as usual. Pending migrations (now up to `015_login_codes.sql`) apply automatically.
3. If the start fails with "Database update … failed and was rolled back", the previous version keeps running and no
   data changed: send that message to whoever maintains the app.
4. After deploying, an Admin checks there's no warning banner (storage or encryption key).
