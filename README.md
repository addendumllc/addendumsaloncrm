# Addendum Salon — Command Center

An internal CRM for Addendum Salon that answers one question first thing every morning:
**“Who do I need to follow up with today?”**

It reads real appointments from **Square**, opens texts in **Apple Messages** with the number and a draft filled in, turns
cancellations, no-shows, new leads, overdue rebookings and unanswered texts into a prioritised
follow-up list, drafts replies with **AI** (staff always approve by default), and pushes
follow-ups into **GoHighLevel** as tasks. Stylists can also send **Addendum Hair inventory order
requests**, which are emailed to gaby@addendumhair.com and tracked until received.

Everything works in **Demo Mode** with no credentials at all.

---

## Run it on your computer

**Easiest:** install [Node.js](https://nodejs.org) (LTS, version 20 or newer) once, then double-click:

- **Mac:** `Start CRM (Mac).command`. The first time, macOS may say it's from an unidentified developer: right-click it → **Open** → **Open**.
- **Windows:** `Start CRM (Windows).bat`

The first run installs everything (a minute or two). Then the app opens in a **new Chrome window** at
http://localhost:5173. Keep the black Terminal/Command window open while you work; close it to stop the app.

**From a terminal (e.g. VS Code):**

```bash
npm install        # first time only
npm run dev        # starts the app with live reload and opens a new Chrome window
```

- Edits to the code show up in the browser immediately.
- `npm run app` runs the production build at http://localhost:4000 (also opens Chrome).
- `npm run dev:nobrowser` starts without opening a window.

Your local data is kept in `server/data/`. Delete that folder to start over with fresh demo data.

Sign in with **owner@addendumsalon.com / addendum-demo**.

The demo database starts with a simulated Square account: 30+ clients, 13 leads, 140+ appointments over the past year
(completed, cancelled, no-shows, rescheduled), text conversations, follow-ups and HighLevel tasks.
Every screen is labelled **Demo Mode**.

**Settings → Demo tools** plays the part of Square, a client's phone and HighLevel, so you can
watch the app react:

| Try this | What happens |
|---|---|
| *Act as Square → Client cancels* | Detected like a `booking.updated` webhook → cancellation follow-up appears |
| *A client books online* | Their open cancellation / rebook follow-ups close themselves |
| *Messages → Simulate* | An incoming text arrives, the client or lead is identified, service + timeframe detected → **Generate reply** → you edit → **Send** |
| *Simulate a HighLevel outage* → **Push to HighLevel** | Follow-up is kept, shows “could not be created — it will be retried”, retries when HighLevel is back |
| *Inventory → New order request* | Request is saved and the email to gaby@addendumhair.com is rendered (simulated, viewable on the request) |

---

## What's in the box

| Area | Highlights |
|---|---|
| **Today's Priorities** | 8 clickable counts + a ranked list of recommended actions, each with its own button |
| **Follow-Ups** | Today's queue grouped 🔴 High / 🟡 Medium / 🟢 Low with Text · Call · Book · Push to HighLevel · Complete · Snooze · Reschedule |
| **Appointments** | Square calendar — day (by stylist), week, month, list; colour-coded confirmed / completed / cancelled / no-show / needs attention. Click → client profile |
| **Clients** | Profiles with Square history timeline, messages, follow-ups, internal notes, tags, preferred stylist, rebooking rhythm |
| **Leads** | Drag-and-drop pipeline (New → … → Won/Lost) and list view; texts from unknown numbers become leads automatically |
| **Messages** | Texts open in Apple Messages with the number and message filled in; history is logged in the CRM. AI drafts, or **Saved replies** suggested for the situation (new lead, pricing, rebooking, no-show…) |
| **Saved replies** | Write your own texts in Settings → Saved replies, tag the situations they're for, use placeholders like {firstName} and {bookingUrl} |
| **Rebooking schedules** | Defaults per service (e.g. move-ups 6–8 weeks, aim 7) and custom schedules per client and service; one follow-up per client, service and visit, recalculated after each booking |
| **Automation** | Configurable timing for every rule; reminders at any offsets; review requests; HighLevel auto-push per event (ON/OFF) |
| **Analytics** | Leads, conversion, cancellations, no-shows, rebooking rate, popular services, new vs returning, booked value |
| **Inventory orders** | Stylists request Addendum Hair products (shade, length, qty, rush, needed-by); emailed to gaby@addendumhair.com; tracked Requested → Ordered → Received; auto-retry if email fails |
| **Colours** | Choose the app's accent colour and each stylist's calendar colour (Settings → Appearance & colours) |
| **Users & permissions** | Admin, Reception, Stylist and Assistant (default for new accounts) templates, plus per-person Allow/Deny overrides with a preview, all enforced on the server |
| **API & Integrations** | Admin page to enter, test and remove keys for Square, Shopify, HighLevel, email and AI — encrypted on the server, never shown again |
| **Inventory Sync** | Two-way Square ↔ Shopify stock sync by SKU, manual or automatic, with progress, conflict rules, review and retry |
| **My Commission** | Each stylist's own commission by date from Square sales: services, retail, tips, refunds, estimated vs finalized; admin rates, review, pay periods and payroll CSV |
| **Privacy** | Full export, per-client export / archive / delete, privacy-conscious activity log |
| **Embed** | One script tag on the salon website; the app's CSS is fully isolated in an iframe |

---

## Documentation

- **[docs/SETUP.md](docs/SETUP.md)** — deploy, users & permissions, API keys, Square, HighLevel, Shopify, inventory sync, rebooking, commission, AI and email; texting via Apple Messages; colours; embed on the website
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — how it's built, data model, verified API endpoints, security, and what was added beyond the brief
- **[.env.example](.env.example)** — every setting, with where real credentials go

## Tests

```bash
npm test          # 135 tests against a real (embedded) Postgres
npm run typecheck
```

Covers the 7 required workflows (Square import, cancellation, lead, SMS + AI draft, HighLevel push,
HighLevel failure + retry, smart rebooking) plus security, auto-send rules, templates, inventory requests + email retry,
credentials, inventory sync, rebooking schedules, commission, and roles & permissions (allowed, denied and bypass attempts).
# addendumsaloncrm
