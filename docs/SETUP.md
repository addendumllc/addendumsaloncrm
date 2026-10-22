# Setup guide

This takes the app from Demo Mode to the salon's real Square, texting and HighLevel accounts.
Every credential goes in the **server's environment variables** (`.env` or your host's
"Environment" settings). None of them ever reach the browser.

Contents:
1. [Deploy](#1-deploy)
2. [Team members & logins (manual)](#2-team-members--logins-manual)
3. [Connect Square](#3-connect-square)
4. [Texting (Apple Messages)](#4-texting-apple-messages)
5. [Connect GoHighLevel](#5-connect-gohighlevel)
6. [Turn on AI drafting](#6-turn-on-ai-drafting-optional)
7. [Email, Order Hair & Shopify](#7-email-order-hair--shopify)
8. [Colours](#8-colours)
9. [Embed on the Addendum Salon website](#9-embed-on-the-addendum-salon-website)
10. [Go-live checklist](#10-go-live-checklist)

---

## 1. Deploy

> Accounts, passwords, integration keys, backups, key rotation and recovery: see
> [SECURITY-AND-DATA.md](SECURITY-AND-DATA.md).
> Developing in VS Code, how integrations are built, what admins can change in the app: see
> [INTEGRATIONS.md](INTEGRATIONS.md).

The app is one Node service plus a PostgreSQL database. Any host that runs Docker or Node 20+
works (Render, Railway, Fly.io, DigitalOcean App Platform, AWS, a VPS).

**Address:** the CRM runs on its own domain, `https://addendumsalon.info`. Point the domain at your host:
- apex `addendumsalon.info`: an `A`/`ALIAS` record to your host,
- `www.addendumsalon.info`: a `CNAME` to `addendumsalon.info`.

Turn on HTTPS for both. `www.` and the old `app.addendumsalon.com` forward to `https://addendumsalon.info`
through `REDIRECT_HOSTS` (if they point at the same server). Opening the CRM directly, or from the phone home screen,
works in every browser. Embedding it inside the salon website is limited, because it's now a different site (see §9).

### Option A — Docker (any host)

```bash
cp .env.example .env               # fill in at least the Core section
export POSTGRES_PASSWORD='a-long-random-password'
docker compose up -d --build       # app on :4000, Postgres in a volume
```

Put HTTPS in front (your host's load balancer, Cloudflare, or Caddy:
`addendumsalon.info, www.addendumsalon.info { reverse_proxy localhost:4000 }`).

### Option B — Node host (Render/Railway style)

- Build command: `npm ci && npm run build`
- Start command: `npm start`
- Add a managed PostgreSQL and set `DATABASE_URL`
- Health check path: `/api/health`

### Minimum production settings

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DEMO_MODE` | `false` |
| `APP_URL` | `https://addendumsalon.info` |
| `REDIRECT_HOSTS` | `www.addendumsalon.info,app.addendumsalon.com` |
| `DATABASE_URL` | your Postgres URL (tables are created automatically on start) |
| `ENCRYPTION_KEY` | 32+ random characters — `openssl rand -base64 48` |
| `COOKIE_SECURE` | `true` |
| `OWNER_EMAIL` / `OWNER_PASSWORD` | the first owner login (created once, on first start) |

The server refuses to start in production without a strong `ENCRYPTION_KEY` and a non-default
owner password.

Then sign in and follow the setup wizard. Team logins are added manually (§2).

> **Run one instance.** Background jobs (Square safety-net sync, HighLevel retry queue, rules,
> automatic reminders) run inside the server process. If you scale out later, move them to a
> single worker.

> **Backups.** Turn on daily backups for the Postgres database at your host.

---

## 2. Team members, roles & permissions

Everyone signs in with their own account — no shared logins. Sign-in is the CRM's own email and password; a Square
account is never needed (linking someone to their Square team member is optional and only matches their bookings and
sales).

**New logins wait for approval.** Creating a login never grants access by itself:
- An employee added in Users & Permissions, or someone who uses **Request access** on the sign-in screen, gets a login
  in **Pending approval**. They can choose a password but can't sign in or see anything yet.
- Every Admin is notified (in the app, and by email when it's set up). Pending people are listed at the top of
  **Users & Permissions**: choose their role template and **Approve**, or **Reject**. Only Admins can approve or reject,
  and never their own account. An Admin adding someone can tick **Approve their access now**.
- Statuses: Pending approval → Active, or Rejected (can still be approved later); an active account can be
  Deactivated and Reactivated. Turn off **Request access** under Users & Permissions if you don't want it.
- Existing accounts and Square-imported team members are already approved.

**Sidebar** (in this order, each tab only with its permission): Dashboard, Follow-Ups, Tasks, Appointments, Messages,
Clients, Order Hair, Inventory Sync, My Commission, Team Commission, Analytics, Settings. **Clients** holds both the
client list and *New client inquiries* (formerly the New Clients tab), with **Add New Client**.

**Dashboard widgets** are permissions too (Settings → Role templates, or per person): Schedule, Follow-ups and tasks,
Clients and activity, Team announcements, Order Hair, My commission, Team commission, Analytics. A widget appears only
with its widget permission *and* the permission for its data; the server leaves everything else out.

**Projected service revenue** (Analytics → top, and Dashboard cards) — *Admins/Owners only by default* (permission
"Projected service revenue", plus the Dashboard widget of the same name; only people who hold it can grant it).
Weekly (day by day), monthly (week by week) and future (next 7/30/90 days or a custom range) projections from
**confirmed** salon appointments at their booked service prices, grouped by the salon's time zone: projected revenue,
unique clients, appointments, average per client and per appointment, plus the appointments behind them.
Cancelled appointments and no-shows are left out; booking requests awaiting confirmation are shown separately;
appointments without a known price are flagged **Unestimated** and not added. These are projections — not collected
sales — and never include hair product, retail or commission figures.

**Team announcements** (top of Tasks, and on the Dashboard): title, message, author, date, optional link, *Important*,
*Pinned*, for the whole team or chosen roles; people mark them read. Permissions: *View*, *Create and publish* (their
own), *Manage all*. Publishing never creates tasks.

**Calendars**: everyone sees their own calendar. **Can view team calendars** (a permission in role templates or on a
person) shows other team members' appointments — for everyone, or only the people ticked under **Team calendars** on
that person's account. Assistants see only their own until an Owner/Admin grants it. Viewing never allows changing,
cancelling or rescheduling: appointments are changed in Square.

**Role templates** have their own screen (**Settings → Role templates**), built for phones too: create your own
templates (empty or copied from another), rename them, switch permissions on and off, see who uses each one and assign it
to people. Built-in templates (Admin, Reception, Stylist, Assistant) can be edited but not renamed or deleted; a custom
template can be deleted once nobody uses it.

Manage the team in **Settings → Admin → Users & Permissions**:

- **Add employee**: name + email. New accounts always start as **Assistant** (least access). The person gets an
  email with a one-time link to choose their password (or you copy the link and send it yourself if email isn't set
  up). Links work once; set-up links expire after 7 days, reset links after 2 hours.
- **Roles** — four templates, each a starting point you can edit under *Role templates*:
  - **Admin**: everything, including settings, API keys, users & permissions, commission plans and payroll exports.
  - **Reception** (shown as "receptionist" in the database): the day-to-day CRM — calendar, clients, leads, texting,
    follow-ups, ordering hair for stylists, their own commission. Same access as the old Receptionist role.
  - **Stylist**: My Calendar, Order Hair, My Commission. Same as before plus their own commission.
  - **Assistant** (default for new accounts): dashboard, calendar, clients (with contact details and history),
    service menu, follow-ups and rebooking help, viewing products, their own commission. No API keys, user management,
    team commission/payroll, inventory edits or sync, deleting clients, or exports.
- **Individual permissions**: open a person → set any permission to *Role* (follows the template), *Allow* or *Deny*
  for that person only. **Review changes** shows exactly what they gain or lose before saving. Sensitive permissions
  (API keys, users & permissions, team commission, exports, audit log, sensitive financial reports…) need an extra
  confirmation.
- **Changing someone's role** drops the extra permissions they were individually given, so nothing elevated carries
  over by accident (individual restrictions are kept unless you tick *Also clear individual restrictions*).
  **Reset to role defaults** clears everything custom for that person.
- **Deactivate** signs the person out everywhere straight away; their history and commission records stay.
  **Password reset link** creates a new one-time link. People can also use *Forgot password?* on the sign-in page
  (needs email set up).
- Every permission is checked on the server for every request, and any API path not explicitly listed is refused.
  Changes apply on the person's next click. Nobody can change their own role or permissions, give out a permission they
  don't have, or manage someone with more access than them. The app won't let the last person who can manage
  permissions be removed, demoted or deactivated.
- Every change is recorded in **Settings → Privacy & activity** (who, what, when — never passwords, links or keys).

**Existing employees keep their roles** after updating. **Stylists imported from Square** are created as Assistant
accounts without a password; set their role to Stylist and send them a set-up link from Users & Permissions.
Linking an account to its **Square team member ID** (shown on each person) is what connects their bookings and sales.

**Recovery if nobody can sign in as an admin** — the command-line tool still works on the server:

```bash
npm run users -w server -- list
npm run users -w server -- set-role --email owner@addendumsalon.com --role admin
npm run users -w server -- set-password --email owner@addendumsalon.com
```

(In Docker: `docker compose exec app node dist/users.js list`.) The first admin is created automatically on the very
first start from `OWNER_EMAIL` / `OWNER_PASSWORD`.

---

## 2a. Location & Access (salon network)

**Settings → Admin → Location & Access** (Owners/Admins only; saving asks for your password):
- **Approved networks**: register the salon's public IP address — and the office's, or any other location — each with a
  name. On a device connected to that network, type the name (e.g. "Office") and tap **Add this connection**.
  "This connection" shows the address the server sees and which approved network you're on.
- **Allow Access Anywhere** (default **OFF**): when OFF, *computers* can only use the CRM on the salon network; phones
  and tablets keep working as usual (or turn on **Restrict phones and tablets too**). When ON, the CRM works from any
  network. Changes apply immediately.
- Nothing is restricted until a salon IP is registered, so publishing this never locks anyone out by itself.
- These rules never change permissions: everyone signs in with their own login and their role decides what they can
  do — being at the salon adds nothing. Enforced by the server on every request.
- **Check the IP is right**: "This connection" must match your public IP (search "what is my IP"). If it doesn't, your
  host has extra proxy layers: set `TRUST_PROXY=2` (or the number of layers) on the server.
- **If the salon's IP changes**: an Admin's phone works off the salon network, so connect the phone to the salon Wi-Fi
  and tap **Use this connection's IP** (remove the old one), then save. If no Admin can get in at all, set
  `ACCESS_ALLOW_ANYWHERE=true` on the server, restart, fix the IP, then remove it.
- The phone-or-computer check uses what the browser reports, which a determined person could fake; turn on **Restrict
  phones and tablets too** for IP-only control.

## 2b. API keys & integrations

**Settings → Admin → API & Integrations** is where an administrator enters and checks every key: Square, Shopify,
GoHighLevel, email (SMTP) and AI. One card per integration shows its status (Connected / Not configured / Connection
error / not tested yet), what's still missing, the last check, and where to find each value.

- Secrets are encrypted on the server (AES-256-GCM with `ENCRYPTION_KEY`) and never shown again — not in the page,
  the browser, logs or error messages. To change one, type the new value; leaving the box empty keeps it.
  Public IDs (application ID, client ID, store address) are shown so you can check them.
- **Test connection** always calls the real service and reports exactly what's wrong (wrong key, missing permissions,
  location not found). Nothing is reported as connected without a successful check.
- Values in the server's `.env` still work; a value saved on this page takes priority.
- **Remove** warns you first if the integration is in use (e.g. inventory sync or commission is turned on).

## 3. Connect Square

The app **only reads** from Square — appointments (Bookings API), customers, team members,
services (Catalog) and locations. It never creates, changes or cancels a booking. Square stays the
source of truth; internal follow-ups are stored separately and never shown as appointments.

### 2a. Create the Square app (one time, ~10 minutes)

1. Go to **developer.squareup.com → Applications → +** and create an app named "Addendum Salon CRM".
2. Open **Credentials** (switch to **Production**). Copy:
   - Application ID → `SQUARE_APPLICATION_ID`
   - Application secret → `SQUARE_APPLICATION_SECRET`
3. Open **OAuth** (Production) and set the **Redirect URL** to:
   `https://addendumsalon.info/api/integrations/square/callback`
   (Settings → Square → *Developer setup details* shows the exact value with a Copy button.)
4. Open **Webhooks → Subscriptions → Add subscription** (Production):
   - URL: `https://addendumsalon.info/api/webhooks/square`
   - API version: `2026-09-16`
   - Events: `booking.created`, `booking.updated`, `customer.created`, `customer.updated`, `inventory.count.updated`
   - Save, then copy the **Signature key** → `SQUARE_WEBHOOK_SIGNATURE_KEY`
   - Set `SQUARE_WEBHOOK_URL` to the exact URL above (it's part of the signature check).
5. Restart the app.

### 2b. Connect

**Settings → Square → Connect Square.** Sign in with the salon owner's Square account and approve.
The app asks for these read-only permissions:

`APPOINTMENTS_READ`, `APPOINTMENTS_ALL_READ` (all stylists' bookings, not just one), `INVENTORY_READ` (retail stock),
`INVENTORY_WRITE` (Shopify → Square stock updates by the inventory sync), `ITEMS_WRITE` (optional: “Use Shopify SKU in Square” and editing SKUs on Inventory Sync), `CUSTOMERS_READ`, `EMPLOYEES_READ`, `ITEMS_READ`,
`MERCHANT_PROFILE_READ`, `ORDERS_READ` and `PAYMENTS_READ` (sales, refunds and tips for commission), `TIMECARDS_READ`
(optional: hours from Square timecards for hourly wages) and `TIMECARDS_WRITE` (optional: Owners/Admins send hours
entered in the CRM to Square as timecards from Team Commission → Payroll hours).
If you connected before these were added, press **Connect Square** again once to approve them. An access token from
the Developer Console has all of them.

It then imports the last `SQUARE_BACKFILL_DAYS` (default 400) of appointments and the next 90 days.
A year of history is what powers smart rebooking. You'll see **Square Connected ✓ · Last sync: …**

**Simpler alternative for a single salon:** instead of OAuth, paste a Production **access token**
from the developer console into `SQUARE_ACCESS_TOKEN` and restart. (OAuth is better long-term:
tokens refresh automatically and the owner can reconnect from Settings.)

### How syncing works

- **Webhooks** deliver new bookings, cancellations, reschedules and no-shows within seconds.
- A **safety-net sync** runs every 15 minutes (`SQUARE_SYNC_INTERVAL_MINUTES`) in case a webhook is missed. **Sync now** runs it on demand.
- Each booking is matched by its Square booking ID and `version`, so nothing is ever duplicated.
  Changes are recorded as events (created, cancelled, rescheduled, no-show).
- If Square disconnects or a token expires, the app shows *"Square connection expired. Please reconnect."* All existing data stays.

### What Square does and doesn't provide

Square booking statuses are: `PENDING`, `ACCEPTED`, `CANCELLED_BY_CUSTOMER`, `CANCELLED_BY_SELLER`,
`DECLINED`, `NO_SHOW`. **There is no "completed" status.** The app shows a past `ACCEPTED`
booking as *Completed*. No-shows appear only if staff mark them in Square. "Booked value" in
Analytics comes from catalog service prices, not payments collected.

**Testing first?** Set `SQUARE_ENVIRONMENT=sandbox` and use the Sandbox credentials and test
seller account. Switch back to `production` for real data.

---

## 4. Texting (Apple Messages)

There's nothing to connect and no texting service to pay for. Texts are sent from **Apple Messages on the
staff member's own Mac (or iPhone)**:

1. Click **Text** on a client, lead, follow-up or conversation. Write the message, or let the CRM draft it.
2. **Open in Messages** opens a Messages conversation with the client's number and the text filled in.
   Edit it if needed and send it there.
3. Back in the CRM, tap **I sent it** or **I didn't send it**. Follow-ups are completed only after "I sent it".

The CRM can't see inside Messages (Apple offers no API for that), so it never claims a text was sent or
delivered. It records *opened in Messages*, *marked sent* or *not sent*, based on what staff tell it.
Replies arrive in Messages, not in the CRM. Nothing is texted automatically in the background.
Reminders and review requests appear as follow-ups for staff to send.

**Mac setup (once per Mac):**
- Open **Messages** and sign in with the salon's Apple Account (Messages → Settings → iMessage).
- To text Android phones, turn on **Text Message Forwarding** for the Mac on the salon iPhone
  (Settings → Apps → Messages → Text Message Forwarding).
- The first time, the browser asks to open Messages. Allow it (tick "always allow" in Chrome).

If Messages doesn't open, the CRM shows the number and message with **Copy** buttons so the text can be
sent from a phone instead. **STOP** opt-outs recorded in the CRM still block the Text button.

**Saved replies:** the **Saved replies** button in the text box offers the salon's own ready-made texts,
with the ones that fit the situation first. The situation comes from the follow-up (rebook, no-show,
cancellation…) or what the client's last text was about (pricing, rescheduling…). Placeholders such as `{firstName}`,
`{stylist}`, `{service}`, `{date}`, `{time}`, `{bookingUrl}` and `{reviewUrl}` are filled in automatically.
Administrators write and tag them in **Settings → Saved replies**. A starter set is included.

**Consent:** only text clients who have agreed to receive texts (e.g. opted in when booking).

---

## 5. Connect GoHighLevel

Optional. HighLevel receives follow-ups as **tasks on the matching contact**. If HighLevel is down,
follow-ups keep working here and are retried automatically.

1. In the HighLevel **sub-account** for the salon: **Settings → Private Integrations → Create new integration**.
2. Name it "Addendum Salon CRM" and grant these scopes:
   `contacts.readonly`, `contacts.write`, `users.readonly`, `locations.readonly`.
3. Copy the token → `HIGHLEVEL_PRIVATE_TOKEN`.
4. Copy the **Location ID** (Settings → Business Profile, or the `/location/<ID>/` part of the URL) → `HIGHLEVEL_LOCATION_ID`.
5. Restart, then **Settings → GoHighLevel → Test connection**.
6. Match each team member to their HighLevel user, pick a **default assignee**, and choose which
   events create tasks automatically.

Endpoints used, verified against HighLevel's official OpenAPI spec (GitHub `GoHighLevel/highlevel-api-docs`):

| Purpose | Endpoint |
|---|---|
| Match contact by phone, then email | `GET /contacts/search/duplicate?locationId=&number=` / `&email=` |
| Check a stored contact ID | `GET /contacts/{contactId}` |
| Create contact (only if none matched) | `POST /contacts/` |
| Create task | `POST /contacts/{contactId}/tasks` — `title`, `body`, `dueDate`, `completed`, `assignedTo` |
| Mark task complete | `PUT /contacts/{contactId}/tasks/{taskId}/completed` |
| List users (for staff mapping) | `GET /locations/{id}` → `GET /users/search?companyId=&locationId=` |

All calls send `Version: 2021-07-28`. HighLevel's newer docs label the same endpoints `Version: v3`
with identical payloads. Set `HIGHLEVEL_API_VERSION=v3` if HighLevel asks you to.

HighLevel tasks have **no priority or time-of-day field**. The app puts the priority in the title
(`[High] Follow up with …`) and the due time in `dueDate`. Phone, email, appointment details, notes
and a link back to the follow-up go in the task body. The HighLevel contact ID and task ID are
stored, so pushing twice never creates a duplicate.

---

## 6. Turn on AI drafting (optional)

Without a key, drafts come from built-in salon templates (they work well). For drafts written by
Claude, set:

```
ANTHROPIC_API_KEY=sk-ant-…
AI_MODEL=claude-haiku-5-5      # fast and inexpensive; any current Claude model works
```

By default: **AI drafts → staff review → staff sends.** Nothing sends on its own unless the owner
turns on *Settings → AI → Let AI send without review*. Even then it only answers new lead
inquiries, once per conversation per 12 hours, never during quiet hours. Appointment reminders
and review requests have their own separate "send automatically" switches, also off by default.

---

## 7. Email, Order Hair & Shopify

Stylists use **Order Hair** in the menu to order from Addendum Hair. **Shopify is the source of truth for hair
inventory.** The order form has the stylist (unchanged), a required **Needed By** date (not in the past), hair items
searched in Shopify by **SKU** or name (or chosen from the list) with length/colour/SKU shown, a quantity per item up to
what's in stock, **Add another item / Remove**, optional **order notes**, and **Submit order**.

On submit the server, in order: checks every quantity against Shopify stock → records the order → takes the chosen items
out of Shopify stock in one all-or-nothing update (refused if stock changed since it was read, so nothing is oversold;
an idempotency key makes a double-click or retry count once) → emails **gaby@addendumhair.com** with
**info@addendumhair.com** (and the stylist) copied: reference number, stylist and email, Needed By, every item with its
variant/SKU and quantity, and the notes. Success is shown only after the order is recorded and the stock handled.
- Not enough stock, an unknown SKU, or a missing/past date: a clear message, and nothing is recorded or deducted.
- Shopify doesn't answer: the order shows **Not finished — Shopify didn't confirm**; pressing Submit again finishes it
  without deducting twice.
- Email fails: the order and stock change stand; the email is retried automatically (never re-deducting).
- Items **typed by hand** (not in Shopify) are emailed but don't touch inventory.
- Products paired in **Inventory Sync** pass the Shopify deduction on to Square at the next sync (the two-way sync
  combines changes). Turn **Sync to Shopify** off for a product to keep Square's count separate.
- Cancelling an order doesn't put stock back automatically — adjust it in Shopify if the hair isn't sent.

Orders are tracked Requested → Ordered → Received. Owners and managers see everyone's requests and update their status.
Staff see their own.

To send real email, add any SMTP account on the server and restart:

```
SMTP_HOST=smtp.gmail.com             # Google Workspace; or smtp.office365.com, smtp.postmarkapp.com…
SMTP_PORT=587
SMTP_USER=orders@addendumsalon.com
SMTP_PASS=<app password>             # Google: myaccount.google.com → Security → App passwords
EMAIL_FROM="Addendum Salon <orders@addendumsalon.com>"
```

- Until email is set up, requests are **saved** (marked "email isn't set up yet") and go out automatically once it is.
- If a send fails, the request is kept and **retried automatically** (2, 4, 8… minutes, up to 8 tries). Anyone can press **Send email now**.
- The stylist is CC'd and set as reply-to, so Gaby can reply straight to them (toggle in Settings).
- Add your usual collections under Settings → Order Hair → *Quick-pick collections* for one-tap entry. Anything ordered before is suggested automatically too.
- The same email setup also powers the optional email alerts in Settings → Notifications.

**Deliverability tip:** send from an address on your own domain, and make sure that domain's SPF/DKIM
records include your email provider (your provider's setup guide covers this), so requests don't land in spam.

### Square inventory (search) and the admin Shopify push

**Inventory Sync → Square inventory** lists retail products from Square, the source of truth for stock.
You can search by product name, size/colour, SKU or barcode, and filter to in-stock items.
It refreshes with every Square sync (every 15 minutes), or straight away with **Refresh from Square**.
(Order Hair itself orders from Shopify inventory — see above.)

- Reading stock needs Square's `INVENTORY_READ` permission. An access token (`SQUARE_ACCESS_TOKEN`) normally has it.
  If you connected Square with **Connect Square** before this change, reconnect once to grant it.
- **Administrators only:** tick products and press **Push to Shopify**. Shopify's *available* stock at one
  location is **set to Square's count**, matched by **SKU**. Products without a SKU, with no matching Shopify
  SKU, or with a SKU used by several Shopify products are skipped and listed. Pushing twice sets the same numbers,
  so nothing is double-counted. Receptionists and stylists can search but can't push.
- This manual push never runs automatically. For automatic two-way stock sync, see **Inventory Sync** below.

Setup: in Shopify, create an app in the **Dev Dashboard** with the Admin API scopes
`read_products, read_inventory, write_inventory, read_locations`, install it on the store, then set:

```
SHOPIFY_STORE_DOMAIN=your-store.myshopify.com
SHOPIFY_CLIENT_ID=…
SHOPIFY_CLIENT_SECRET=…
# Older custom apps made before 2026 can use their token instead: SHOPIFY_ADMIN_TOKEN=shpat_…
# Only if the store has several active locations: SHOPIFY_LOCATION_ID=…
```

(Or enter them in **Settings → API & Integrations** instead of the `.env` file, then press Test connection.)

### Inventory Sync (Square ↔ Shopify)

**Inventory Sync** in the menu (administrators) keeps product stock the same in Square and Shopify, both ways.
Only products and quantities — never customers, appointments, services or bookings.

- **All linked → search by name or SKU → Edit** changes a paired product's SKU and/or stock count in both Square and
  Shopify at once (the count becomes the agreed baseline, so the next sync has nothing to do).
- Products are paired by **SKU** (or linked by hand with *Link by SKU*). Nothing is ever created in either system;
  products found in only one are listed under *Not matched*. Duplicate SKUs are skipped so nothing is overwritten.
- **How conflicts are handled** (shown on the page): after the first pairing, changes made on either side since the
  last sync are combined (a sale in each system both count). The first time a product is paired, Square's count is
  kept (changeable). Results below zero, or unusually large jumps, are held under *Needs attention* with
  **Use Square / Use Shopify** buttons.
- Shopify is updated with a compare-and-set, so a sale that happens mid-sync is never overwritten — it's picked up next
  time. Square is updated with timestamped counts and idempotency keys, so retries never double-count. Only one sync
  runs at a time.
- **Sync Inventory** runs it now with live progress; turn on **Sync automatically** for a schedule (plus a sync shortly
  after Square reports a stock change). Failed items show the reason and **Retry failed**.
- Needs Square `INVENTORY_READ` + `INVENTORY_WRITE` (+ `ITEMS_WRITE` for “Use Shopify SKU in Square” and for editing a SKU) and Shopify `read_products, read_inventory, write_inventory,
  read_locations`. If either isn't connected, the page says exactly what's missing. If Square has more than one
  location, set *Inventory location ID* on the Square card.

### Rebooking schedules

- **Settings → Rebooking by service**: default for each service — earliest / preferred / latest interval, how many days
  before the recommended date the follow-up appears, and automatic follow-ups on/off. Starting defaults:
  Extension Move-Up 6–8 weeks (aim 7), haircuts about 8 weeks. Services without a default use each client's own visit
  history (when there's enough).
- **Client profile → Rebooking schedule**: one row per service with last visit, recommended date, follow-up date and
  status, marked *Custom* or *Service default*. **Adjust** sets that client's own interval, a preferred next date,
  a last visit that isn't in Square, their reminder timing, or turns follow-ups off — for that client only.
- **Follow-Ups**: rebooking follow-ups show the service, last visit and recommended date, with **Not needed** (this
  cycle) and **Adjust rebooking schedule**. *Rebooking schedule* lists everyone's upcoming recommended dates.
  There's at most one follow-up per client, service and visit; a new booking or visit closes it and recalculates.

### Commission (My Commission)

Square doesn't calculate commission through its API, so the CRM calculates it from verified Square sales and the
plan you set in **Settings → Commission**:

1. Make sure Square has `ORDERS_READ` and `PAYMENTS_READ` (reconnect once if needed), and that each stylist's account
   is linked to their Square team member: Users & Permissions → Edit details → *Square team member* lists Square's
   team by name. Linking matches by email or name automatically on sync; when it doesn't, the sync adds a placeholder
   record (no sign-in) — choosing that team member for the real account moves the link over.
2. Turn commission on, choose the rules (before/after discounts, refunds, packages, split services, retail and tips),
   and add **rates**: everyone or one stylist; services or retail; all items or a specific service/product;
   percentage, flat per item, or tiered by monthly/weekly sales; with a start date. **Edit** changes a rate in place;
   a rate already used for finalized commission is changed from a date instead (the old one ends and stays in the
   history). The *Note shown on My Commission* (an "estimates only" disclaimer by default) is edited here too.
3. **Team Commission → Sync from Square** (or let it sync automatically).

- Who did the work comes from the matching Square booking (same customer, same day, same service); retail and tips
  follow your rules. Anything that can't be matched reliably goes to **Needs review** instead of being guessed.
- Each stylist sees **My Commission** for any date range: services and retail separately, tips separately, refunds and
  adjustments, estimated vs finalized, total sales, and every transaction with *How this was worked out*.
  Stylists only ever see their own; team reports need *View team commission*.
- **Wages & tips** (Users & Permissions → a person): hourly rate or salary (per week, 2 weeks, half-month, month or
  year), and *Tip eligible*. Tips on a non-eligible person's work go to **Needs review** to be credited by hand. Hours
  come from closed Square timecards on each sync (needs `TIMECARDS_READ`; unpaid breaks are taken off) plus hours
  entered by hand. Team Commission shows hours, wages (hourly = hours × rate; salary prorated by days in the range)
  and total pay; **Pay summary (CSV)** has one row per person with service and retail commission apart, tips, hours
  and wages.
- **Pay schedule** (Settings → Commission): every week, 2 weeks, twice a month or monthly, from one known period (default
  every 2 weeks from Sep 26 – Oct 9, 2026, paid 7 days later on Oct 16). My Commission and Team Commission open on the
  current pay period, with *This / Last pay period* buttons. Both show **Commission** (hours worked and estimated wages),
  **Taxes** (estimated withholding and net pay) and **Year** (one line per pay period paid that year) tabs.
- **Wage history**: changing a wage asks when it starts; hours before that date stay at the earlier wage, and each
  wage pays the hours worked while it applied. Past wages can be corrected or removed under *Wage history*.
- **Team Commission → Payroll hours**: a weekly timesheet (Mon–Sun) per person. Type hours not clocked in Square into
  each day (saved when you leave the box); Square timecard hours show beside them and both count.
- **Taxes (estimates only)**: per person in Wages & tips — W-2 or 1099, federal/state/local withholding %, and W-4
  details (filing status, multiple jobs, dependents, other income, deductions, extra withholding). Salon rates (Social
  Security, Medicare, FUTA, SUTA) are in Settings → Commission. A stylist's Team Commission page and the Pay summary CSV
  show estimated withholding, net pay and employer taxes (no wage-base caps). No SSNs or bank details are stored — the
  payroll provider does the real withholding.
- **Pay periods → Finalize** locks a date range. Finalized amounts never change; later refunds are counted on the day
  they happen. **Export for payroll (CSV)** includes the rate and calculation of every record.

---

## 8. Colours

**Settings → Brand & appearance** (administrators):
- **Logo**: upload a PNG, JPG or WebP (up to 400 KB). Choose logo and name, logo only or name only for the header, and
  optionally use the logo as the browser tab / home-screen icon. Shown on the sign-in screen too.
- **Name and tagline** shown in the sidebar and phone header.
- **Accent colour** (preset or any custom colour): highlights, badges, switches and buttons. Colours too light for white
  text are automatically deepened so buttons stay readable.
- **Background** (warm, white, cool or tinted with the accent), **sidebar** (soft grey, white or accent tint) and
  **fonts**: built-in serif or sans-serif headings, or upload your own brand fonts for headings and/or body text
  (WOFF2, WOFF, TTF or OTF up to 1.5 MB; check your font licence allows web use). Changes preview live and apply to
  everyone when saved; uploads take effect straight away.
- **Stylist colours** (owner/manager): each stylist's colour on the appointment calendar. Saved as soon as you pick one.

---

## 9. Embed on the Addendum Salon website

Put the app on a **private, password-protected staff page** of the website (not a public page):

```html
<div id="addendum-crm"></div>
<script src="https://addendumsalon.info/embed.js" data-offset="80" async></script>
```

- `data-offset` — height in pixels of the site's own header, so the app fills the rest of the screen.
- `data-path="/follow-ups"` — open a specific page first. `data-height="900px"` — fixed height.

Then allow the website to frame the app by setting this on the server:

```
ALLOWED_EMBED_ORIGINS=https://addendumsalon.com,https://www.addendumsalon.com
COOKIE_SECURE=true
```

How it stays safe and unbreakable:
- The app runs in an **iframe**, so the website's CSS and scripts can't affect it and vice versa.
- Only origins in `ALLOWED_EMBED_ORIGINS` can frame it (CSP `frame-ancestors`). Every other site is refused.
- It works on phones (full-height, safe-area aware) and includes an "Open in a new tab" link.

**Square Online / Wix / Squarespace / WordPress:** add an "Embed code" / "Custom HTML" block
with the snippet. If the builder strips `<script>` tags, use a plain iframe instead:

```html
<iframe src="https://addendumsalon.info/" title="Addendum Salon"
        style="width:100%;height:calc(100dvh - 80px);min-height:560px;border:0"></iframe>
```

**Different-site note:** the CRM (`addendumsalon.info`) and the salon website (`addendumsalon.com`) are
different sites. So browsers treat the CRM's sign-in cookie inside the website's iframe as third-party.
Safari always blocks it, and Chrome blocks it for people who've turned off third-party cookies. In those
browsers the embedded login screen says sign-in is blocked and offers **Open the app in its own tab**, which
always works. For a dependable experience, link staff to `https://addendumsalon.info` (or add it to their home
screen) rather than relying on the embed. **Connect Square** always opens
Square's sign-in in a new tab, because Square's page can't load inside an iframe.

Staff can also add the app straight to their phone's home screen from `https://addendumsalon.info`.

---

## 10. Go-live checklist

- [ ] `DEMO_MODE=false`, `NODE_ENV=production`, HTTPS on, `COOKIE_SECURE=true`
- [ ] Strong `OWNER_PASSWORD` and `ENCRYPTION_KEY`; change the owner password after first sign-in
- [ ] Postgres backups on
- [ ] Square connected, history imported, webhooks subscribed (Settings shows *Live updates: Webhooks on*)
- [ ] Each front-desk Mac: Messages signed in, Text Message Forwarding on, a test **Text** opens Messages
- [ ] HighLevel test connection passes; staff mapped; default assignee set
- [ ] Salon details: booking link and review link filled in
- [ ] Follow-up rules and reminder timing reviewed
- [ ] Team logins added with the users tool (§2); each person signs in once
- [ ] Email (SMTP) set up and a test inventory request reaches gaby@addendumhair.com
- [ ] Embed tested on desktop and a phone (Safari + Chrome)
