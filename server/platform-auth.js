/**
 * Platform operator sessions.
 *
 * Operators sit above the tenants, so they cannot be ordinary users: `users`
 * rows belong to exactly one workspace. Their sessions are stored separately
 * and carried in their own cookie, which also means suspending a workspace
 * cannot lock an operator out of the console.
 */
import { db } from "./db.js";
import { randomToken, safeEqual, sha256, verifyPassword } from "./security.js";

export const PLATFORM_COOKIE = "cp_platform";
const SESSION_DAYS = 7;
const SECURE =
  process.env.COOKIE_SECURE === "1" ||
  (process.env.NODE_ENV === "production" && process.env.COOKIE_SECURE !== "0");

function cookie(value, maxAge) {
  const bits = [`${PLATFORM_COOKIE}=${encodeURIComponent(value)}`, "Path=/", "SameSite=Lax", "HttpOnly"];
  if (SECURE) bits.push("Secure");
  if (typeof maxAge === "number") bits.push(`Max-Age=${maxAge}`);
  return bits.join("; ");
}

export function clearPlatformCookie(res) {
  const existing = res.getHeader("Set-Cookie");
  const list = existing ? (Array.isArray(existing) ? existing : [existing]) : [];
  res.setHeader("Set-Cookie", list.concat(cookie("", 0)));
}

export function issuePlatformSession(res, admin) {
  const token = randomToken(32);
  const csrf = randomToken(24);
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000);
  db.prepare("DELETE FROM platform_sessions WHERE expires_at < ?").run(new Date().toISOString());
  db.prepare("INSERT INTO platform_sessions (id, admin_id, csrf, expires_at) VALUES (?, ?, ?, ?)").run(
    sha256(token),
    admin.id,
    csrf,
    expires.toISOString()
  );
  db.prepare("UPDATE platform_admins SET last_login_at = ? WHERE id = ?").run(new Date().toISOString(), admin.id);
  const existing = res.getHeader("Set-Cookie");
  const list = existing ? (Array.isArray(existing) ? existing : [existing]) : [];
  res.setHeader("Set-Cookie", list.concat(cookie(token, SESSION_DAYS * 86400)));
  return { token, csrf };
}

/** Resolve a cookie token to { admin, csrf, sessionId } or null. */
export function findPlatformSession(token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT s.id AS session_id, s.csrf, s.expires_at, a.id, a.email, a.name, a.last_login_at
       FROM platform_sessions s JOIN platform_admins a ON a.id = s.admin_id
       WHERE s.id = ?`
    )
    .get(sha256(String(token)));
  if (!row) return null;
  if (new Date(row.expires_at) <= new Date()) {
    db.prepare("DELETE FROM platform_sessions WHERE id = ?").run(row.session_id);
    return null;
  }
  return {
    sessionId: row.session_id,
    csrf: row.csrf,
    admin: { id: row.id, email: row.email, name: row.name, last_login_at: row.last_login_at }
  };
}

export function destroyPlatformSession(req, res) {
  const raw = String(req.cookies?.[PLATFORM_COOKIE] || "");
  if (raw) db.prepare("DELETE FROM platform_sessions WHERE id = ?").run(sha256(raw));
  clearPlatformCookie(res);
}

export function authenticatePlatform(email, password) {
  const admin = db
    .prepare("SELECT * FROM platform_admins WHERE lower(email) = lower(?)")
    .get(String(email || "").trim());
  if (!admin) return null;
  if (!verifyPassword(password, admin.password_salt, admin.password_hash)) return null;
  return admin;
}

export function requirePlatform(req, res, next) {
  if (!req.platformAdmin) {
    return res.redirect(302, `/platform/login?next=${encodeURIComponent(req.originalUrl)}`);
  }
  next();
}

export function platformAdminCount() {
  return db.prepare("SELECT COUNT(*) AS n FROM platform_admins").get().n;
}

export function demoPlatformAdmin() {
  return db
    .prepare("SELECT id, email FROM platform_admins WHERE email = ?")
    .get("platform@clearpath.test");
}

export { safeEqual };
