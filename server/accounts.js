import { audit, db } from "./db.js";
import { sendMail, mailConfigured } from "./mail.js";
import { hashPassword, randomToken, sha256, strongEnough, temporaryPassword } from "./security.js";

const RESET_TTL_MINUTES = 60;

/**
 * Absolute origin used in emailed links. APP_ORIGIN always wins; otherwise we
 * only trust the request Host when it is a loopback address or the tenant's own
 * domain, so a spoofed Host header cannot redirect a reset token elsewhere.
 */
export function originFor(req) {
  const configured = String(process.env.APP_ORIGIN || "").trim().replace(/\/+$/, "");
  if (configured) return configured;

  const host = String(req?.headers?.host || "").toLowerCase();
  const domain = String(req?.tenant?.domain || "").toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const loopback = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);

  if (host && (loopback || (domain && host.split(":")[0] === domain))) {
    return `${req.protocol || "http"}://${host}`;
  }
  if (domain) return `https://${domain}`;
  return `http://localhost:${process.env.PORT || 3000}`;
}

export function createAccount({ tenantId, name, email, role, clientId = null }) {
  const password = temporaryPassword();
  const { hash, salt } = hashPassword(password);
  const info = db
    .prepare(
      `INSERT INTO users (tenant_id, email, name, role, client_id, password_hash, password_salt, must_change_password)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
    )
    .run(tenantId, String(email).trim().toLowerCase(), String(name).trim().slice(0, 80), role, clientId, hash, salt);
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(Number(info.lastInsertRowid));
  return { user, password };
}

export function setPassword(userId, password) {
  const { hash, salt } = hashPassword(password);
  db.prepare("UPDATE users SET password_hash = ?, password_salt = ?, must_change_password = 0 WHERE id = ?").run(
    hash,
    salt,
    Number(userId)
  );
}

/** Any outstanding token for the user is invalidated when a new one is issued. */
export function issueReset({ userId, tenantId, ip = "", ttlMinutes = RESET_TTL_MINUTES }) {
  const stamp = new Date().toISOString();
  db.prepare("UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL").run(stamp, Number(userId));
  const token = randomToken(32);
  const expires = new Date(Date.now() + ttlMinutes * 60_000);
  db.prepare(
    "INSERT INTO password_resets (tenant_id, user_id, token_hash, expires_at, requested_ip) VALUES (?, ?, ?, ?, ?)"
  ).run(Number(tenantId), Number(userId), sha256(token), expires.toISOString(), String(ip).slice(0, 60));
  return { token, expiresAt: expires };
}

export function findReset(token) {
  if (!token || String(token).length < 20) return null;
  const row = db
    .prepare(
      `SELECT r.id AS reset_id, r.expires_at, r.used_at,
              u.id AS user_id, u.name, u.email, u.role, u.client_id, u.tenant_id,
              t.slug AS tenant_slug, t.brand_name, t.portal_name, t.support_email
       FROM password_resets r
       JOIN users u ON u.id = r.user_id
       JOIN tenants t ON t.id = r.tenant_id
       WHERE r.token_hash = ?`
    )
    .get(sha256(String(token)));
  if (!row || row.used_at) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return row;
}

/**
 * Consume a reset token: set the new password, mark the token used and drop
 * every existing session for that account. Returns the reset row or null.
 */
export function consumeReset(token, password) {
  const row = findReset(token);
  if (!row) return null;
  setPassword(row.user_id, password);
  db.prepare("UPDATE password_resets SET used_at = ? WHERE id = ?").run(new Date().toISOString(), row.reset_id);
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(row.user_id);
  return row;
}

export function emailDeliveryNote(row) {
  if (!row) return "Email was not queued.";
  if (row.status === "sent") return `Emailed to ${row.to_email}.`;
  if (row.status === "failed") return `Email to ${row.to_email} failed — open Mail log to retry.`;
  return mailConfigured
    ? `Queued for ${row.to_email}.`
    : `Stored in the Mail log for ${row.to_email} — no mail provider is configured yet.`;
}

function firstName(name) {
  return String(name || "there").trim().split(/\s+/)[0];
}

export async function sendCredentials({ tenant, req, user, password, role }) {
  const origin = originFor(req);
  const isClient = role === "client";
  const link = `${origin}${isClient ? "/portal/login" : "/login"}`;
  const portalName = isClient ? tenant.portal_name || "client portal" : "Clearpath workspace";
  const text = [
    `Hi ${firstName(user.name)},`,
    `${tenant.brand_name} created a ${portalName} account for you.`,
    `Sign in: ${link}`,
    `Email: ${user.email}`,
    `Temporary password: ${password}`,
    "You will be asked to choose your own password the first time you sign in. If you were not expecting this email, tell the agency that invited you.",
    `— ${tenant.brand_name}${tenant.support_email ? ` · ${tenant.support_email}` : ""}`
  ].join("\n\n");

  return sendMail({
    tenantId: tenant.id,
    userId: user.id,
    to: user.email,
    subject: `Your ${tenant.brand_name} ${isClient ? "portal" : "workspace"} sign-in`,
    kind: "credentials",
    text,
    link
  });
}

export async function sendResetLink({ tenant, req, user, ip = "" }) {
  const { token, expiresAt } = issueReset({ userId: user.id, tenantId: tenant.id, ip });
  const link = `${originFor(req)}/reset/${token}`;
  const minutes = Math.round((expiresAt.getTime() - Date.now()) / 60_000);
  const text = [
    `Hi ${firstName(user.name)},`,
    `Use the link below to choose a new password for your ${tenant.brand_name} account. It works once and expires in ${minutes} minutes.`,
    link,
    `If you did not ask for this, you can ignore the email — your current password still works.`,
    `— ${tenant.brand_name}${tenant.support_email ? ` · ${tenant.support_email}` : ""}`
  ].join("\n\n");

  const row = await sendMail({
    tenantId: tenant.id,
    userId: user.id,
    to: user.email,
    subject: `Reset your ${tenant.brand_name} password`,
    kind: "password-reset",
    text,
    link
  });
  audit(tenant.id, "Clearpath", "Issued a password reset link for", user.email);
  return { row, expiresAt };
}

export function passwordProblem(password) {
  if (!strongEnough(password)) return "Use at least 10 characters with letters and a number.";
  return "";
}
