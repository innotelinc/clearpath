# Clearpath in the Innotel Platform Stack

**Role: ClientOps** — The credit-repair operating system behind Denovo Credit.

Part of the [Innotel Platform Stack](https://github.com/innotelinc/innotel-platform-stack).
The canonical definition of the stack, its shared layers and their owners lives
there; this file records only what Clearpath does inside it.

## Boundaries

### Owns

- the agency workspace and its audit log
- the white-labelled client portal
- the certified mailroom and its tracking record
- per-agency settings and the demo seed

### Consumes

- Cerulean (Authentik SSO, DNS, TLS)
- Cerulean Vault (secrets)
- NPM Edge (public host)
- OmniRoute (optional drafting) and Lob (optional mail)

### Does not own

- identity (Authentik)
- secrets (Cerulean Vault)
- DNS/TLS (Cerulean)
- billing and mail transport

## Service map

| Component | Technology | Job |
| --- | --- | --- |
| Clearpath | Node.js / TypeScript | The credit-repair operating system behind Denovo Credit. |
| Identity | Cerulean Authentik | Sign-in and role claims, where the repo has a UI |
| Secrets | Cerulean Vault (KV v2) | Production credentials, referenced as `vault://` |
| Trust | Cerulean | DNS, TLS and the public hostname |
| Edge | NPM Edge | The public route in front of the service |

## In the ecosystem

- **Identity** comes from Cerulean Authentik; this repo holds no second account
  table and no password of its own.
- **Secrets** come from Cerulean Vault. `.env` is local only and is never
  committed; a `vault://` reference is resolved by the deployment.
- **Trust and edge** are Cerulean's and NPM Edge's. This repo does not write DNS
  records or call the NPM API directly.
- **Storage, billing and telephony** belong to ONYX, Magnate and Zeus
  respectively; Clearpath consumes them only where the boundaries above say
  so.

## See also

- [README](../README.md)
- [Innotel Platform Stack](https://github.com/innotelinc/innotel-platform-stack)
