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

/** Snapshot directories the destructive routes wrote, oldest first. */
function snapshots(suffix) {
  const root = path.join(dataDir, "backups");
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((name) => name.endsWith(`-${suffix}`))
    .sort()
    .map((name) => path.join(root, name));
}

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

test("workspace credentials on the operator form say to use the agency sign-in", async () => {
  const { jar, res } = await platformSignIn("dana@denovocredit.com", "Denovo!2026");
  assert.equal(res.status, 401);
  assert.match(res.body, /workspace account, not an operator/);
  assert.equal(jar.get("cp_platform"), undefined, "a rejected sign-in must not issue an operator cookie");
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

test("the console lists the demo sign-ins the seed actually created", async () => {
  const { jar } = await platformSignIn();
  const page = await http("/platform/credentials", { jar });
  assert.equal(page.status, 200);
  assert.match(page.body, /Demo sign-ins/);
  // The password shown is the one that works, not the one the seed meant: the
  // report verifies each candidate against the stored hash.
  assert.match(page.body, /Denovo!2026/);
  assert.match(page.body, /Client!2026/);
  assert.match(page.body, /Specialist!2026/);
  assert.match(page.body, /dana@denovocredit\.com/);
  assert.match(page.body, /amara@example\.com/);
  assert.match(page.body, /denovocredit\.com\/login/);
  assert.match(page.body, /denovocredit\.com\/portal\/login/);
  assert.match(page.body, /northstar\.clearpath\.test/);
  assert.match(page.body, /platform@clearpath\.test/);
  assert.match(page.body, /Platform!2026/);

  // A workspace owner signed in on the agency side is not an operator.
  const owner = await agencySignIn();
  const denied = await http("/platform/credentials", { jar: owner.jar });
  assert.equal(denied.status, 302);
  assert.match(denied.location, /^\/platform\/login/);
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

test("an operator can sign in while an agency session is open in the same browser", async () => {
  const { jar } = await agencySignIn();
  const page = await http("/platform/login", { jar });
  assert.equal(page.status, 200);

  const res = await http("/platform/login", {
    method: "POST",
    jar,
    form: {
      _csrf: jar.get("cp_csrf"),
      email: "platform@clearpath.test",
      password: "Platform!2026",
      next: "/platform"
    }
  });
  assert.equal(res.status, 303);
  assert.equal(res.location, "/platform");

  const list = await http("/platform", { jar });
  assert.equal(list.status, 200, "the operator session must win over the agency cookie on /platform");
  assert.match(list.body, /Tenant list/);

  // The workspace session is untouched by signing in as an operator.
  const workspace = await http("/app", { jar });
  assert.equal(workspace.status, 200);
});

test("deleting a workspace removes its clients, seats, documents and files", async () => {
  const { jar } = await platformSignIn();
  // The platform session's CSRF token is issued with the page, not with the cookie
  // the sign-in sets — every POST in this file reads the console first for that reason.
  await http("/platform/tenants/new", { jar });

  // A workspace of its own, so nothing else in this file is deleted with it.
  const created = await http("/platform/tenants", {
    method: "POST",
    jar,
    form: {
      _csrf: jar.get("cp_csrf"),
      name: "Temp Credit Co",
      slug: "temp-co",
      domain: "temp.clearpath.test",
      brand_name: "Temp Credit",
      owner_name: "Sam Patel",
      owner_email: "sam@temp.test"
    }
  });
  assert.equal(created.status, 201);
  const tenant = db.prepare("SELECT * FROM tenants WHERE slug = 'temp-co'").get();
  assert.ok(tenant, "the workspace exists before the delete");

  // Give it something to cascade to: a client, a document row and the file on disk.
  const clientId = Number(
    db
      .prepare("INSERT INTO clients (tenant_id, ref, name, email, joined) VALUES (?, 'CL-2001', 'Ava Brooks', 'ava@temp.test', '2026-10-01')")
      .run(tenant.id).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO documents (tenant_id, client_id, ref, name, type, sha256, stored_name, uploaded_at)
     VALUES (?, ?, 'DOC-2001', 'id.pdf', 'Identity', 'abc', 'temp-id.pdf', '2026-10-01')`
  ).run(tenant.id, clientId);
  const uploaded = path.join(dataDir, "uploads", "temp-id.pdf");
  fs.mkdirSync(path.dirname(uploaded), { recursive: true });
  fs.writeFileSync(uploaded, "not really a pdf");

  // A mis-click cannot delete: the confirmation is the slug, not a checkbox.
  const refused = await http(`/platform/tenants/${tenant.id}/delete`, {
    method: "POST",
    jar,
    form: { _csrf: jar.get("cp_csrf"), confirm: "yes" }
  });
  assert.equal(refused.status, 400);
  assert.match(refused.body, /Nothing was deleted/);
  assert.ok(db.prepare("SELECT id FROM tenants WHERE id = ?").get(tenant.id), "the workspace survives a wrong confirmation");

  const removed = await http(`/platform/tenants/${tenant.id}/delete`, {
    method: "POST",
    jar,
    form: { _csrf: jar.get("cp_csrf"), confirm: "temp-co" }
  });
  assert.equal(removed.status, 303);
  assert.match(decodeURIComponent(removed.location), /Temp Credit Co deleted/);

  assert.equal(db.prepare("SELECT id FROM tenants WHERE id = ?").get(tenant.id), undefined);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM clients WHERE tenant_id = ?").get(tenant.id).n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE tenant_id = ?").get(tenant.id).n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM documents WHERE tenant_id = ?").get(tenant.id).n, 0);
  assert.equal(fs.existsSync(uploaded), false, "the uploaded file goes with the document row");

  // The delete is recoverable: the snapshot is the install as it was *before* the
  // delete, files included, and it is the only thing that makes this reversible.
  const [snap] = snapshots("delete-temp-co");
  assert.ok(snap, "a snapshot was taken before the workspace was removed");
  const archived = new DatabaseSync(path.join(snap, "database.db"));
  const kept = archived.prepare("SELECT * FROM tenants WHERE slug = 'temp-co'").get();
  assert.ok(kept, "the snapshot still holds the deleted workspace");
  assert.equal(
    archived.prepare("SELECT COUNT(*) AS n FROM clients WHERE tenant_id = ?").get(kept.id).n,
    1,
    "and its client row"
  );
  archived.close();
  assert.ok(
    fs.existsSync(path.join(snap, "uploads", "temp-id.pdf")),
    "the document's file is kept beside the database copy"
  );
});

test("sending through Lob is refused with a clear message while it is disabled", async () => {
  const { jar } = await agencySignIn();
  const pkg = db.prepare("SELECT * FROM packages WHERE status = 'Ready' ORDER BY id LIMIT 1").get();
  assert.ok(pkg, "a ready package exists");

  const res = await http(`/app/mailroom/${pkg.id}/send`, {
    method: "POST",
    jar,
    form: { _csrf: jar.get("cp_csrf") }
  });
  assert.equal(res.status, 303);
  assert.match(decodeURIComponent(res.location), /Lob is not enabled yet/);
});

test("resetting the system leaves a clean install with the operator and payment settings", async () => {
  const { jar } = await platformSignIn();
  await http("/platform", { jar });

  // A payment setting set from the console: this is what a reset must not take.
  db.prepare(
    "INSERT INTO platform_settings (key, value, updated_at, updated_by) VALUES ('stripe_secret_key', 'sk_test_reset_marker', '2026-10-24', 'test')"
    + " ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run();
  const before = db.prepare("SELECT COUNT(*) AS n FROM tenants").get().n;
  assert.ok(before > 0, "the seeded estate exists before the reset");

  // The gate is the word, and it is the only thing between a click and the estate.
  // Case is not the point (`reset` is accepted); a different word must do nothing.
  const refused = await http("/platform/reset", {
    method: "POST",
    jar,
    form: { _csrf: jar.get("cp_csrf"), confirm: "yes" }
  });
  assert.equal(refused.status, 400);
  assert.match(refused.body, /Nothing was reset/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tenants").get().n, before, "a wrong confirmation resets nothing");

  const reset = await http("/platform/reset", {
    method: "POST",
    jar,
    form: { _csrf: jar.get("cp_csrf"), confirm: "RESET" }
  });
  assert.equal(reset.status, 303);
  assert.match(decodeURIComponent(reset.location), /Reset complete/);

  for (const table of ["tenants", "clients", "users", "disputes", "documents", "sessions", "leads", "emails", "audit_log"]) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, `${table} should be empty after a reset`);
  }
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM platform_admins").get().n >= 1, "the operator account survives");
  assert.equal(
    db.prepare("SELECT value FROM platform_settings WHERE key = 'stripe_secret_key'").get().value,
    "sk_test_reset_marker",
    "payment settings survive"
  );
  const uploads = fs.readdirSync(path.join(dataDir, "uploads"));
  assert.deepEqual(uploads, [], "uploaded files are swept with the reset");

  // The whole install before the reset is on disk, so "reset" is not "lose".
  const [snap] = snapshots("reset");
  assert.ok(snap, "a snapshot was taken before the reset");
  const archived = new DatabaseSync(path.join(snap, "database.db"));
  assert.equal(
    archived.prepare("SELECT COUNT(*) AS n FROM tenants").get().n,
    before,
    "the snapshot holds every workspace the reset removed"
  );
  archived.close();

  // The operator is still signed in, and the console now reads as a clean install.
  const after = await http("/platform", { jar });
  assert.equal(after.status, 200);
  assert.match(after.body, /No workspaces yet/);
  assert.match(after.body, /Reset system/);

  // Nobody from the old install can sign in any more, and the sign-in page says why
  // instead of failing on a workspace that no longer exists.
  const stranded = await agencySignIn();
  assert.equal(stranded.res.status, 503);
  assert.match(stranded.res.body, /no workspace yet/i);

  const portalJar = new Map();
  await http("/portal/login", { jar: portalJar });
  const portal = await http("/portal/login", {
    method: "POST",
    jar: portalJar,
    form: { _csrf: portalJar.get("cp_csrf"), email: "x@y.test", password: "nope" }
  });
  assert.equal(portal.status, 503, "the portal form answers the same way");
});

test("the host can reset to a clean install without a browser", async () => {
  const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), "clearpath-reset-cli-"));
  const cliDb = path.join(cliDir, "clearpath.db");
  const repo = path.resolve(import.meta.dirname, "..");

  const run = (script, args) =>
    new Promise((resolve) => {
      const proc = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", script, ...args], {
        cwd: repo,
        env: {
          ...process.env,
          DATA_DIR: cliDir,
          DB_PATH: cliDb,
          SEED_DEMO: "1",
          NODE_ENV: "test",
          PLATFORM_ADMIN_EMAIL: "",
          PLATFORM_ADMIN_PASSWORD: ""
        },
        stdio: ["ignore", "pipe", "pipe"]
      });
      let out = "";
      proc.stdout.on("data", (chunk) => (out += chunk));
      proc.stderr.on("data", (chunk) => (out += chunk));
      proc.on("exit", (code) => resolve({ code, out }));
    });

  try {
    const seeded = await run("scripts/seed.js", []);
    assert.equal(seeded.code, 0, seeded.out);

    // The same report from the shell: the seed's accounts, their passwords and
    // the workspace's URL, read back out of the database it just wrote.
    const creds = await run("scripts/credentials.js", []);
    assert.equal(creds.code, 0, creds.out);
    assert.match(creds.out, /Denovo!2026/);
    assert.match(creds.out, /Client!2026/);
    assert.match(creds.out, /dana@denovocredit\.com/);
    assert.match(creds.out, /https:\/\/denovocredit\.com\/portal\/login/);

    const sites = await run("scripts/credentials.js", ["--site"]);
    assert.equal(sites.code, 0, sites.out);
    assert.match(sites.out, /https:\/\/northstar\.clearpath\.test/);
    assert.doesNotMatch(sites.out, /Client!2026/, "--site prints no passwords");

    // Refused without the word, and the estate is untouched.
    const refused = await run("scripts/reset.js", ["--confirm", "please"]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /is not RESET/);

    const dry = await run("scripts/reset.js", ["--confirm", "RESET", "--dry-run"]);
    assert.equal(dry.code, 0);
    assert.match(dry.out, /Dry run: nothing was removed/);

    const check = new DatabaseSync(cliDb);
    const beforeCount = check.prepare("SELECT COUNT(*) AS n FROM tenants").get().n;
    assert.ok(beforeCount > 0, "the seed created workspaces, and the refusals kept them");
    check.close();

    const done = await run("scripts/reset.js", ["--confirm", "RESET"]);
    assert.equal(done.code, 0, done.out);
    assert.match(done.out, /Removed \d+ workspace/);
    assert.match(done.out, /Snapshot: /);

    const empty = await run("scripts/credentials.js", []);
    assert.equal(empty.code, 0, empty.out);
    assert.match(empty.out, /No workspace in this database/);

    const after = new DatabaseSync(cliDb);
    assert.equal(after.prepare("SELECT COUNT(*) AS n FROM tenants").get().n, 0);
    assert.equal(after.prepare("SELECT COUNT(*) AS n FROM clients").get().n, 0);
    after.close();

    const snaps = fs.readdirSync(path.join(cliDir, "backups")).filter((name) => name.endsWith("-reset"));
    assert.equal(snaps.length, 1, "the CLI wrote the same snapshot the console does");
    const archived = new DatabaseSync(path.join(cliDir, "backups", snaps[0], "database.db"));
    assert.equal(archived.prepare("SELECT COUNT(*) AS n FROM tenants").get().n, beforeCount);
    archived.close();
  } finally {
    fs.rmSync(cliDir, { recursive: true, force: true });
  }
});
