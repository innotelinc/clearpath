import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import nodeHttp from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Authentik is the deployment's identity provider, so the suite needs one it can
 * talk to. This stub answers discovery, the token exchange and userinfo, and the
 * user it returns is configured per test — enough to prove the flow, the group
 * gate, and that a federated operator is created once and reused.
 */
function startIdpStub() {
  const state = { user: null, tokenExchanges: 0, discoveryFetches: 0, lastAuthorize: null };
  const server = nodeHttp.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const json = (body, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/.well-known/openid-configuration") {
      state.discoveryFetches += 1;
      const base = `http://127.0.0.1:${server.address().port}`;
      json({
        issuer: `${base}/`,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        userinfo_endpoint: `${base}/userinfo`
      });
      return;
    }
    if (url.pathname === "/token") {
      state.tokenExchanges += 1;
      json({ access_token: "stub-access-token", token_type: "Bearer", expires_in: 300 });
      return;
    }
    if (url.pathname === "/userinfo") {
      json(state.user || {});
      return;
    }
    if (url.pathname === "/authorize") {
      state.lastAuthorize = url.search;
      res.writeHead(302, { location: "/" });
      res.end();
      return;
    }
    json({ error: "not_found" }, 404);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        state,
        port: server.address().port,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          })
      });
    });
  });
}

const PORT = Number(process.env.TEST_SSO_PORT || 3921);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "clearpath-sso-test-"));
let child;
let idp;
let inspect;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForServer() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return;
    } catch {
      /* not listening yet */
    }
    await sleep(100);
  }
  throw new Error("server did not become ready");
}

function readCookies(res, jar) {
  for (const line of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
    const pair = line.split(";")[0];
    const at = pair.indexOf("=");
    if (at > 0) jar.set(pair.slice(0, at), pair.slice(at + 1));
  }
}

async function http(pathname, { jar } = {}) {
  const headers = {};
  if (jar) headers.cookie = Array.from(jar, ([k, v]) => `${k}=${v}`).join("; ");
  const res = await fetch(`${BASE}${pathname}`, { headers, redirect: "manual" });
  if (jar) readCookies(res, jar);
  return { status: res.status, location: res.headers.get("location"), body: await res.text() };
}

/** Sign in through the stub: returns the callback redirect and the session jar. */
async function ssoSignIn(user) {
  idp.state.user = user;
  const jar = new Map();
  const start = await http("/auth/authentik", { jar });
  assert.equal(start.status, 302, "the start route should redirect to the provider");
  const authorize = new URL(start.location);
  const state = authorize.searchParams.get("state");
  assert.ok(state, "the redirect carries a state");
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  assert.ok(authorize.searchParams.get("code_challenge"), "PKCE is used");
  assert.equal(authorize.searchParams.get("redirect_uri"), `${BASE}/auth/authentik/callback`);
  const done = await http(`/auth/authentik/callback?code=stub-code&state=${encodeURIComponent(state)}`, { jar });
  return { jar, done };
}

before(async () => {
  idp = await startIdpStub();
  child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server/index.js"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: dataDir,
      DB_PATH: path.join(dataDir, "test.db"),
      SEED_DEMO: "0",
      COOKIE_SECURE: "0",
      NODE_ENV: "test",
      APP_ORIGIN: BASE,
      AUTHENTIK_ISSUER_URL: `http://127.0.0.1:${idp.port}/`,
      AUTHENTIK_CLIENT_ID: "clearpath",
      AUTHENTIK_CLIENT_SECRET: "stub-secret",
      AUTHENTIK_ADMIN_GROUP: "cerulean-platform"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  await waitForServer();
  inspect = new DatabaseSync(path.join(dataDir, "test.db"));
});

after(async () => {
  try {
    inspect?.close();
  } catch {
    /* already closed */
  }
  if (child) {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
  }
  await idp?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("the operator page offers Authentik when it is configured", async () => {
  const page = await http("/platform/login");
  assert.equal(page.status, 200);
  assert.match(page.body, /Sign in with Authentik/);
  assert.match(page.body, /cerulean-platform/);
});

test("an operator in the admin group gets a platform session", async () => {
  const { jar, done } = await ssoSignIn({
    sub: "abc123",
    email: "dhunter@innotel.us",
    name: "Darnel Hunter",
    groups: ["Mail", "cerulean-platform", "authentik Admins"]
  });
  assert.equal(done.status, 303);
  assert.equal(done.location, "/platform", "a successful sign-in lands in the console");
  assert.ok(jar.get("cp_platform"), "the platform cookie is issued");

  const console_ = await http("/platform", { jar });
  assert.equal(console_.status, 200);
  assert.match(console_.body, /Workspaces/);

  const row = inspect.prepare("SELECT email, name, last_login_at FROM platform_admins WHERE email = ?").get("dhunter@innotel.us");
  assert.ok(row, "the operator row is created on first sign-in");
  assert.equal(row.name, "Darnel Hunter");
  assert.ok(row.last_login_at, "the sign-in is recorded");
});

test("a second sign-in reuses the operator instead of duplicating it", async () => {
  const before = inspect.prepare("SELECT COUNT(*) AS n FROM platform_admins").get().n;
  const { done } = await ssoSignIn({
    sub: "abc123",
    email: "dhunter@innotel.us",
    name: "Darnel Hunter",
    groups: ["cerulean-platform"]
  });
  assert.equal(done.status, 303);
  const after_ = inspect.prepare("SELECT COUNT(*) AS n FROM platform_admins").get().n;
  assert.equal(after_, before, "the same email is one operator");
});

test("an identity outside the group is refused, with a reason", async () => {
  const { jar, done } = await ssoSignIn({
    sub: "def456",
    email: "someone@example.com",
    name: "Someone Else",
    groups: ["Mail"]
  });
  assert.equal(done.status, 303);
  assert.match(done.location, /^\/platform\/login\?error=/);
  assert.match(decodeURIComponent(done.location), /cerulean-platform/);
  assert.equal(jar.get("cp_platform"), undefined, "no session is issued");
  assert.equal(
    inspect.prepare("SELECT COUNT(*) AS n FROM platform_admins WHERE email = ?").get("someone@example.com").n,
    0,
    "a refused identity does not become an operator"
  );
});

test("an unknown state is refused rather than trusted", async () => {
  const res = await http("/auth/authentik/callback?code=stub-code&state=not-a-real-state");
  assert.equal(res.status, 303);
  assert.match(decodeURIComponent(res.location), /expired/);
});

test("a provider error is reported, not swallowed", async () => {
  const res = await http("/auth/authentik/callback?error=access_denied");
  assert.equal(res.status, 303);
  assert.match(decodeURIComponent(res.location), /access_denied/);
});
