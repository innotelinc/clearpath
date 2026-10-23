import { db, getTenantById } from "./db.js";
import { randomToken, safeEqual, sha256, verifyPassword } from "./security.js";

const COOKIE = "cp_session";
const CSRF_COOKIE = "cp_csrf";
const SESSION_DAYS = 14;
const SECURE =
  process.env.COOKIE_SECURE === "1" ||
  (process.env.NODE_ENV === "production" && process.env.COOKIE_SECURE !== "0");

export function parseCookies(header = "") {
  const out = {};
  String(header)
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((part) => {
      const at = part.indexOf("=");
      if (at < 0) return;
      out[part.slice(0, at)] = decodeURIComponent(part.slice(at + 1));
    });
  return out;
}

function cookie(name, value, { maxAge, httpOnly = true } = {}) {
  const bits = [`${name}=${encodeURIComponent(value)}`, "Path=/", "SameSite=Lax"];
  if (httpOnly) bits.push("HttpOnly");
  if (SECURE) bits.push("Secure");
  if (typeof maxAge === "number") bits.push(`Max-Age=${maxAge}`);
  return bits.join("; ");
}

export function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", [
    cookie(COOKIE, "", { maxAge: 0 }),
    cookie(CSRF_COOKIE, "", { maxAge: 0 })
  ]);
}

export function issueSession(res, user) {
  const token = randomToken(32);
  const csrf = randomToken(24);
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000);
  db.prepare(
    "INSERT INTO sessions (id, user_id, tenant_id, csrf, expires_at) VALUES (?, ?, ?, ?, ?)"
  ).run(sha256(token), user.id, user.tenant_id, csrf, expires.toISOString());
  db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(new Date().toISOString(), user.id);
  res.setHeader("Set-Cookie", [
    cookie(COOKIE, token, { maxAge: SESSION_DAYS * 86400 }),
    cookie(CSRF_COOKIE, csrf, { maxAge: SESSION_DAYS * 86400 })
  ]);
  return { token, csrf };
}

export function destroySession(req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) db.prepare("DELETE FROM sessions WHERE id = ?").run(sha256(token));
  clearSessionCookie(res);
}

export function attachSession(req, res, next) {
  req.cookies = parseCookies(req.headers.cookie);
  const token = req.cookies[COOKIE];
  res.locals.user = null;
  res.locals.tenant = null;
  res.locals.csrf = req.cookies[CSRF_COOKIE] || "";

  if (token) {
    const row = db
      .prepare(
        `SELECT s.id AS session_id, s.csrf, s.expires_at, u.*, t.slug AS tenant_slug, t.name AS tenant_name,
                t.brand_name, t.accent, t.logo, t.portal_name, t.support_email, t.support_phone, t.address,
                t.tagline, t.welcome, t.domain
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         JOIN tenants t ON t.id = u.tenant_id
         WHERE s.id = ?`
      )
      .get(sha256(token));

    if (row && new Date(row.expires_at) > new Date()) {
      req.session = { id: row.session_id, csrf: row.csrf };
      req.user = {
        id: row.id,
        tenant_id: row.tenant_id,
        email: row.email,
        name: row.name,
        role: row.role,
        client_id: row.client_id
      };
      req.tenant = getTenantById(row.tenant_id);
      res.locals.user = req.user;
      res.locals.tenant = req.tenant;
      res.locals.csrf = row.csrf;
    } else if (row) {
      db.prepare("DELETE FROM sessions WHERE id = ?").run(row.session_id);
    }
  }

  const desired = req.session ? req.session.csrf : req.cookies[CSRF_COOKIE] || randomToken(24);
  if (req.cookies[CSRF_COOKIE] !== desired) {
    const existing = res.getHeader("Set-Cookie");
    const list = existing ? (Array.isArray(existing) ? existing : [existing]) : [];
    res.setHeader("Set-Cookie", list.concat(cookie(CSRF_COOKIE, desired, { maxAge: SESSION_DAYS * 86400 })));
  }
  res.locals.csrf = desired;
  next();
}

export function requireUser(roles = []) {
  return (req, res, next) => {
    if (!req.user) {
      const target = roles.includes("client") ? "/portal/login" : "/login";
      return res.redirect(302, `${target}?next=${encodeURIComponent(req.originalUrl)}`);
    }
    if (req.user.role === "client" && !roles.includes("client")) {
      return res.redirect(302, "/portal");
    }
    if (req.user.role !== "client" && roles.includes("client")) {
      return res.redirect(302, "/app");
    }
    if (roles.length && !roles.includes(req.user.role)) {
      return res.status(403).render("error", {
        title: "Not allowed",
        status: 403,
        message: "Your account does not have access to this area."
      });
    }
    next();
  };
}

export function checkCsrf(req, res, next) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return next();
  // Same-origin check as defence in depth. A literal "null" origin (sandboxed iframe,
  // some redirects) is allowed through to the token check below, which still has to pass.
  const origin = req.headers.origin;
  if (origin && origin !== "null") {
    try {
      if (new URL(origin).host !== req.headers.host) {
        return res.status(403).render("error", {
          title: "Request blocked", status: 403,
          message: "Cross-site form submissions are not accepted."
        });
      }
    } catch {
      return res.status(403).render("error", {
        title: "Request blocked", status: 403,
        message: "This form was submitted from an origin we could not verify. Reload the page and try again."
      });
    }
  }
  const expected = res.locals.csrf;
  const formToken = (req.body && req.body._csrf) || req.headers["x-csrf-token"];
  if (!expected || !formToken || !safeEqual(expected, formToken)) {
    return res.status(403).render("error", {
      title: "Session expired",
      status: 403,
      message: "Refresh the page and try again — the security token for this form no longer matches."
    });
  }
  next();
}

const attempts = new Map();

export function throttleLogin(key) {
  const now = Date.now();
  const entry = attempts.get(key) || { count: 0, first: now };
  if (now - entry.first > 15 * 60 * 1000) {
    entry.count = 0;
    entry.first = now;
  }
  entry.count += 1;
  attempts.set(key, entry);
  return entry.count > 10;
}

export function clearLoginAttempts(key) {
  attempts.delete(key);
}

export function authenticate(tenantId, email, password, expectedRoles = []) {
  const user = db
    .prepare("SELECT * FROM users WHERE tenant_id = ? AND lower(email) = lower(?)")
    .get(tenantId, String(email || "").trim());
  if (!user) return null;
  if (expectedRoles.length && !expectedRoles.includes(user.role)) return null;
  if (!verifyPassword(password, user.password_salt, user.password_hash)) return null;
  return user;
}
