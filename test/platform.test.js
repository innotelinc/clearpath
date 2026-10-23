import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const PORT = Number(process.env.TEST_PLATFORM_PORT || 3918);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "clearpath-platform-test-"));
const dbPath = path.join(dataDir, "test.db");
let child;
let db;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForServer() {
  for (let i = 0; i < 120; i += 1) {
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
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const line of raw) {
    const pair = line.split(";")[0];
    const at = pair.indexOf("=");
    if (at > 0) jar.set(pair.slice(0, at), pair.slice(at + 1));
  }
}

function cookieHeader(jar) {
  return Array.from(jar, ([k, v]) => `${k}=${v}`).join("; ");
}

async function http(pathname, { method = "GET", form, jar } = {}) {
  const headers = {};
  if (jar) headers.cookie = cookieHeader(jar);
  let body;
  if (form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(form).toString();
  }
  const res = await fetch(`${BASE}${pathname}`, { method, headers, body, redirect: "manual" });
  if (jar) readCookies(res, jar);
  return { status: res.status, location: res.headers.get("location"), body: await res.text() };
}

async function platformSignIn(email = "platform@clearpath.test", password = "Platform!2026") {
  const jar = new Map();
  const page = await http("/platform/login", { jar });
  assert.equal(page.status, 200);
  const csrf = jar.get("cp_csrf");
  assert.ok(csrf, "platform login should set a CSRF cookie");
  const res = await http("/platform/login", {
    method: "POST",
    jar,
    form: { _csrf: csrf, email, password, next: "/platform" }
  });
  return { jar, res };
}

async function agencySignIn(email = "dana@denovocredit.com", password = "Denovo!2026") {
  const jar = new Map();
  const page = await http("/login", { jar });
  assert.equal(page.status, 200);
  const csrf = jar.get("cp_csrf");
  const res = await http("/login", {
    method: "POST",
    jar,
    form: { _csrf: csrf, email, password, next: "/app" }
  });
  return { jar, res };
}

before(async () => {
  child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server/index.js"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: dataDir,
      DB_PATH: dbPath,
      SEED_DEMO: "1",
      COOKIE_SECURE: "0",
      NODE_ENV: "test",
      PLATFORM_ADMIN_EMAIL: "",
      PLATFORM_ADMIN_PASSWORD: "",
      OMNIROUTE_API_KEY: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  await waitForServer();
  db = new DatabaseSync(dbPath);
});

after(async () => {
  try {
    db?.close();
  } catch {
    /* already closed */
  }
  if (child) {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
      return;
    } catch {
      await sleep(200);
    }
  }
});

test("the platform console is behind its own sign-in", async () => {
  const res = await http("/platform");
  assert.equal(res.status, 302);
  assert.match(res.location, /^\/platform\/login/);

  const page = await http("/platform/login");
  assert.equal(page.status, 200);
  assert.match(page.body, /Operator sign-in/);
  assert.match(page.body, /platform@clearpath\.test/, "demo operator should be discoverable while seeding is on");
});

test("a wrong platform password is rejected", async () => {
  const { res } = await platformSignIn("platform@clearpath.test", "wrong-password");
  assert.equal(res.status, 401);
  assert.match(res.body, /do not match a platform account/);
});

test("the operator sees every tenant with usage counts", async () => {
  const { jar, res } = await platformSignIn();
  assert.equal(res.status, 303);
  assert.equal(res.location, "/platform");

  const list = await http("/platform", { jar });
  assert.equal(list.status, 200);
  assert.match(list.body, /Denovo Credit/);
  assert.match(list.body, /Northstar Credit Group/);
  assert.match(list.body, /Tenant list/);
});

test("provisioning a tenant creates it with a first owner invite", async () => {
  const { jar } = await platformSignIn();
  const page = await http("/platform/tenants/new", { jar });
  assert.equal(page.status, 200);
  const csrf = jar.get("cp_csrf");

  const created = await http("/platform/tenants", {
    method: "POST",
    jar,
    form: {
      _csrf: csrf,
      name: "Harbor Credit Co",
      slug: "harbor",
      domain: "harbor.clearpath.test",
      brand_name: "Harbor Credit",
      owner_name: "Riley Chen",
      owner_email: "riley@harbor.test"
    }
  });
  assert.equal(created.status, 201);
  assert.match(created.body, /riley@harbor\.test/);
  assert.match(created.body, /temporary password/i, "with no mail provider the temp password is shown once");

  const tenant = db.prepare("SELECT * FROM tenants WHERE slug = ?").get("harbor");
  assert.ok(tenant, "tenant row exists");
  assert.equal(tenant.status, "active");

  const owner = db
    .prepare("SELECT * FROM users WHERE tenant_id = ? AND lower(email) = ?")
    .get(tenant.id, "riley@harbor.test");
  assert.ok(owner, "owner account exists");
  assert.equal(owner.role, "owner");
  assert.equal(owner.must_change_password, 1);

  const queue = db.prepare("SELECT * FROM emails WHERE tenant_id = ? AND kind = 'credentials'").all(tenant.id);
  assert.ok(queue.length >= 1, "the invitation is queued in the tenant's mail log");
});

test("suspending a tenant signs everyone out and blocks sign-in until reactivated", async () => {
  const denovo = db.prepare("SELECT * FROM tenants WHERE slug = 'denovo'").get();
  const { jar: ownerJar } = await agencySignIn();
  const before = await http("/app", { jar: ownerJar });
  assert.equal(before.status, 200);

  const { jar } = await platformSignIn();
  const tenantPage = await http(`/platform/tenants/${denovo.id}`, { jar });
  assert.equal(tenantPage.status, 200);

  const suspended = await http(`/platform/tenants/${denovo.id}/suspend`, {
    method: "POST",
    jar,
    form: { _csrf: jar.get("cp_csrf"), note: "Non-payment review" }
  });
  assert.equal(suspended.status, 303);

  const after = db.prepare("SELECT * FROM tenants WHERE id = ?").get(denovo.id);
  assert.equal(after.status, "suspended");
  assert.equal(after.suspended_note, "Non-payment review");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE tenant_id = ?").get(denovo.id).n, 0);

  const blocked = await agencySignIn();
  assert.equal(blocked.res.status, 403);
  assert.match(blocked.res.body, /suspended/i);

  const reactivated = await http(`/platform/tenants/${denovo.id}/reactivate`, {
    method: "POST",
    jar,
    form: { _csrf: jar.get("cp_csrf") }
  });
  assert.equal(reactivated.status, 303);
  assert.equal(db.prepare("SELECT status FROM tenants WHERE id = ?").get(denovo.id).status, "active");

  const allowed = await agencySignIn();
  assert.equal(allowed.res.status, 303);
  assert.equal(allowed.res.location, "/app");
});

test("the automation drafts, then approves a batch into the mailroom", async () => {
  const { jar } = await agencySignIn();
  const page = await http("/app/pipeline", { jar });
  assert.equal(page.status, 200);
  assert.match(page.body, /Dispute pipeline/);

  const run = await http("/app/pipeline/run", {
    method: "POST",
    jar,
    form: { _csrf: jar.get("cp_csrf") }
  });
  assert.equal(run.status, 303);

  const ready = db.prepare("SELECT d.* FROM drafts d WHERE d.status = 'Ready'").all();
  assert.ok(ready.length > 0, "the pipeline should draft at least one letter");

  const beforeDisputes = db.prepare("SELECT COUNT(*) AS n FROM disputes").get().n;
  const beforePackages = db.prepare("SELECT COUNT(*) AS n FROM packages").get().n;

  const approve = await http("/app/pipeline/approve", {
    method: "POST",
    jar,
    form: { _csrf: jar.get("cp_csrf") }
  });
  assert.equal(approve.status, 303);
  assert.match(approve.location, /^\/app\/mailroom/);

  const afterDisputes = db.prepare("SELECT COUNT(*) AS n FROM disputes").get().n;
  const afterPackages = db.prepare("SELECT COUNT(*) AS n FROM packages").get().n;
  assert.equal(afterDisputes - beforeDisputes, ready.length);
  assert.ok(afterPackages > beforePackages, "approved letters are grouped into packages");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM drafts WHERE status = 'Ready'").get().n, 0);
  assert.ok(
    db.prepare("SELECT COUNT(*) AS n FROM package_items").get().n > 0,
    "packages carry their letters"
  );
});

test("AI actions explain the missing gateway instead of failing silently", async () => {
  const { jar } = await agencySignIn();
  const tradeline = db.prepare("SELECT * FROM tradelines ORDER BY id LIMIT 1").get();

  const first = await http("/app/pipeline", { jar });
  assert.equal(first.status, 200);
  const generated = await http("/app/studio/generate", {
    method: "POST",
    jar,
    form: {
      _csrf: jar.get("cp_csrf"),
      tradeline_id: String(tradeline.id),
      strategy: "fcra-611",
      tone: "Professional",
      evidence: "on",
      citations: "on"
    }
  });
  assert.equal(generated.status, 303);
  const draft = db.prepare("SELECT * FROM drafts ORDER BY id DESC LIMIT 1").get();
  assert.ok(draft, "studio draft created");

  const refine = await http(`/app/studio/${draft.id}/refine`, {
    method: "POST",
    jar,
    form: { _csrf: jar.get("cp_csrf"), instruction: "Shorten it" }
  });
  assert.equal(refine.status, 303);
  assert.match(decodeURIComponent(refine.location), /OmniRoute is not configured/);

  const clientId = db.prepare("SELECT id FROM clients ORDER BY id LIMIT 1").get().id;
  const analyze = await http(`/app/clients/${clientId}/analyze`, {
    method: "POST",
    jar,
    form: { _csrf: jar.get("cp_csrf") }
  });
  assert.equal(analyze.status, 303);
  assert.match(decodeURIComponent(analyze.location), /OmniRoute is not configured/);
});

test("a mailed package stores what was sent and links the tracking number", async () => {
  const { jar } = await agencySignIn();
  const pkg = db.prepare("SELECT * FROM packages WHERE status = 'Ready' ORDER BY id LIMIT 1").get();
  assert.ok(pkg, "the pipeline should have created a package");

  const tracking = "9405 5118 9956 0000 0000 42";
  const mailed = await http(`/app/mailroom/${pkg.id}/mailed`, {
    method: "POST",
    jar,
    form: { _csrf: jar.get("cp_csrf"), tracking }
  });
  assert.equal(mailed.status, 303);

  const stored = db.prepare("SELECT * FROM package_letters WHERE package_id = ?").all(pkg.id);
  assert.ok(stored.length > 0, "letters are captured at mailing time");
  assert.match(stored[0].body, /dispute/i);
  assert.equal(db.prepare("SELECT status FROM packages WHERE id = ?").get(pkg.id).status, "In transit");
  assert.ok(db.prepare("SELECT sent_at FROM packages WHERE id = ?").get(pkg.id).sent_at);

  const page = await http(`/app/mailroom/${pkg.id}`, { jar });
  assert.equal(page.status, 200);
  assert.match(page.body, /What was sent/);
  assert.match(page.body, /Stored as sent/);
  assert.match(page.body, /tools\.usps\.com\/go\/TrackConfirmAction\?tLabels=9405511899560000000042/);

  const list = await http("/app/mailroom", { jar });
  assert.equal(list.status, 200);
  assert.match(list.body, /Track/);
  assert.match(list.body, /9405 5118 9956 0000 0000 42/);
});
