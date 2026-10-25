/**
 * The demonstration sign-ins a database holds, with the password each one takes.
 *
 * The seed writes passwords as scrypt hashes with a per-user salt, so no row can
 * be read back as a password. Instead the demonstration passwords are known
 * here, and each one is tried against each stored hash: what comes back is the
 * password that actually works, not the one that was supposed to be written. An
 * account whose password has changed since the seed reports `password: null`, and
 * the caller says so rather than printing a password that would fail.
 *
 * Shared by `scripts/credentials.js` (the terminal report) and the platform
 * console, so the two can never disagree about who can sign in.
 */
import { db } from "./db.js";
import { verifyPassword } from "./security.js";

const DEMO_PASSWORDS = ["Client!2026", "Specialist!2026", "Owner!2026", "Platform!2026"];

/** `Denovo!2026`, `Northstar!2026` — the owner password is the workspace's brand. */
function brandPassword(tenant) {
  const brand = String(tenant.brand_name || tenant.name || tenant.slug || "")
    .trim()
    .split(/\s+/)[0]
    .replace(/[^A-Za-z]/g, "");
  return brand ? `${brand}!2026` : null;
}

/**
 * Candidates in the order worth trying: the role's own password first, so the
 * common case costs one hash instead of four.
 */
function candidatesFor(tenant, role) {
  const brand = brandPassword(tenant);
  const first =
    role === "client" ? "Client!2026" : role === "specialist" ? "Specialist!2026" : brand;
  return [...new Set([first, brand, ...DEMO_PASSWORDS].filter(Boolean))];
}

/** The password from `candidates` that verifies against this row, or null. */
export function passwordThatWorks(row, candidates) {
  for (const candidate of candidates) {
    if (verifyPassword(candidate, row.password_salt, row.password_hash)) return candidate;
  }
  return null;
}

function defaultOrigin() {
  return String(process.env.APP_ORIGIN || `http://localhost:${process.env.PORT || 3000}`).replace(
    /\/+$/,
    ""
  );
}

function hostOf(url) {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Everything the report says, as data.
 *
 * `site` is the URL a workspace answers on: its own domain, or — for the first
 * workspace — the deployment's origin, because a host that matches no domain
 * falls back to it (`tenantForHost`).
 */
export function credentialReport({ origin = defaultOrigin() } = {}) {
  const base = String(origin).replace(/\/+$/, "");
  const baseHost = hostOf(base);
  const tenants = db.prepare("SELECT * FROM tenants ORDER BY id").all();
  const users = db
    .prepare(
      `SELECT u.*, c.ref AS client_ref
       FROM users u LEFT JOIN clients c ON c.id = u.client_id
       ORDER BY CASE u.role WHEN 'owner' THEN 0 WHEN 'specialist' THEN 1 ELSE 2 END, u.name`
    )
    .all();

  let changed = 0;
  const workspaces = tenants.map((tenant, index) => {
    const isFallback = index === 0;
    const domain = String(tenant.domain || "")
      .trim()
      .toLowerCase();
    const site = domain && domain === baseHost ? base : domain ? `https://${domain}` : "";
    const url = site || (isFallback ? base : "");
    const seats = users
      .filter((user) => user.tenant_id === tenant.id)
      .map((user) => {
        const password = passwordThatWorks(user, candidatesFor(tenant, user.role));
        if (!password) changed += 1;
        return {
          role: user.role,
          name: user.name,
          email: user.email,
          clientRef: user.client_ref,
          password,
          signIn: user.role === "client" ? `${url}/portal/login` : `${url}/login`
        };
      });
    return {
      id: tenant.id,
      slug: tenant.slug,
      name: tenant.name,
      status: tenant.status,
      domain: domain || null,
      site: url,
      agencyUrl: url ? `${url}/login` : null,
      portalUrl: url ? `${url}/portal/login` : null,
      // The first workspace is also what a host matching no domain reaches, so
      // on a local install it is reachable at APP_ORIGIN as well as its domain.
      defaultOrigin: isFallback && site && site !== base ? base : null,
      seats
    };
  });

  // Only the seeded operator password is reportable. A deployment's own
  // PLATFORM_ADMIN_PASSWORD is a real secret and must never be printed back,
  // even to the operator looking at this page.
  const operators = db
    .prepare("SELECT * FROM platform_admins ORDER BY id")
    .all()
    .map((admin) => {
      const password = passwordThatWorks(admin, ["Platform!2026"]);
      if (!password) changed += 1;
      return { name: admin.name, email: admin.email, password };
    });

  return {
    origin: base,
    platformUrl: `${base}/platform/login`,
    workspaces,
    operators,
    changed
  };
}
