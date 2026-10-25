/**
 * Authentik (OIDC) sign-in for platform operators.
 *
 * The deployment's identity provider is the estate's Authentik, and operators
 * already hold an account there, so the console does not need a second
 * password. This is the authorization-code flow with PKCE, written against
 * Node's own fetch so the app keeps its four dependencies.
 *
 * Only the operator surface is federated. Workspace and portal accounts stay
 * local: a tenant user is created by the agency that owns it, which Authentik
 * does not know about.
 *
 *   AUTHENTIK_ISSUER_URL    https://auth.example.com/application/o/clearpath/
 *   AUTHENTIK_CLIENT_ID     the application's client id
 *   AUTHENTIK_CLIENT_SECRET its client secret
 *   AUTHENTIK_ADMIN_GROUP   group that may operate the console (default
 *                           `cerulean-platform`, the estate's platform admins)
 *
 * Pending authorizations live in memory with a ten-minute life, which matches
 * the app's single-instance shape (the login throttle is in memory too).
 */
import crypto from "node:crypto";

const PENDING_TTL = 10 * 60 * 1000;
const DISCOVERY_TTL = 60 * 60 * 1000;

const pending = new Map();
let discovery = { at: 0, value: null };

const issuer = () => String(process.env.AUTHENTIK_ISSUER_URL || "").trim().replace(/\/*$/, "/");
const clientId = () => String(process.env.AUTHENTIK_CLIENT_ID || "").trim();
const clientSecret = () => String(process.env.AUTHENTIK_CLIENT_SECRET || "").trim();

/** The group whose members may open the platform console. */
export const adminGroup = () => String(process.env.AUTHENTIK_ADMIN_GROUP || "cerulean-platform").trim();

export function ssoConfigured() {
  return Boolean(issuer() && clientId() && clientSecret());
}

/** The redirect URI registered on the Authentik application. */
export function callbackUrl(origin = "") {
  const base = String(process.env.APP_ORIGIN || origin || "http://localhost:3000").replace(/\/+$/, "");
  return `${base}/auth/authentik/callback`;
}

async function metadata() {
  if (discovery.value && Date.now() - discovery.at < DISCOVERY_TTL) return discovery.value;
  const url = `${issuer()}.well-known/openid-configuration`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`OIDC discovery failed (${res.status}) at ${url}`);
  const doc = await res.json();
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.userinfo_endpoint) {
    throw new Error("OIDC discovery is missing an endpoint");
  }
  discovery = { at: Date.now(), value: doc };
  return doc;
}

/** Start a sign-in: returns the Authentik URL to send the browser to. */
export async function beginLogin(redirectTo = "/platform") {
  const meta = await metadata();
  for (const [state, entry] of pending) {
    if (entry.expires < Date.now()) pending.delete(state);
  }
  const state = crypto.randomBytes(24).toString("hex");
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  pending.set(state, { verifier, redirectTo, expires: Date.now() + PENDING_TTL });

  const url = new URL(meta.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId());
  url.searchParams.set("redirect_uri", callbackUrl());
  url.searchParams.set("scope", "openid email profile groups");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return { url: url.toString(), state };
}

/**
 * Finish a sign-in. Errors are returned, never thrown, so the route can show a
 * message rather than a stack trace.
 *
 * @returns {{ok: true, redirectTo: string, user: {subject: string, email: string, name: string, groups: string[]}} | {ok: false, reason: string}}
 */
export async function completeLogin(state, code) {
  const entry = pending.get(String(state || ""));
  if (!entry || entry.expires < Date.now()) {
    pending.delete(String(state || ""));
    return { ok: false, reason: "This sign-in link has expired. Start again." };
  }
  pending.delete(String(state || ""));

  try {
    const meta = await metadata();
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: String(code || ""),
      redirect_uri: callbackUrl(),
      client_id: clientId(),
      code_verifier: entry.verifier
    });
    const basic = Buffer.from(`${clientId()}:${clientSecret()}`).toString("base64");
    const tokenRes = await fetch(meta.token_endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${basic}`,
        accept: "application/json"
      },
      body
    });
    if (!tokenRes.ok) {
      return { ok: false, reason: `The identity provider refused the code (${tokenRes.status}).` };
    }
    const tokens = await tokenRes.json();
    if (!tokens.access_token) return { ok: false, reason: "The identity provider returned no access token." };

    const infoRes = await fetch(meta.userinfo_endpoint, {
      headers: { authorization: `Bearer ${tokens.access_token}`, accept: "application/json" }
    });
    if (!infoRes.ok) return { ok: false, reason: `Could not read the identity profile (${infoRes.status}).` };
    const claims = await infoRes.json();

    const email = String(claims.email || "").trim().toLowerCase();
    if (!email) return { ok: false, reason: "That account has no email address, which the console needs." };

    return {
      ok: true,
      redirectTo: entry.redirectTo,
      user: {
        subject: String(claims.sub || ""),
        email,
        name: String(claims.name || claims.preferred_username || email).slice(0, 80),
        groups: Array.isArray(claims.groups) ? claims.groups.map(String) : []
      }
    };
  } catch (err) {
    return { ok: false, reason: `Could not reach the identity provider: ${err?.message || err}` };
  }
}

/** Test hook: forget the cached discovery document and pending authorizations. */
export function resetSsoState() {
  pending.clear();
  discovery = { at: 0, value: null };
}
