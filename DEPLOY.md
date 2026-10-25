# Clearpath — hosted deployment

What is actually running, where, and how to change it. Written 2026-10-24 for the
first real deployment; the app-level documentation stays in `README.md` and the
design history in `HANDOFF.md`.

```
https://denovocredit.com  (and www, app)
  → NPM edge (proxy container, 192.168.1.71:443)
  → clearpath container on i2, 192.168.1.83:3000
  → Stalwart (oasis, mail container on i3) for outbound email
  → OmniRoute gateway for the AI surfaces
```

## Host

| Item | Value |
| --- | --- |
| Server | **i2** (`192.168.1.52`) — picked for headroom: load 0.4, 3 GB spare RAM, 17 GB free disk. i1 runs Monarch transcodes at load 8+, i3 is a 5 GB mail host, i4 is the edge with no spare memory. |
| Container | `clearpath` (Ubuntu 24.04, incus, unmanaged `br0`) |
| Address | `192.168.1.83` — static in `/etc/netplan/10-lxc.yaml` inside the container; `ipv4.address` cannot be set on the NIC because `br0` is unmanaged |
| Limits | `limits.cpu=2`, `limits.memory=1GiB`, `boot.autostart=true` |
| Runtime | Node 22 from nodesource (`/usr/bin/node`), no build step |

```bash
incus exec i2move:clearpath -- bash          # or ssh root@192.168.1.52 then incus exec clearpath -- bash
incus list i2move:clearpath
```

## Paths and process

| Path | Purpose |
| --- | --- |
| `/opt/clearpath` | git checkout of `github.com/innotelinc/clearpath` (owned by `clearpath`) |
| `/opt/clearpath/.env` | all runtime configuration and secrets, mode `600`, gitignored |
| `/var/lib/clearpath` | SQLite database + uploads (`DATA_DIR`), the only writable path |
| `/etc/systemd/system/clearpath.service` | unit: `User=clearpath`, `Restart=always`, `ProtectSystem=strict`, `ReadWritePaths=/var/lib/clearpath` |

```bash
systemctl status clearpath
journalctl -u clearpath -n 50 --no-pager   # boot line names the mail transport
```

Updating:

```bash
incus exec i2move:clearpath -- bash /opt/clearpath/scripts/deploy.sh --dry-run
incus exec i2move:clearpath -- bash /opt/clearpath/scripts/deploy.sh
```

That is the four steps this section used to spell out — snapshot the database,
`git reset --hard origin/main`, `npm ci --omit=dev`, restart — plus the two that
matter when the deploy is bad: it waits for `/healthz`, compares the stylesheet
the site now serves with the one in the checkout, and puts the previous commit
back (with its database snapshot) if either check fails. It refuses to run over
uncommitted changes in the checkout unless given `--force`.

Snapshots land in `/var/lib/clearpath/backups/clearpath-<stamp>-deploy.db` and
nothing in the script deletes them; prune by hand. To restore one: stop the
service, copy the file over `/var/lib/clearpath/clearpath.db` (removing `-wal`
and `-shm` beside it), start the service.

The database migrates on boot (`ensureColumn`), and `SEED_DEMO` only ever seeds a
fresh database.

Static assets are linked with a content hash (`/assets/css/app.css?v=…`, see
`server/assets.js`), so a deploy that changes a stylesheet reaches a browser
that cached the old one without a hard refresh. A `?v=` URL is served
`immutable` for a year; a bare one revalidates.

## DNS, TLS and the proxy host

DNS is the estate resolver (Technitium behind Cerulean); the zone
`denovocredit.com` is already delegated to `ns1/ns2.denovocredit.com` →
`73.68.203.71`.

| Piece | Value |
| --- | --- |
| Records | apex `A 73.68.203.71` (already in the zone); `app.denovocredit.com CNAME denovocredit.com.` (Cerulean domain id 7) |
| Certificate | `*.denovocredit.com` from Cerulean (Let's Encrypt, DNS-01), imported into NPM as certificate `67` — covers apex, `www`, `app` and any other name |
| NPM proxy host 71 | apex + `www` → `http://192.168.1.83:3000`, SSL forced, HTTP/2, websocket upgrade, no caching (was the WordPress site until 2026-10-24) |
| NPM proxy host 274 | `app.denovocredit.com` → `http://192.168.1.83:3000`, same settings |

The app routes tenants by `Host` header, so extra names (`portal.`, `app2.`) only
need a CNAME plus a proxy host; nothing in the app changes.

### WordPress retirement (2026-10-24)

The apex used to serve the Denovo WordPress site from the `www` container
(`192.168.1.80`, Apache + MySQL, `/var/www/denovocredit`). That vhost is now
disabled; the files and database are backed up on the container:

```
/var/backups/denovocredit-files-20261024.tar.gz   (174 MB)
/var/backups/denovocredit-db-20261024.sql         (8 MB)
```

To bring it back: `incus exec www -- a2ensite denovocredit.com denovocredit.com-le-ssl`,
reload Apache, and point NPM host 71 back at `https://192.168.1.80:443`. The
certificates under `/etc/letsencrypt/live/denovocredit.com` are shared with the
`cattape.us` vhost and must not be deleted. The other WordPress sites on that
container (cattape.us, usagents.pro, hdlogistics.pro, pickleme.world) were
verified unaffected.

## Outbound email (Stalwart)

| Item | Value |
| --- | --- |
| Submission | `mail.innotel.us:465`, implicit TLS, `SMTP AUTH` as `clearpath@denovocredit.com` |
| Mailbox | created through the estate path (`oasis-mail-admin`): Authentik user `clearpath@denovocredit.com` in group `Mail` + Stalwart account `cm` on domain `denovocredit.com` |
| Credential | a Stalwart **app password**, description `clearpath SMTP submission` |
| Sender | `MAIL_FROM="Clearpath <clearpath@denovocredit.com>"` — must stay an address of that mailbox |

**Why an app password and not a normal one:** the estate's Stalwart directory is
OIDC (Authentik), so the server refuses to store a local password on any account
(`Cannot set credentials for accounts in an external directory`) and plain SMTP
AUTH against the directory fails with `454 4.7.0 Temporary authentication
failure`. App passwords are validated locally and are the only working primitive
for a service mailbox. Create/rotate one with the admin JMAP API:

```python
# on the mail container, with STALWART_RECOVERY_ADMIN from /etc/stalwart/stalwart.env
POST https://mail.innotel.us/jmap/
{"using":["urn:ietf:params:jmap:core","urn:stalwart:jmap"],
 "methodCalls":[["x:AppPassword/set",
   {"accountId":"cm","create":{"p":{"description":"clearpath SMTP submission"}}},"c"]]}
# → created.p.secret is the password; it is returned once. Store it in .env,
#   restart clearpath, then destroy the old app password id.
```

DKIM (`v1-*`), SPF, DMARC, MTA-STS and the SRV records for the domain are already
published in the zone by Stalwart, so the domain aligns; nothing else to add.

### Per-workspace email server (Settings → Email server)

An agency owner can enter their own SMTP server in the workspace instead of
editing `.env`. The row lives in `tenant_mail` and takes precedence over
`SMTP_*` for that workspace only; **Save & send test** mails the signed-in owner
and records the result in the mail log. The SMTP password is sealed with
AES-256-GCM using `MAIL_SECRET` when set, otherwise `/var/lib/clearpath/mail.secret`
(mode 600, generated on first use). Back up that file with the database — without
it saved passwords cannot be decrypted, and the owner must re-enter them.

Environment keys still apply to workspaces with no row of their own (and to the
platform console's invitations), so the Stalwart configuration above remains the
deployment fallback.

## Document review and the vault

The vault no longer verifies a document blind: every row opens at
`/app/documents/<id>`, which frames the PDF (or shows the image) beside its
client, SHA-256 and checklist, and only then offers **Verify document**. Seeded
demo records have no scanned original, so on boot `server/demo-files.js` writes a
demonstration PDF into `uploads/` for each one, labelled as such; a real upload
replaces it. Downloads stream the same file with its true content type.

## AI gateway

`OMNIROUTE_BASE_URL=http://192.168.1.71:20128/v1` with the OmniRoute key named
`clearpath` (created for this deployment). Without the key the AI surfaces hide
themselves and the deterministic drafter keeps working.

## Configuration currently in `/opt/clearpath/.env`

| Key | Value |
| --- | --- |
| `PORT` / `NODE_ENV` | `3000` / `production` |
| `DATA_DIR` / `DB_PATH` | `/var/lib/clearpath` / `/var/lib/clearpath/clearpath.db` |
| `COOKIE_SECURE` | `1` |
| `SEED_DEMO` | `1` — **turn off before real client data** |
| `APP_ORIGIN` | `https://app.denovocredit.com` |
| `MAIL_TRANSPORT` / `SMTP_*` | `smtp` / `mail.innotel.us`, `465`, implicit TLS |
| `PLATFORM_ADMIN_EMAIL` | `platform@denovocredit.com` (password in `.env`) |
| Contact details | `SUPPORT_EMAIL=hello@denovocredit.com`; the tenant row carries phone `(774) 505-7135`, and the landing page and footer print phone, fax `(774) 505-7136` and “Mon–Fri, 9–6 ET” |
| `STRIPE_*`, `LOB_*` | unset — both surfaces stay hidden |

Demo sign-ins while `SEED_DEMO=1`: owner `dana@denovocredit.com` / `Denovo!2026`,
specialist `marcus@denovocredit.com` / `Specialist!2026`, client
`amara@example.com` / `Client!2026`. Operator console `/platform/login` uses
`PLATFORM_ADMIN_EMAIL` and the password in `.env` (not the seeded demo operator,
which is skipped when both platform variables are set).

## Verified on 2026-10-24

- `https://denovocredit.com/`, `https://www.denovocredit.com/` and `https://app.denovocredit.com/` → 200, valid `*.denovocredit.com` certificate.
- Landing page: client sign-in in the header, agency sign-in in the footer, phone/fax/ET in both the contact block and the footer.
- Owner sign-in over the public URL; `/app`, `/app/clients`, `/app/mailroom`,
  `/app/mail-log`, `/app/studio`, `/app/settings`, `/app/billing` all 200.
- Settings → Email server reads `smtp`, `mail.innotel.us:465 · implicit TLS`,
  `SMTP AUTH as clearpath@denovocredit.com`, and accepts a workspace override
  (saved row + test message, password sealed in `tenant_mail`).
- Vault: a seeded document opens for review with its PDF inline, downloads with
  `Content-Type: application/pdf`, and verifies only from the review page.
- Client portal: `/portal/packages` lists each mailed package with its tracking
  number and the frozen letter bodies, and `/portal/disputes/<id>` shows both the
  generated letter and the sealed copy with the package it travelled in.
- A message sent through `sendMail()` left the outbox as `status=sent`,
  `provider=smtp`, and arrived in `admin@innotel.us` on the Stalwart node.
- `incus restart clearpath` → static address, unit enabled and active, local and
  public HTTP 200 afterwards.
