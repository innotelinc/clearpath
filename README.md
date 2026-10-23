# Clearpath

The credit repair operating system behind **Denovo Credit** — a multi-tenant workspace for agencies, a white-labelled client portal, and a certified mailroom that turns approved disputes into printed, tracked packets.

- **Marketing site** at `/` (Denovo Credit · denovocredit.com)
- **Agency workspace** at `/app` — clients, disputes, mailroom, documents, audit log, settings
- **Client portal** at `/portal` — scores, dispute status, uploads, messages
- **Server-rendered** with Express + EJS, SQLite, and a dependency-free browser script
- **Runs as a container** with a persistent volume for the database and uploads

Continuing this project elsewhere? [HANDOFF.md](HANDOFF.md) records the current state, decisions, schema changes and open work.

---

## Quick start

```bash
git clone <repo> clearpath && cd clearpath
npm install
npm start            # http://localhost:3000 — seeds demo data on first boot
```

Requires **Node 22.5+** (uses the built-in `node:sqlite` module — no native build step).

```bash
npm run dev          # restart on change
npm test             # 25 end-to-end tests against a spawned server
npm run seed         # seed an empty database, or inspect what exists
npm run seed -- --reset   # wipe local data and reseed (refuses in production)
```

### Demo accounts

| Workspace | Role | Email | Password |
| --- | --- | --- | --- |
| Denovo Credit | Owner | `dana@denovocredit.com` | `Denovo!2026` |
| Denovo Credit | Specialist | `marcus@denovocredit.com` | `Specialist!2026` |
| Denovo Credit | Client (portal) | `amara@example.com` | `Client!2026` |
| Northstar Credit Group | Owner | `owner@northstar.test` | `Northstar!2026` |

The login page shows these only while `SEED_DEMO` is not `0`. Set `SEED_DEMO=0` in production and the cards disappear.

Northstar is a second tenant used to demonstrate isolation. Requests are routed to a workspace by the `Host` header: `northstar.clearpath.test` (or whatever you set as its domain in Settings) resolves to Northstar, everything else falls back to the first workspace. Every query is additionally scoped by the signed-in user's `tenant_id`, so a host header alone cannot expose another agency's records.

---

## What it does

### Agency workspace

| Area | Capability |
| --- | --- |
| Overview | KPIs, open dispute pipeline, ready-to-mail packages, documents awaiting review, stage mix, hash-chained activity feed |
| Clients | Search, stage filter, new-client intake, per-client case file with tradelines, disputes, documents, requests, messages and notes |
| Disputes | Draft from a tradeline (bureau, account, theory, evidence strength), generate a letter with FCRA citations, track round, status, mailing date and response deadline |
| Drafting studio | Pick a tradeline and a legal basis (§611 reinvestigation, §623 direct dispute, §605 obsolescence, Regulation V), review the evidence signals and confidence, edit the letter, then approve it into a dispute |
| Mailroom | Select approved letters, group one package per client + bureau, price certified/priority/standard postage, print labels and a letter manifest, record tracking, start the 30-day clock |
| Documents | Upload with signature verification and SHA-256 hashing, verify, download, request documents from a client, see what is outstanding |
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

The app writes every message to an `emails` outbox first, then hands it to the configured provider. With no provider configured nothing is delivered — the message stays in the Mail log (`/app/mail-log`) with its full body, which keeps demos and air-gapped installs coherent. Supported transports are Resend, Postmark and SendGrid over plain HTTPS (`server/mail.js`, no SDK). Failures retry automatically four times with a one-minute floor, then stay in the log for a manual retry.

### Drafting studio

The studio is built in, not bolted on and not dependent on an API key. Letters are assembled by fixed rules from the tradeline, the evidence list, prior rounds and the bureau file: same input, same letter, no per-letter cost, and every sentence traceable to a field. The confidence figure is evidence strength, not a prediction of the outcome; the draft lists what the file supports and what is still thin. A specialist edits and approves it, which creates a normal dispute whose PDF uses the edited text. No language model is called anywhere in the product.

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
  mail.js         outbox, Resend/Postmark/SendGrid transports, retries
  studio.js       dispute drafting engine (rules, confidence, citations)
  db.js           schema, migrations, tenant routing, audit chain, reference numbers, demo seed
  data.js         tenant-scoped queries
  uploads.js      multer config, file-signature sniffing, hashing
  pdf.js          letters, labels, manifests
  util.js         formatting, product constants, PDF responses
  routes/
    public.js     landing, legal, robots, contact form
    auth.js       sign-in, logout, forgot/reset, change-password
    admin.js      workspace routes
    portal.js     client portal routes
views/            EJS templates (partials for the three shells)
public/           one stylesheet, one script, favicon — no third-party assets
test/             node:test end-to-end suite
```

### Data model

`tenants → users / clients → tradelines / disputes / packages / documents / doc_requests / messages`, plus `sessions`, `audit_log`, `leads`, `drafts` (studio output), `password_resets` (hashed, single-use tokens) and `emails` (the outbox). All workspace tables carry `tenant_id`; client records additionally carry `client_id`, and the portal derives that id from the session rather than from the request. Schema changes are applied on boot with additive `ALTER TABLE` migrations, so an existing `clearpath.db` keeps working after an upgrade.

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
| `RESEND_API_KEY` / `POSTMARK_TOKEN` / `SENDGRID_API_KEY` | unset | Enables delivery; with none set, mail stays in the in-app log |
| `MAIL_TRANSPORT` | auto | Force `resend`, `postmark`, `sendgrid` or `outbox` |
| `MAIL_FROM` | `Clearpath <no-reply@denovocredit.com>` | Sender on a domain verified with your provider |
| `MAIL_REPLY_TO` | unset | Optional reply address |

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

The suite spawns the real server on a temporary data directory and drives it over HTTP: health, marketing and legal pages, session requirements, failed and successful sign-in, role restrictions, host-based tenant routing, cross-tenant 404s, portal scoping, PDF magic bytes, the full intake → tradeline → dispute → package → mailed workflow, multipart upload (valid and spoofed), CSRF rejection, logout, invitation email → forced password change, a reset link working exactly once and dropping other sessions, studio draft → approved dispute with edited letter text, the mail log and its retry guard, and reset-request rate limiting.

Tests do not cover visual regressions, delivery by a real mail provider (the suite asserts the outbox), payment processing (there is none) or Docker image builds.

---

## Before this goes live

1. **Set `SEED_DEMO=0`** and delete any demo database (`npm run seed -- --reset` locally). Demo passwords are published in this README.
2. **Configure a mail provider and `MAIL_FROM` on a verified domain, plus `APP_ORIGIN`.** Without them, invitations and reset links only exist in the Mail log.
3. **Terminate TLS** and set `COOKIE_SECURE=1`; use a real hostname so tenant routing by domain works.
4. **Back up `DATA_DIR`** on a schedule (SQLite WAL included). Test a restore before you need one.
5. **Add monitoring** for `/healthz`, disk space and error logs.
6. **Write your compliance documents** — privacy notice, retention schedule, deletion procedure, dispute authorization. The pages at `/legal/privacy` and `/legal/terms` are honest placeholders, not legal advice.
7. **Rotate the seeded passwords** or remove the seeded users; `Settings → Team` cannot delete accounts yet.
8. **Single-node only**: SQLite and the local upload directory assume one instance. For horizontal scaling, move to Postgres and object storage before adding a second replica.

### Not included (by design)

- No billing, SMS, bureau integrations or credit-report parsing, and no LLM call anywhere — the studio is a deterministic drafter.
- No SMTP transport: providers are HTTPS APIs. Add a transport in `server/mail.js` if you need a mailbox relay.
- No delete/archive UI for users, clients or documents (deactivation is a schema change away).
- No email verification for teammates: an owner types the address, and the invitation goes there.
