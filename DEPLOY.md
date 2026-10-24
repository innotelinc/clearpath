# Clearpath — hosted deployment

What is actually running, where, and how to change it. Written 2026-10-24 for the
first real deployment; the app-level documentation stays in `README.md` and the
design history in `HANDOFF.md`.

```
https://app.denovocredit.com
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
cd /opt/clearpath
git fetch origin main && git reset --hard origin/main
npm ci --omit=dev
systemctl restart clearpath
```

The database migrates on boot (`ensureColumn`), and `SEED_DEMO` only ever seeds a
fresh database.

## DNS, TLS and the proxy host

DNS is the estate resolver (Technitium behind Cerulean); the zone
`denovocredit.com` is already delegated to `ns1/ns2.denovocredit.com` →
`73.68.203.71`.

| Piece | Value |
| --- | --- |
| Record | `app.denovocredit.com CNAME denovocredit.com.` (Cerulean domain id 7) |
| Certificate | `*.denovocredit.com` from Cerulean (Let's Encrypt, DNS-01), already imported into NPM as certificate `67` |
| NPM proxy host | id `274` → `http://192.168.1.83:3000`, SSL forced, HTTP/2, websocket upgrade, no caching |

`www.denovocredit.com` and the apex are untouched: they still serve the WordPress
site on the `www` container (192.168.1.80). Flipping the apex to Clearpath is a
one-line change on proxy host 71 if that is ever wanted:

```bash
# on the proxy container
npm-edit.py forward denovocredit.com 192.168.1.83 3000
```

The app routes tenants by `Host` header, so extra names (`portal.`, `app2.`) only
need a CNAME plus a proxy host; nothing in the app changes.

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
| `STRIPE_*`, `LOB_*` | unset — both surfaces stay hidden |

Demo sign-ins while `SEED_DEMO=1`: owner `dana@denovocredit.com` / `Denovo!2026`,
specialist `marcus@denovocredit.com` / `Specialist!2026`, client
`amara@example.com` / `Client!2026`. Operator console `/platform/login` uses
`PLATFORM_ADMIN_EMAIL` and the password in `.env` (not the seeded demo operator,
which is skipped when both platform variables are set).

## Verified on 2026-10-24

- `https://app.denovocredit.com/` → 200, valid `*.denovocredit.com` certificate.
- Owner sign-in over the public URL; `/app`, `/app/clients`, `/app/mailroom`,
  `/app/mail-log`, `/app/studio`, `/app/settings`, `/app/billing` all 200.
- Settings → Email delivery reads `smtp`, `mail.innotel.us:465 · implicit TLS`,
  `SMTP AUTH as clearpath@denovocredit.com`.
- A message sent through `sendMail()` left the outbox as `status=sent`,
  `provider=smtp`, and arrived in `admin@innotel.us` on the Stalwart node.
- `incus restart clearpath` → static address, unit enabled and active, local and
  public HTTP 200 afterwards.
