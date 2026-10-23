# Clearpath — handoff

Written 2026-10-23 so work can continue in a CLI session. Everything here lives in
`clearpath/`; nothing depends on the chat that produced it.

---

## State

| Item | Value |
| --- | --- |
| App | Express 4 + EJS 3 + `node:sqlite`, no build step, no client framework |
| Node | 22.5+ (uses `node:sqlite`; currently verified on 22.23.3) |
| Tests | `npm test` — 33 end-to-end tests, all passing (platform console, suspension, automation, mailed-package archive) |
| Dev server | `PORT=3400 DATA_DIR=./data node server/index.js` (log: `.server.log`) |
| Production entry | `Dockerfile` + `docker-compose.yml` (image not built here: no Docker on this machine) |
| Git | branch `main`, pushed to `https://github.com/innotelinc/clearpath` (public) |
| Latest commit | `940cd72` — provisioning/recovery + drafting studio (this handoff update follows it) |

Demo sign-ins: `dana@denovocredit.com` / `Denovo!2026` (owner), `marcus@denovocredit.com` /
`Specialist!2026`, `amara@example.com` / `Client!2026` (portal).
Platform operator (seeded while `SEED_DEMO` is on): `platform@clearpath.test` / `Platform!2026`
at `/platform/login`.

---

## 2026-10-23 — platform console, automation, AI gateway, sent-package archive

A previous cloud session that built the platform console did not survive, so it was rebuilt here.

| Area | What changed |
| --- | --- |
| Platform console `/platform` | New `platform_admins` + `platform_sessions` tables and `server/platform-auth.js`. Own mount, own cookie, own login page. Tenant list with live usage, provision tenant + first owner invite, suspend/reactivate (deletes tenant sessions and returns 403 on sign-in), owner re-invite, drill-down to the client roster. Bootstrapped by `PLATFORM_ADMIN_EMAIL` / `PLATFORM_ADMIN_PASSWORD`, or seeded as a demo operator. |
| Schema | `tenants.status` / `suspended_at` / `suspended_note`, `packages.sent_at`, `drafts.ai_model` / `ai_refined_at`, plus `package_letters` and `case_insights`. Additive via `ensureColumn`, so existing databases migrate on boot. |
| Dispute pipeline `/app/pipeline` | `server/pipeline.js`: scans tradelines, drafts everything above the 75% evidence floor with the deterministic drafter (`drafts.status = 'Ready'`), queues the rest with explicit reasons, and approves a batch into disputes + one certified-mail package per client and bureau. Nothing is mailed automatically. |
| AI (OmniRoute) | `server/ai.js` — one OpenAI-compatible gateway, one key. Studio **Rewrite with AI** and client **Summarise case with AI**; model recorded on the draft/insight. No key: surfaces explain the setting and everything else keeps working. |
| Mailroom | Marking a package mailed now stores `packages.sent_at` and freezes every letter body into `package_letters`. New package page `/app/mailroom/:id` shows what was sent; tracking numbers link to USPS/UPS/FedEx via `trackingUrl()`. |

Gotcha worth remembering: `client` is a reserved EJS compiler option, so a view local with that
name breaks `include()` — pass client records as `clientRecord` (see `views/admin/client.ejs`).

No postal-mail vendor is integrated. Outbound *email* uses Resend / Postmark / SendGrid when one of
their keys is set; physical certified mail is still printed and posted by hand.

---

## What exists

- **Marketing site** `/` — landing, legal, robots, contact form writing to `leads`.
- **Agency workspace** `/app` — overview, clients + case files, disputes, drafting studio,
  mailroom with PDF labels, documents, mail log, audit log, settings.
- **Client portal** `/portal` — scores, disputes, uploads, messages, score history.
- **Tenancy** — `Host` routing plus `tenant_id` on every query; Northstar is the second
  seeded tenant used to prove isolation.

---

## What changed in this session

1. **Drafting studio** (`/app/studio`, `server/studio.js`, `views/studio.ejs`).
   The old single-file prototype had a fake "AI Studio" with simulated streaming steps and
   invented confidence numbers. It was **not** in the ported app, so it has been rebuilt as
   a real feature: pick a tradeline, pick a legal basis (§611, §623, §605, 12 CFR 1022.43),
   pick a voice, generate. The letter is assembled by deterministic rules from the tradeline,
   evidence list, bureau and prior rounds; confidence is evidence strength; the draft lists
   "what the file supports"; citations are shown as chips. Edit the body, then **Approve** →
   creates a normal dispute whose `letter_body` is the edited text, so `letterPdf()` and
   `letterText()` use it (see the override at the top of `letterBlocks` in `server/pdf.js`).
   No LLM is called. If a model-backed drafter is ever wanted it can sit behind
   `generateDraft()` without touching the routes.

2. **Outbound email** (`server/mail.js`). Outbox-first design: every message is written to
   the `emails` table, then delivered through Resend, Postmark or SendGrid over plain HTTPS
   (no SDK). With no key configured, nothing is delivered and the message stays visible in
   `/app/mail-log` — this is why the demo works end to end without credentials. Failures
   retry four times on a background interval, then wait for a manual retry from the log.

3. **Account lifecycle** (`server/accounts.js`).
   - Inviting a client or teammate creates the account, generates a temporary password and
     emails it. The password is displayed in the UI only when no mail provider is configured.
   - `must_change_password` on `users`: first sign-in is forced through `/change-password`.
   - `/forgot` → single-use, 60-minute, hashed-at-rest reset token; using it deletes every
     existing session for that account. Reused or expired links return 400.
   - Owners can email a reset link from a client's file (`/app/clients/:id/portal-reset`) or
     from Settings → Team (`/app/settings/team/:id/reset`).
   - Changing a password keeps the current session and drops the others.

4. **Robustness pass.**
   - `server/env.js` — the `.env` file is now actually loaded (previously documented but
     ignored); real environment variables still win.
   - Additive migrations in `server/db.js` (`ensureColumn`) so existing databases upgrade.
   - `PRAGMA busy_timeout`, expired reset-token cleanup, `unhandledRejection` logging.
   - Generic fixed-window rate limiter in `server/auth.js`; login and reset requests are both
     limited. Reset responses never reveal whether an address exists.
   - Reset/invite links are built from `APP_ORIGIN`, or only from the request `Host` when it
     is loopback or the tenant's own domain — a spoofed Host header cannot redirect a token.

5. **Docs/config** — `README.md`, `.env.example` (rewritten; the old file had a stray
   `[TEMPLATE]` line that would break a parser), `docker-compose.yml` mail passthrough,
   and 6 new tests (19 → 25).

---

## Schema additions

| Table / column | Purpose |
| --- | --- |
| `password_resets` | `token_hash`, `expires_at`, `used_at`, `requested_ip` |
| `emails` | outbox: recipient, kind, body, link, status, provider, error, attempts |
| `drafts` | studio output: strategy, tone, confidence, subject, body, citations, signals, status, `dispute_id` |
| `users.must_change_password` | forces the first-sign-in password change |
| `disputes.letter_body` | approved studio text, used by the letter PDF and text preview |

---

## Configuration to finish before real use

```bash
APP_ORIGIN=https://app.denovocredit.com     # required for correct emailed links
MAIL_FROM="Denovo Credit <no-reply@denovocredit.com>"   # verified domain
RESEND_API_KEY=…        # or POSTMARK_TOKEN / SENDGRID_API_KEY
SEED_DEMO=0
COOKIE_SECURE=1
```

`.env` is read on boot (see `server/env.js`); Docker Compose reads the same file for
interpolation and passes the mail variables through explicitly.

> The Resend key supplied on 23 Oct was rejected by the API (`401 API key is invalid`), so
> delivery is currently unconfigured and mail stays in the outbox. Drop a valid key into
> `.env` (`RESEND_API_KEY=…`) together with a `MAIL_FROM` on a domain verified in Resend,
> then restart. Nothing has been delivered to a real recipient yet.

`.env` is gitignored; no credential belongs in a commit.

---

## Known gaps / sensible next steps

- **No SMTP transport.** Providers are HTTPS APIs only. If an agency wants to send from a
  mailbox (Google Workspace, SES SMTP), add a transport function in `server/mail.js`.
- **Rate limiting is in-memory** — fine for one instance, resets on restart, not shared.
- **No account deletion or deactivation.** Invites cannot be revoked; owners cannot remove a
  teammate. Next obvious admin feature.
- **No email verification** for teammate invites; the owner types the address.
- **No 2FA**, no session list, no "sign out everywhere" button (the data to build it exists).
- **Drafts are not editable in the list**, only one at a time via `/app/studio/:id`.
- **Document requests do not email the client** — the message thread does not notify either.
  The mailer is now in place, so adding a "notify" template is small.
- **Docker image unverified** on this machine (no Docker CLI). `docker compose up --build`
  is the first thing to run somewhere with Docker.
- Office/PDF: label sheet assumes a standard envelope sheet; check against the printer in use.

---

## Verification

```bash
cd clearpath
npm install
npm run check        # node --check on the server entry points
npm test             # 25 tests, spawned server, temporary database
npm run seed         # inspect seeded tenants/users
PORT=3400 npm start  # http://localhost:3400
```

What the suite covers: health, marketing/legal, session gates, sign-in, roles, host tenant
routing, cross-tenant 404s, portal scoping, PDF magic bytes, full intake → tradeline →
dispute → package → mailed workflow, multipart uploads (valid + spoofed), CSRF, logout,
invitation email → forced password change, reset link single-use + session invalidation,
studio draft → approved dispute with edited letter text, mail log retry guard, reset rate
limiting, and password change dropping other sessions.

Manually verified in a browser this session: `/app/studio` at 1440 px and 390 px, draft
generation against a seeded tradeline (confidence, signals, citation chips, buttons), and
`/app/mail-log` (transport banner, empty state, zero console errors).

---

## Conversation context (why things look like this)

The project began as a single-file HTML prototype of "Clearpath" for Denovo Credit with
fabricated data and simulated AI. It was rebuilt as a real multi-tenant server app: marketing
site, agency workspace, white-labelled portal, SQLite persistence, hash-chained audit log,
server-generated PDFs, Docker packaging. The owner asked for a repo under the `innotelinc`
GitHub account; `clearpath` was free at the time (no repo of that name among the account's
public repos; `clearcredit` and `aicreditrepair` are separate projects). The repo now exists
as **public** at <https://github.com/innotelinc/clearpath> and `main` is pushed. There is no
`gh` CLI on this machine — pushes authenticate through the Git Credential Manager entry for
`innotelinc`, so plain `git push` works from this checkout.

Commit identity is repo-local `Denovo Credit <hello@denovocredit.com>`; rewrite it if the
commits should carry a personal identity.
