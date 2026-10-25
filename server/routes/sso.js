/**
 * Operator sign-in through Authentik.
 *
 * Two GET routes: one sends the browser to the provider, one receives the code
 * back and turns a group membership into a platform session. Nothing here
 * creates a tenant account — a federated identity is an operator, and only
 * when the provider says it is in the configured group.
 */
import { Router } from "express";
import { db } from "../db.js";
import { randomToken, hashPassword } from "../security.js";
import { issuePlatformSession } from "../platform-auth.js";
import { adminGroup, beginLogin, completeLogin, ssoConfigured } from "../oidc.js";

const router = Router();

function deny(res, message) {
  console.warn(`Clearpath: Authentik sign-in refused — ${message}`);
  return res.redirect(303, `/platform/login?error=${encodeURIComponent(message)}`);
}

/**
 * The operator row for an Authentik identity, created on first sign-in.
 *
 * The password columns are filled with a 32-byte random secret nobody knows, so
 * the account cannot be used on the password form; the provider stays the only
 * way in. The row is what sessions, `last_login_at` and the audit trail hang off.
 */
function operatorFor(email, name) {
  const clean = String(email || "").trim().toLowerCase();
  const existing = db.prepare("SELECT * FROM platform_admins WHERE lower(email) = lower(?)").get(clean);
  if (existing) return existing;
  const { hash, salt } = hashPassword(randomToken(32));
  const info = db
    .prepare("INSERT INTO platform_admins (email, name, password_hash, password_salt) VALUES (?, ?, ?, ?)")
    .run(clean, String(name || clean).slice(0, 80), hash, salt);
  return db.prepare("SELECT * FROM platform_admins WHERE id = ?").get(Number(info.lastInsertRowid));
}

router.get("/auth/authentik", async (req, res) => {
  if (!ssoConfigured()) {
    return res.redirect(303, `/platform/login?error=${encodeURIComponent("Authentik sign-in is not configured on this deployment.")}`);
  }
  try {
    const { url } = await beginLogin("/platform");
    res.redirect(302, url);
  } catch (err) {
    deny(res, `Authentik sign-in could not start: ${err?.message || err}`);
  }
});

router.get("/auth/authentik/callback", async (req, res) => {
  if (typeof req.query.error === "string" && req.query.error) {
    return deny(res, `The identity provider reported ${req.query.error}.`);
  }
  const result = await completeLogin(req.query.state, req.query.code);
  if (!result.ok) return deny(res, result.reason);

  const wanted = adminGroup();
  const groups = result.user.groups.map((group) => group.toLowerCase());
  if (!wanted || !groups.includes(wanted.toLowerCase())) {
    return deny(res, `${result.user.email} is not in the ${wanted || "operator"} group.`);
  }

  const admin = operatorFor(result.user.email, result.user.name);
  issuePlatformSession(res, admin);
  console.log(`Clearpath: platform operator ${admin.email} signed in via Authentik`);
  res.redirect(303, "/platform");
});

export default router;
