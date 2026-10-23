# Clearpath

The credit repair operating system behind **Denovo Credit** — a multi-tenant workspace for agencies, a white-labelled client portal, and a certified mailroom that turns approved disputes into printed, tracked packets.

- **Marketing site** at `/` (Denovo Credit · denovocredit.com)
- **Agency workspace** at `/app` — clients, disputes, mailroom, documents, audit log, settings
- **Client portal** at `/portal` — scores, dispute status, uploads, messages
- **Server-rendered** with Express + EJS, SQLite, and a dependency-free browser script
- **Runs as a container** with a persistent volume for the database and uploads

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
npm test             # 19 end-to-end tests against a spawned server
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
| Mailroom | Select approved letters, group one package per client + bureau, price certified/priority/standard postage, print labels and a letter manifest, record tracking, start the 30-day clock |
| Documents | Upload with signature verification and SHA-256 hashing, verify, download, request documents from a client, see what is outstanding |
| Audit | Append-only SHA-256 chained log, chain verification, CSV export |
| Settings | Branding (name, monogram, accent, tagline, support details, portal name, domain, welcome copy), team invites, password change |

### Client portal

Three bureau scores with movement since intake, utilization, open and closed disputes in plain language, document requests with one-tap upload, the document vault, a message thread with the specialist, and a score-history page. Everything is scoped to the signed-in client's own record.

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
  auth.js         sessions, CSRF, role guards, login throttling
  security.js     scrypt hashing, tokens, timing-safe comparison
  db.js           schema, tenant routing, audit chain, reference numbers, demo seed
  data.js         tenant-scoped queries
  uploads.js      multer config, file-signature sniffing, hashing
  pdf.js          letters, labels, manifests
  util.js         formatting, product constants, PDF responses
  routes/
    public.js     landing, legal, robots, contact form
    auth.js       agency and client sign-in, logout
    admin.js      workspace routes
    portal.js     client portal routes
views/            EJS templates (partials for the three shells)
public/           one stylesheet, one script, favicon — no third-party assets
test/             node:test end-to-end suite
```

### Data model

`tenants → users / clients → tradelines / disputes / packages / documents / doc_requests / messages`, plus `sessions`, `audit_log` and `leads`. All workspace tables carry `tenant_id`; client records additionally carry `client_id`, and the portal derives that id from the session rather than from the request.

### Security model

- **Tenant isolation** enforced in the query layer (`tenant_id` from the session), not from form fields
- **Passwords** hashed with scrypt and a per-user salt; comparison is timing-safe
- **Sessions** in SQLite, opaque 256-bit tokens stored hashed, HTTP-only + SameSite=Lax cookies, `Secure` when `COOKIE_SECURE=1`
- **CSRF** double-submit token on every mutating request, plus a same-origin check, plus a login throttle
- **Strict CSP**: `default-src 'self'`, no inline scripts, no third-party fonts or trackers — the UI is progressively enhanced from `public/js/app.js` only
- **Uploads**: MIME allowlist, magic-byte verification, 10 MB cap, random stored filename, SHA-256 recorded
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

Copy `.env.example` to `.env` for Docker Compose (it reads the file automatically). For `npm start`, export the variables in your shell.

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

The suite spawns the real server on a temporary data directory and drives it over HTTP: health, marketing and legal pages, session requirements, failed and successful sign-in, role restrictions, host-based tenant routing, cross-tenant 404s, portal scoping, PDF magic bytes, the full intake → tradeline → dispute → package → mailed workflow, multipart upload (valid and spoofed), CSRF rejection, and logout.

Tests do not cover visual regressions, email delivery (there is none), payment processing (there is none) or Docker image builds.

---

## Before this goes live

1. **Set `SEED_DEMO=0`** and delete any demo database (`npm run seed -- --reset` locally). Demo passwords are published in this README.
2. **Terminate TLS** and set `COOKIE_SECURE=1`; use a real hostname so tenant routing by domain works.
3. **Back up `DATA_DIR`** on a schedule (SQLite WAL included). Test a restore before you need one.
4. **Add monitoring** for `/healthz`, disk space and error logs.
5. **Write your compliance documents** — privacy notice, retention schedule, deletion procedure, dispute authorization. The pages at `/legal/privacy` and `/legal/terms` are honest placeholders, not legal advice.
6. **Rotate the seeded passwords** or remove the seeded users; `Settings → Team` cannot delete accounts yet.
7. **Single-node only**: SQLite and the local upload directory assume one instance. For horizontal scaling, move to Postgres and object storage before adding a second replica.

### Not included (by design)

- No outbound email: portal invitations and document requests show a temporary password in the UI for you to deliver; wire your own provider before self-service onboarding.
- No billing, SMS, bureau integrations or credit-report parsing.
- No password reset flow: an owner creates the account; recovery is a manual database operation.
- No delete/archive UI for users, clients or documents.
