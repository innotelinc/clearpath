# Clearpath

[![CI](https://github.com/innotelinc/clearpath/actions/workflows/ci.yml/badge.svg)](https://github.com/innotelinc/clearpath/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)


The credit repair operating system behind **Denovo Credit** — a multi-tenant workspace for agencies, a white-labelled client portal, and a certified mailroom that turns approved disputes into printed, tracked packets.

- **Marketing site** at `/` (Denovo Credit · denovocredit.com)
- **Agency workspace** at `/app` — clients, disputes, mailroom, documents, audit log, settings
- **Client portal** at `/portal` — scores, dispute status, uploads, messages
- **Server-rendered** with Express + EJS, SQLite, and a dependency-free browser script
- **Runs as a container** with a persistent volume for the database and uploads

Continuing this project elsewhere? [HANDOFF.md](HANDOFF.md) records the current state, decisions, schema changes and open work.

---

## Why Clearpath

| Problem | Answer |
| --- | --- |
| Disputes, documents and letters live in spreadsheets and inboxes. | One workspace per agency, with every client, dispute and document in one place. |
| Clients phone for a status they cannot see. | A white-labelled portal showing scores, dispute status, uploads and messages. |
| Mailing a dispute packet is manual and untracked. | A certified mailroom that produces the packet, the tracking and the record. |
| Two agencies should never share a database. | Every row carries its agency; the workspace and the portal are scoped to it. |

Its place in the stack is [docs/stack.md](docs/stack.md); the canonical
definition of the shared layers is the
[Innotel Platform Stack](https://github.com/innotelinc/innotel-platform-stack).

## Quick start

```bash
git clone <repo> clearpath && cd clearpath
npm install
npm start            # http://localhost:3000 — seeds demo data on first boot
```

Requires **Node 22.5+** (uses the built-in `node:sqlite` module — no native build step).

```bash
npm run dev          # restart on change
npm test             # 45 end-to-end tests against spawned servers
npm run seed         # seed an empty database, or inspect what exists
npm run seed -- --reset   # wipe local data and reseed (refuses in production)
npm run reseed -- --confirm RESEED   # rebuild the demo data, files and evidence links
npm run credentials  # print every account in this database with its demo password and URL
```

### Demo accounts

| Workspace | Role | Email | Password |
| --- | --- | --- | --- |
| Denovo Credit | Owner | `dana@denovocredit.com` | `Denovo!2026` |
| Denovo Credit | Specialist | `marcus@denovocredit.com` | `Specialist!2026` |
| Denovo Credit | Client (portal) | `amara@example.com` | `Client!2026` |
| Northstar Credit Group | Owner | `owner@northstar.test` | `Northstar!2026` |
| Platform (operator console) | Operator | `platform@clearpath.test` | `Platform!2026` |

**Platform operator sign-in:** <http://localhost:3000/platform/login> —
`platform@clearpath.test` / `Platform!2026`. That account exists only while the database is
seeded with `SEED_DEMO` on and no real operator is configured. Set `PLATFORM_ADMIN_EMAIL` and
`PLATFORM_ADMIN_PASSWORD` (created on boot, never overwritten) for a deployment, or delete the
demo row with `SEED_DEMO=0`, and the demo card disappears from `/platform/login`.

The operator is not a workspace user: `/platform` has its own account table and its own cookie,
so signing in there does not sign you into an agency, and a suspended workspace cannot lock the
operator out. Everything else on this page — billing, mailroom, pipeline — lives in the
workspace you land on after signing in at `/login`.

The login page shows these only while `SEED_DEMO` is not `0`. Set `SEED_DEMO=0` in production and the cards disappear.

`npm run credentials` prints the same list from the database actually in use — every workspace, its
site URL, and each seat's email with the demo password that verifies against its stored hash (a
password changed since the seed shows as `(changed)`). `npm run credentials -- --site` prints only
the workspace URLs.

Northstar is a second tenant used to demonstrate isolation. Requests are routed to a workspace by the `Host` header: `northstar.clearpath.test` (or whatever you set as its domain in Settings) resolves to Northstar, everything else falls back to the first workspace. Every query is additionally scoped by the signed-in user's `tenant_id`, so a host header alone cannot expose another agency's records.

---

## Platform console

The operator layer above the tenants lives at `/platform` — a separate mount, a separate account table (`platform_admins`), and a separate session cookie. An operator is not a tenant user, so suspending a workspace can never lock the operator out.

| Capability | Where |
| --- | --- |
| Tenant list with live usage | `/platform` — clients, staff seats, portal accounts, open disputes, documents, packages, last activity |
| Create tenant + first owner invite | `/platform/tenants/new` — creates the workspace and queues the owner invitation together |
| Suspend / reactivate | On the tenant page. Suspension deletes every session in that workspace and returns `403` on agency and portal sign-in until reactivated; data is untouched and the action lands in the tenant's audit chain |
| Drill-down to clients | `/platform/tenants/:id` — team and client roster with case state, never dispute letters or documents |
| Invite another owner | On the tenant page, through the same invitation pipeline as a workspace invite |
| Plan and payment status | Tenant list and tenant page, plus **Payments** (`/platform/billing`) to store the Stripe keys and check the connection |

Bootstrap the first operator with `PLATFORM_ADMIN_EMAIL` and `PLATFORM_ADMIN_PASSWORD` (created on boot, password never overwritten). With `SEED_DEMO` left on and no operator configured, a demo operator is seeded at `platform@clearpath.test` / `Platform!2026` and listed on `/platform/login`.

---

## Automated dispute pipeline

`/app/pipeline` runs the drafting step for a whole workspace and leaves two decisions to a person:

1. **Scan** every tradeline. Items already in flight — an open dispute or an unapproved draft — are skipped.
2. **Cleared to draft**: evidence strength at or above 75%, at least one supporting document, a client past onboarding, and a dispute basis long enough to cite. The pipeline drafts one letter per item with the deterministic drafter and parks it as `Ready`.
3. **Needs a human**: everything else, with the reason attached — thin evidence, no supporting document, onboarding gaps, a balance with no open date, or a basis too thin to cite. Fix the file, run it again.
4. **Approve & queue batch** turns waiting letters into disputes and one certified-mail package per client and bureau, exactly like the manual mailroom flow.

The only remaining human steps are reviewing the exception queue and approving a batch. Nothing is ever mailed automatically.

---

## AI through OmniRoute

OmniRoute is the only AI gateway this app talks to: one API key, no provider list, no fallback gateway. It is OpenAI-compatible, so `server/ai.js` is a single `POST /chat/completions`.

| Setting | Required | Default |
| --- | --- | --- |
| `OMNIROUTE_API_KEY` | yes, to enable AI | — |
| `OMNIROUTE_BASE_URL` | no | `http://localhost:20128/v1` |
| `OMNIROUTE_MODEL` | no | `auto` (OmniRoute routes) |

Two surfaces use it, both advisory and both recorded with the model that produced them:

- **Drafting studio → Rewrite with AI**: sends the current letter plus its case facts to the gateway and replaces the body. The prompt forbids inventing facts, dates, balances or citations; the approved text is whatever is in the editor afterwards.
- **Client file → Summarise case with AI**: a short summary plus up to three dispute theories grounded in the JSON case file, shown on the client page (`case_insights`).

With no key, both surfaces say what to set and everything else keeps working — drafting, the pipeline, the mailroom and the portal never require a model. Note that AI actions send client case data to the configured gateway; run OmniRoute somewhere you trust.

---

## Print and mail through Lob

Certified letters can be printed, posted and tracked by Lob instead of being handed over by hand. Nothing changes until a key is set: without `LOB_API_KEY` every Lob button and column stays hidden and the mailroom keeps its print-and-post workflow.

| Setting | Required | Purpose |
| --- | --- | --- |
| `LOB_API_KEY` | yes, to enable | `test_…` sends test letters (no tracking events, no postage), `live_…` posts real certified mail |
| `LOB_WEBHOOK_SECRET` | recommended | Verifies the signature on delivery events; unset means `/webhooks/lob` accepts unsigned posts |
| `LOB_BASE_URL` | no | Defaults to `https://api.lob.com/v1` |

How it behaves:

- **Send through Lob** on a ready package creates one certified First Class letter per dispute, using the bureau's address as the recipient and the agency's Settings address as the return address. Both must parse into street, city, state and ZIP or the send is refused with the reason.
- Every response is stored in `mail_dispatches` (provider letter id, tracking number, expected delivery), the package moves to **In transit**, the disputes move to **Mailed**, and the exact letter bodies are snapshotted — so what was sent stays readable after a template changes.
- The package page links the tracking number to the carrier and lists each delivery event.
- `/webhooks/lob` is mounted before the session and CSRF pipeline because provider callbacks arrive unauthenticated. It verifies the signature when `LOB_WEBHOOK_SECRET` is set, records each event once, and moves the package through `mailed → in transit → delivered` (or `returned`).
- A failing letter in a batch does not stop the rest: the ones that were accepted are recorded, the failures are reported in the flash notice, and the package keeps the tracking number of the first accepted letter.

---

## Billing

Owners subscribe from **Workspace → Billing** (`/app/billing`). Three monthly plans are defined in
`server/billing.js` and sent to Stripe as inline price data, so there are no dashboard products or
price ids to create:

| Plan | Price | Clients | Staff seats |
| --- | --- | --- | --- |
| Starter | $149 / month | 50 | 2 |
| Growth | $399 / month | 250 | 6 |
| Scale | $799 / month | unlimited | unlimited |

How the flow works:

- **Choose plan** creates a Stripe Checkout Session (`mode=subscription`) and redirects to Stripe. The card never touches this app.
- Coming back with `?checkout=success&session_id=…` makes the server fetch that session from Stripe and sync the subscription — so billing works on a laptop with no public webhook URL.
- `POST /webhooks/stripe` is the source of truth afterwards: `checkout.session.completed`, `customer.subscription.created|updated|deleted`, `invoice.paid` and `invoice.payment_failed` move `tenants.plan_status` between `active`, `trialing`, `past_due`, `unpaid`, `canceled` and the rest. Every event id is stored once in `billing_events`, so a Stripe retry cannot apply the same change twice.
- The signature is **mandatory**: with no `STRIPE_WEBHOOK_SECRET` the endpoint answers `503` instead of trusting unsigned posts that claim a workspace is paid up.
- **Changing plan** updates the subscription the workspace already has (a new `Price`, then `items[0][price]` on that subscription with `proration_behavior=create_prorations`) instead of opening a second Checkout — one subscription per workspace, never two invoices for the same month.
- **Manage payment** opens the Stripe billing portal for invoices, card changes and cancellation. Cancelling there keeps access until the paid period ends; the workspace page then shows the cancellation date.
- A failing payment does not lock a workspace out. The owner sees a banner on the billing page, the operator sees the status in the console, and Stripe keeps retrying.

### Stripe keys

Two places can hold the key, and the console wins:

| Where | Set it | Notes |
| --- | --- | --- |
| Platform console | **Payments** (`/platform/billing`) | Stored in `platform_settings`, applied immediately, shown only as `sk_live_…abcd`. **Check connection** calls Stripe's read-only `/v1/balance` and reports the mode and round trip — the fastest way to tell a bad key from a bad webhook |
| Environment | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Read on boot; used when nothing is stored in the console |

Keys are validated on save (`sk_`/`rk_` + `live`/`test`, `whsec_`), so a pasted fragment is rejected
instead of failing every checkout later. Add the webhook endpoint in Stripe → Developers →
Webhooks pointing at `<APP_ORIGIN>/webhooks/stripe` with the six events above, then paste that
endpoint's signing secret into the console.

`STRIPE_BASE_URL` exists for tests and a Stripe-compatible mock. A live key in a deployment is a
real payment credential: the database holds it, so treat `DATA_DIR` and its backups as secret
material alongside the reset links already stored there.

---

## What it does

### Agency workspace

| Area | Capability |
| --- | --- |
| Overview | KPIs, open dispute pipeline, ready-to-mail packages, documents awaiting review, stage mix, hash-chained activity feed |
| Clients | Search, stage filter, new-client intake, per-client case file with tradelines, disputes, documents, requests, messages and notes |
| Disputes | Draft from a tradeline (bureau, account, theory, evidence strength), generate a letter with FCRA citations, track round, status, mailing date and response deadline |
| Drafting studio | Pick a tradeline and a legal basis (§611 reinvestigation, §623 direct dispute, §605 obsolescence, Regulation V), review the evidence signals and confidence, edit the letter, then approve it into a dispute |
| Billing | Three monthly plans, Stripe Checkout, the billing portal for cards and invoices, live subscription status and a history of what Stripe reported. Owner only |
| Mailroom | Select approved letters, group one package per client + bureau, price certified/priority/standard postage, print labels and a letter manifest, record tracking, start the 30-day clock — or hand the package to Lob and let it print, post and report delivery. Opening a package shows exactly what was sent — the letter text is frozen at mailing time — and the tracking number links straight to the carrier |
| Documents | Upload with signature verification and SHA-256 hashing, verify, download, request documents from a client, see what is outstanding. A document that names a disputed creditor attaches itself to that dispute; attachments can be added or removed from the dispute page |
| Mail log | Owner-only: every invitation and reset email this workspace produced, delivery status, provider errors, manual retry |
| Audit | Append-only SHA-256 chained log, chain verification, CSV export |
| Settings | Branding (name, monogram, accent, tagline, support details, portal name, domain, welcome copy), team invites and password resets, own password change, mail transport status |

### Client portal

Three bureau scores with movement since intake, utilization, open and closed disputes in plain language, document requests with one-tap upload, the document vault, a message thread with the specialist, and a score-history page. Everything is scoped to the signed-in client's own record.

### Accounts, invitations and password recovery

- Inviting a client or a teammate creates the account, generates a temporary password and **emails the sign-in details automatically**. The temporary password is shown once in the UI only when no mail provider is configured, so the workspace still works offline.
- The first sign-in with a temporary password is forced through `/change-password` before the workspace or portal opens. Changing a password keeps the current session and drops every other one.
- **Forgot password** at `/forgot` emails a single-use link: 60-minute expiry, hashed at rest, invalidated when a new one is issued, and consumed on use — after which every existing session for that account is deleted.
- Owners can email a fresh reset link from a client's file or from Settings → Team, without ever seeing the new password.
- Requests are rate limited per address (five per 15 minutes) and the response never reveals whether an address exists.

### Email delivery

The app writes every message to an `emails` outbox first, then hands it to the configured provider. With no provider configured nothing is delivered — the message stays in the Mail log (`/app/mail-log`) with its full body, which keeps demos and air-gapped installs coherent. Supported transports are an SMTP submission server (Stalwart, Postfix, Mailcow — `server/mail.js` via nodemailer) and Resend, Postmark and SendGrid over HTTPS. Failures retry automatically four times with a one-minute floor, then stay in the log for a manual retry.

#### Sending through Stalwart

Stalwart is a mail server, so delivery goes out over SMTP submission rather than a REST API. Configuration is environment-only, and the sender address must belong to the authenticated account:

| Variable | Example | Notes |
| --- | --- | --- |
| `MAIL_TRANSPORT` | `smtp` | `stalwart` is accepted too. Without it, a set `SMTP_HOST` wins over the HTTPS providers |
| `SMTP_HOST` | `mail.denovocredit.com` | Hostname on the TLS certificate, not an IP |
| `SMTP_PORT` | `465` with `SMTP_SECURE=1`, or `587` | 465 is implicit TLS; 587 upgrades with STARTTLS (the default) |
| `SMTP_USER` / `SMTP_PASS` | `clearpath@denovocredit.com` / application password | A dedicated mailbox, not an administrator login |
| `MAIL_FROM` | `Clearpath <clearpath@denovocredit.com>` | Must be the account or one of its addresses — `mustMatchSender` is on by default |

In Stalwart, check that an SMTP listener is reachable on the chosen port (**Settings → Network → Listeners**, with `tlsImplicit` for 465), and publish SPF and DKIM for the sending domain — without them Stalwart delivers, but recipients score the mail as unauthenticated. Authentication failures are logged and the session is dropped after three bad attempts. `SMTP_STARTTLS=0` turns the upgrade off and belongs only on a trusted local relay: the password crosses the wire in the clear.

### Drafting studio

The studio is built in, not bolted on and not dependent on an API key. Letters are assembled by fixed rules from the tradeline, the evidence list, prior rounds and the bureau file: same input, same letter, no per-letter cost, and every sentence traceable to a field. The confidence figure is evidence strength, not a prediction of the outcome; the draft lists what the file supports and what is still thin. A specialist edits and approves it, which creates a normal dispute whose PDF uses the edited text. Drafting itself never calls a model; the optional rewrite and case-summary actions are the only AI surfaces, and they are additive.

### PDFs

Generated on the server with a small built-in PDF writer (`server/pdf.js`) — no headless browser, no external service:

- **Dispute letter** — recipient block, certified-mail notice, account identifiers, theory-specific paragraph, FCRA §611/§623 citations, evidence enclosures
- **Labels** — one label per package, sized for a standard envelope sheet
- **Mail queue** — cover page, package manifest, labels and every eligible letter in one printable file

---

## Architecture

```
server/
  index.js        app wiring, security headers, CSP, error handling, shutdown
  env.js          minimal .env loader (no dependency)
  auth.js         sessions, CSRF, role guards, rate limiting
  security.js     scrypt hashing, tokens, timing-safe comparison
  accounts.js     provisioning, reset tokens, credential emails
  mail.js         outbox, SMTP (Stalwart) and Resend/Postmark/SendGrid transports, retries
  studio.js       dispute drafting engine (rules, confidence, citations)
  db.js           schema, migrations, tenant routing, audit chain, reference numbers, demo seed
  data.js         tenant-scoped queries
  uploads.js      multer config, file-signature sniffing, hashing
  pdf.js          letters, labels, manifests
  util.js         formatting, product constants, PDF responses    lob.js        certified print-and-mail client (REST, Basic auth, no SDK)
    routes/
    public.js     landing, legal, robots, contact form
    auth.js       sign-in, logout, forgot/reset, change-password
    admin.js      workspace routes
    portal.js     client portal routes
    platform.js   operator console above the tenants
    lob-webhook.js  unauthenticated delivery callbacks from Lob
    billing.js    workspace billing page, checkout and portal
    stripe-webhook.js  signed subscription events from Stripe
  billing.js      Stripe client, plan catalogue, subscription sync
views/            EJS templates (partials for the three shells)
public/           one stylesheet, one script, favicon — no third-party assets
test/             node:test end-to-end suite
```

### Data model

`tenants → users / clients → tradelines / disputes / packages / documents / doc_requests / messages`, plus `document_disputes` (which paper supports which dispute), `sessions`, `audit_log`, `leads`, `drafts` (studio output), `password_resets` (hashed, single-use tokens) and `emails` (the outbox). All workspace tables carry `tenant_id`; client records additionally carry `client_id`, and the portal derives that id from the session rather than from the request. Schema changes are applied on boot with additive `ALTER TABLE` migrations, so an existing `clearpath.db` keeps working after an upgrade.

### Security model

- **Tenant isolation** enforced in the query layer (`tenant_id` from the session), not from form fields
- **Passwords** hashed with scrypt and a per-user salt; comparison is timing-safe
- **Sessions** in SQLite, opaque 256-bit tokens stored hashed, HTTP-only + SameSite=Lax cookies, `Secure` when `COOKIE_SECURE=1`
- **CSRF** double-submit token on every mutating request, plus a same-origin check, plus a login throttle
- **Strict CSP**: `default-src 'self'`, no inline scripts, no third-party fonts or trackers — the UI is progressively enhanced from `public/js/app.js` only
- **Uploads**: MIME allowlist, magic-byte verification, 10 MB cap, random stored filename, SHA-256 recorded
- **Reset tokens**: 32 random bytes, only the SHA-256 hash is stored, 60-minute expiry, single use, all sessions dropped on use; the emailed link is built from `APP_ORIGIN` rather than a spoofable Host header
- **Mail log is owner-only** because the outbox stores message bodies, which can contain a temporary password or a reset link. Treat `DATA_DIR` (and any database backup) as credential material.
- **Audit log**: each entry hashes the previous hash with its own fields; tampering breaks the chain and the verification banner turns red
- **Roles**: owner (branding, team, everything), specialist (cases, disputes, mailroom, documents), client (own portal only)

---

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `./data` | SQLite database and uploaded files (`/data` in Docker) |
| `DB_PATH` | `$DATA_DIR/clearpath.db` | Override the database file |
| `SEED_DEMO` | on | Seed demo tenants on a fresh database; set `0` in production |
| `COOKIE_SECURE` | on in production | `1` behind HTTPS, `0` for plain-HTTP local use |
| `SUPPORT_EMAIL` | `hello@denovocredit.com` | Fallback contact address |
| `APP_ORIGIN` | derived | Absolute base URL used in emailed reset and invitation links — set it in production |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | unset | SMTP submission server (Stalwart and friends); with no provider set, mail stays in the in-app log |
| `SMTP_SECURE` / `SMTP_STARTTLS` | `0` / on | `SMTP_SECURE=1` for implicit TLS (465); `SMTP_STARTTLS=0` only for a trusted relay without TLS |
| `RESEND_API_KEY` / `POSTMARK_TOKEN` / `SENDGRID_API_KEY` | unset | HTTPS mail APIs; used when no SMTP server is configured |
| `MAIL_TRANSPORT` | auto | Force `smtp` (`stalwart`), `resend`, `postmark`, `sendgrid` or `outbox` |
| `MAIL_FROM` | `Clearpath <no-reply@denovocredit.com>` | Sender on a domain verified with your provider |
| `MAIL_REPLY_TO` | unset | Optional reply address |
| `LOB_API_KEY` / `LOB_WEBHOOK_SECRET` / `LOB_BASE_URL` | unset | Enables certified print-and-mail through Lob; see the Lob section above |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | unset | Subscription billing. Keys stored in the platform console win over these; the webhook secret is required before `/webhooks/stripe` accepts events |
| `STRIPE_BASE_URL` | `https://api.stripe.com/v1` | Only for tests or a Stripe-compatible mock |

Copy `.env.example` to `.env`: the app loads it on start (real environment variables take precedence) and Docker Compose uses it for interpolation.

---

## Docker

```bash
docker compose up --build        # http://localhost:3000
```

`docker-compose.yml` runs the app as a non-root user on a read-only root filesystem with a named volume at `/data`, a health check against `/healthz`, and `SEED_DEMO=0`. Set `COOKIE_SECURE=1` and terminate TLS in front of it before inviting real clients.

```bash
# single container, without Compose
docker build -t clearpath .
docker run -d --name clearpath -p 3000:3000 \
  -e NODE_ENV=production -e COOKIE_SECURE=1 -e SEED_DEMO=0 \
  -v clearpath-data:/data clearpath
```

`/healthz` returns `200 {"ok":true}` when the database answers and `503` when it does not.

---

## Testing

```bash
npm test
```

The suite spawns the real server on a temporary data directory and drives it over HTTP: health, marketing and legal pages, session requirements, failed and successful sign-in, role restrictions, host-based tenant routing, cross-tenant 404s, portal scoping, PDF magic bytes, the full intake → tradeline → dispute → package → mailed workflow, multipart upload (valid and spoofed), CSRF rejection, logout, invitation email → forced password change, a reset link working exactly once and dropping other sessions, studio draft → approved dispute with edited letter text, the mail log and its retry guard, reset-request rate limiting, Lob send + signed delivery webhook, platform provisioning and suspension, and billing checkout → success redirect → signed Stripe webhook → workspace status, all against a local Stripe stand-in.

Tests do not cover visual regressions, delivery by a real mail provider (the suite asserts the outbox and drives the SMTP path against a local stub), letters actually printed by Lob, money actually moving through Stripe (the suite speaks to a mock) or Docker image builds.

---

## Before this goes live

1. **Set `SEED_DEMO=0`** and delete any demo database (`npm run seed -- --reset` locally). Demo passwords are published in this README.
2. **Configure a mail provider and `MAIL_FROM` on a verified domain, plus `APP_ORIGIN`.** Without them, invitations and reset links only exist in the Mail log.
3. **Terminate TLS** and set `COOKIE_SECURE=1`; use a real hostname so tenant routing by domain works.
4. **Back up `DATA_DIR`** on a schedule (SQLite WAL included). Test a restore before you need one.
5. **Finish billing before charging anyone**: store a `sk_live_…` key and the endpoint's `whsec_…` in **Platform console → Payments**, add `<APP_ORIGIN>/webhooks/stripe` in Stripe with the six subscription events, press **Check connection**, then run one real subscription end to end. Until the webhook is set, status only changes while a browser is on the success redirect.
6. **Add monitoring** for `/healthz`, disk space and error logs.
7. **Write your compliance documents** — privacy notice, retention schedule, deletion procedure, dispute authorization. The pages at `/legal/privacy` and `/legal/terms` are honest placeholders, not legal advice.
8. **Rotate the seeded passwords** or remove the seeded users; `Settings → Team` cannot delete accounts yet.
9. **Single-node only**: SQLite and the local upload directory assume one instance. For horizontal scaling, move to Postgres and object storage before adding a second replica.

### Not included (by design)

- No billing, SMS, bureau integrations or credit-report parsing, and no LLM call anywhere — the studio is a deterministic drafter.
- No inbound mail: the app only sends. Replies go to `MAIL_REPLY_TO`, and Stalwart's mailbox is where you read them.
- No delete/archive UI for users, clients or documents (deactivation is a schema change away).
- No email verification for teammates: an owner types the address, and the invitation goes there.

## License

MIT — see [LICENSE](LICENSE). Copyright © 2026 Innotel Inc. Upstream material,
where a directory carries its own licence, remains under that licence.
