import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import nodeHttp from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const PORT = Number(process.env.TEST_PORT || 3917);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "clearpath-test-"));
let child;
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

async function http(pathname, { method = "GET", form, jar, binary = false } = {}) {
  const headers = {};
  if (jar) headers.cookie = cookieHeader(jar);
  let body;
  if (form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(form).toString();
  }
  const res = await fetch(`${BASE}${pathname}`, { method, headers, body, redirect: "manual" });
  if (jar) readCookies(res, jar);
  return {
    status: res.status,
    location: res.headers.get("location"),
    type: res.headers.get("content-type"),
    headers: res.headers,
    body: binary ? Buffer.from(await res.arrayBuffer()) : await res.text()
  };
}

/** fetch() forbids a custom Host header, so tenant routing is tested over node:http. */
function rawRequest(pathname, { method = "GET", headers = {}, body = "" } = {}) {
  return new Promise((resolve, reject) => {
    const req = nodeHttp.request(
      { host: "127.0.0.1", port: PORT, path: pathname, method, headers },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { text += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function signIn(email, password, mode = "agency") {
  const jar = new Map();
  const page = await http(mode === "client" ? "/portal/login" : "/login", { jar });
  assert.equal(page.status, 200);
  const csrf = jar.get("cp_csrf");
  assert.ok(csrf, "login page should set a CSRF cookie");
  const res = await http(mode === "client" ? "/portal/login" : "/login", {
    method: "POST",
    jar,
    form: { _csrf: csrf, email, password, next: mode === "client" ? "/portal" : "/app" }
  });
  return { jar, res };
}

before(async () => {
  child = spawn(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", "server/index.js"],
    {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: {
        ...process.env,
        PORT: String(PORT),
        DATA_DIR: dataDir,
        DB_PATH: path.join(dataDir, "test.db"),
        SEED_DEMO: "1",
        COOKIE_SECURE: "0",
        NODE_ENV: "test"
      },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  await waitForServer();
  inspect = new DatabaseSync(path.join(dataDir, "test.db"));
});

after(async () => {
  try {
    inspect?.close();
  } catch { /* already closed */ }
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

test("health check reports a live database", async () => {
  const res = await http("/healthz");
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).ok, true);
});

test("landing page renders the Denovo Credit marketing site", async () => {
  const res = await http("/");
  assert.equal(res.status, 200);
  assert.match(res.body, /Denovo Credit/);
  assert.match(res.body, /Clearpath/);
  assert.match(res.body, /Book a walkthrough/);
  assert.match(res.body, /denovocredit\.com/);
});

test("the stylesheet is linked under a URL that changes with its bytes", async () => {
  const landing = await http("/");
  assert.equal(landing.status, 200);

  // A deploy that fixes a rule must reach a browser that already has the old
  // file. `/assets/css/app.css` is the same URL forever, so the page links it
  // with a content hash instead and the URL itself changes.
  const versioned = landing.body.match(/href="(\/assets\/css\/app\.css\?v=[0-9a-f]{10})"/);
  assert.ok(versioned, "the stylesheet link should carry the file's hash");

  const css = await http(versioned[1]);
  assert.equal(css.status, 200, "the hashed URL should be served");
  assert.equal(css.type, "text/css; charset=UTF-8");
  assert.match(css.body, /\.kv \.k \{/, "and it should be the stylesheet that styles the portal pairs");

  const plain = await http("/assets/css/app.css");
  assert.equal(plain.body, css.body, "the hash names the same bytes, not a copy");
});

test("legal and robots routes respond", async () => {
  const privacy = await http("/legal/privacy");
  assert.equal(privacy.status, 200);
  assert.match(privacy.body, /Privacy notice/);
  const robots = await http("/robots.txt");
  assert.equal(robots.status, 200);
  assert.match(robots.body, /Disallow: \/app/);
});

test("workspace routes require a session", async () => {
  const res = await http("/app");
  assert.equal(res.status, 302);
  assert.match(res.location, /^\/login/);
});

test("bad credentials are rejected without a session", async () => {
  const { res } = await signIn("dana@denovocredit.com", "wrong-password");
  assert.equal(res.status, 401);
  assert.match(res.body, /do not match/);
});

test("owner can sign in and see the dashboard", async () => {
  const { jar, res } = await signIn("dana@denovocredit.com", "Denovo!2026");
  assert.equal(res.status, 303);
  assert.equal(res.location, "/app");
  const dash = await http("/app", { jar });
  assert.equal(dash.status, 200);
  assert.match(dash.body, /Open disputes/);
  assert.match(dash.body, /Amara Okafor/);
});

test("client list, dispute and document routes render for the owner", async () => {
  const { jar } = await signIn("dana@denovocredit.com", "Denovo!2026");
  for (const route of ["/app/clients", "/app/disputes", "/app/mailroom", "/app/documents", "/app/audit", "/app/settings"]) {
    const res = await http(route, { jar });
    assert.equal(res.status, 200, `${route} should render`);
  }
  const client = await http("/app/clients/1", { jar });
  assert.equal(client.status, 200);
  assert.match(client.body, /Case notes/);
  const audit = await http("/app/audit", { jar });
  assert.match(audit.body, /Chain verified/);
});

test("a dispute letter downloads as a real PDF", async () => {
  const { jar } = await signIn("dana@denovocredit.com", "Denovo!2026");
  const list = await http("/app/disputes", { jar });
  const match = list.body.match(/\/app\/disputes\/(\d+)\/letter\.pdf/);
  assert.ok(match, "dispute list should link to a letter PDF");
  const pdf = await http(`/app/disputes/${match[1]}/letter.pdf`, { jar, binary: true });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.type, "application/pdf");
  assert.equal(pdf.body.subarray(0, 5).toString("latin1"), "%PDF-");
  assert.ok(pdf.body.length > 1200, "PDF should have real content");
});

test("host header routes to the matching tenant and its own users", async () => {
  const host = "northstar.clearpath.test";
  const page = await rawRequest("/login", { headers: { host } });
  assert.equal(page.status, 200);
  assert.match(page.body, /Northstar Credit Group/);

  const csrf = /name="_csrf" value="([^"]+)"/.exec(page.body)[1];
  const cookie = (page.headers["set-cookie"] || []).map((line) => line.split(";")[0]).join("; ");
  const login = await rawRequest("/login", {
    method: "POST",
    headers: {
      host,
      origin: `http://${host}`,
      cookie,
      "content-type": "application/x-www-form-urlencoded",
      "content-length": Buffer.byteLength(`_csrf=${csrf}&email=owner%40northstar.test&password=Northstar%212026&next=%2Fapp`)
    },
    body: `_csrf=${csrf}&email=owner%40northstar.test&password=Northstar%212026&next=%2Fapp`
  });
  assert.equal(login.status, 303);
  assert.equal(login.headers.location, "/app");

  const sessionCookie = (login.headers["set-cookie"] || []).map((line) => line.split(";")[0]).join("; ");
  const dash = await rawRequest("/app", { headers: { host, cookie: sessionCookie } });
  assert.equal(dash.status, 200);
  assert.match(dash.body, /Rosa Diaz/);
  assert.doesNotMatch(dash.body, /Amara Okafor/);
});

test("a workspace cannot read another tenant's client or dispute", async () => {
  const { jar } = await signIn("dana@denovocredit.com", "Denovo!2026");
  const own = await http("/app/clients/1", { jar });
  assert.equal(own.status, 200);
  assert.match(own.body, /Amara Okafor/);

  // Rosa Diaz and dispute DSP-2001 belong to the Northstar workspace.
  const foreignClient = await http("/app/clients/7", { jar });
  assert.equal(foreignClient.status, 404);
  assert.doesNotMatch(foreignClient.body, /Rosa Diaz/);

  const foreignDispute = await http("/app/disputes/10", { jar });
  assert.equal(foreignDispute.status, 404);
});

test("specialists cannot invite portal users or change branding", async () => {
  const { jar } = await signIn("marcus@denovocredit.com", "Specialist!2026");
  const settings = await http("/app/settings", { jar });
  const csrf = jar.get("cp_csrf") || settings.body.match(/name="_csrf" value="([^"]+)"/)?.[1];
  const invite = await http("/app/clients/2/invite", {
    method: "POST",
    jar,
    form: { _csrf: csrf }
  });
  assert.equal(invite.status, 403);
  const branding = await http("/app/settings/branding", {
    method: "POST",
    jar,
    form: { _csrf: csrf, name: "Hijacked" }
  });
  assert.equal(branding.status, 403);
});

test("client portal shows only the signed-in client's own file", async () => {
  const { jar, res } = await signIn("amara@example.com", "Client!2026", "client");
  assert.equal(res.status, 303);
  assert.equal(res.location, "/portal");

  const overview = await http("/portal", { jar });
  assert.equal(overview.status, 200);
  assert.match(overview.body, /Amara/);
  assert.doesNotMatch(overview.body, /Devon Clarke/);

  for (const route of ["/portal/disputes", "/portal/documents", "/portal/messages", "/portal/score"]) {
    const page = await http(route, { jar });
    assert.equal(page.status, 200, `${route} should render`);
  }

  const foreignDoc = await http("/portal/documents/4/download", { jar });
  assert.equal(foreignDoc.status, 404, "a client must not download another client's document");
});

test("a client cannot reach the agency workspace", async () => {
  const { jar } = await signIn("amara@example.com", "Client!2026", "client");
  const res = await http("/app", { jar });
  assert.equal(res.status, 302);
  assert.equal(res.location, "/portal");
});

test("contact form stores a lead and redirects with a receipt", async () => {
  const jar = new Map();
  const page = await http("/", { jar });
  assert.equal(page.status, 200);
  const res = await http("/contact", {
    method: "POST",
    jar,
    form: {
      _csrf: jar.get("cp_csrf"),
      name: "Test Agency",
      email: "owner@test-agency.example",
      agency: "Test Agency LLC",
      size: "41–150",
      message: "We want to migrate 80 clients."
    }
  });
  assert.equal(res.status, 303);
  assert.equal(res.location, "/?sent=1#contact");
});

test("a form post without the CSRF token is rejected", async () => {
  const jar = new Map();
  await http("/portal/login", { jar });
  const res = await http("/portal/login", {
    method: "POST",
    jar,
    form: { email: "amara@example.com", password: "Client!2026" }
  });
  assert.equal(res.status, 403);
});

test("full case workflow: client, tradeline, dispute, package, mailing", async () => {
  const { jar } = await signIn("dana@denovocredit.com", "Denovo!2026");
  const csrf = () => jar.get("cp_csrf");

  const created = await http("/app/clients", {
    method: "POST",
    jar,
    form: { _csrf: csrf(), name: "Jordan Alvarez", email: "jordan.alvarez@example.com", phone: "(415) 555-0199", stage: "Onboarding" }
  });
  assert.equal(created.status, 303);
  const clientId = Number(created.location.match(/\/app\/clients\/(\d+)/)[1]);

  const tradeline = await http(`/app/clients/${clientId}/tradelines`, {
    method: "POST",
    jar,
    form: {
      _csrf: csrf(),
      creditor: "Cavalry Portfolio",
      mask: "9134",
      bureau: "ex",
      type: "Collection",
      balance: "640",
      opened: "Jan 2025",
      reason: "Debt was paid and should not be reported",
      evidence: "Payoff letter\nBank statement",
      strength: "91"
    }
  });
  assert.equal(tradeline.status, 303);

  const clientPage = await http(`/app/clients/${clientId}`, { jar });
  const tradelineId = Number(clientPage.body.match(/name="tradeline_id" value="(\d+)"/)[1]);

  const dispute = await http("/app/disputes", {
    method: "POST",
    jar,
    form: { _csrf: csrf(), client_id: String(clientId), tradeline_id: String(tradelineId) }
  });
  assert.equal(dispute.status, 303);
  const disputePath = dispute.location.split("?")[0];
  const disputePage = await http(disputePath, { jar });
  assert.equal(disputePage.status, 200);
  assert.match(disputePage.body, /Cavalry Portfolio/);

  const disputeId = disputePath.split("/").pop();
  const packaged = await http("/app/mailroom/packages", {
    method: "POST",
    jar,
    form: { _csrf: csrf(), dispute_ids: disputeId, method: "certified", return_receipt: "on" }
  });
  assert.equal(packaged.status, 303);

  const mailroom = await http("/app/mailroom", { jar });
  const pkg = mailroom.body.match(/\/app\/mailroom\/(\d+)\/mailed/);
  assert.ok(pkg, "a package should be ready to mail");
  const mailed = await http(`/app/mailroom/${pkg[1]}/mailed`, {
    method: "POST",
    jar,
    form: { _csrf: csrf(), tracking: "9405 5118 9956 0000 0000 99" }
  });
  assert.equal(mailed.status, 303);

  const after = await http(disputePath, { jar });
  assert.match(after.body, /9405 5118 9956 0000 0000 99|In transit/);
  const audit = await http("/app/audit", { jar });
  assert.match(audit.body, /Chain verified/);
  assert.match(audit.body, /Created mailing package/);
});

test("a package posted before letter bodies were stored still shows the letter", async () => {
  const { jar } = await signIn("dana@denovocredit.com", "Denovo!2026");
  const dispute = inspect
    .prepare("SELECT * FROM disputes WHERE tenant_id = 1 ORDER BY id DESC LIMIT 1")
    .get();
  assert.ok(dispute, "the demo seed should leave a dispute to post");

  // The shape of a package mailed by the version that stamped the reference and
  // left the body empty — the page used to name the letter and show nothing.
  const ref = `CP-LEGACY-${Date.now()}`;
  const pkg = inspect
    .prepare("INSERT INTO packages (tenant_id, client_id, ref, bureau, letters, status) VALUES (?, ?, ?, ?, 1, 'mailed')")
    .run(dispute.tenant_id, dispute.client_id, ref, dispute.bureau);
  inspect
    .prepare("INSERT INTO package_letters (tenant_id, package_id, dispute_id, ref, account, bureau, body) VALUES (?, ?, ?, ?, ?, ?, '')")
    .run(dispute.tenant_id, Number(pkg.lastInsertRowid), dispute.id, dispute.ref, dispute.account, dispute.bureau);

  const page = await http(`/app/mailroom/${pkg.lastInsertRowid}`, { jar });
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("cache-control"), "no-store", "a browser may not keep this page");
  assert.match(
    page.body,
    /Formal dispute of inaccurate information —/,
    "the letter the dispute would print is on the page"
  );
  assert.match(page.body, /To Whom It May Concern:/);
  assert.match(page.body, /The dispute's current text/, "and it is labelled as today's text, not the posted one");
  assert.doesNotMatch(page.body, /only the dispute reference survives/, "the dead end is gone");
});

test("client portal accepts a hashed document upload", async () => {
  const { jar } = await signIn("amara@example.com", "Client!2026", "client");
  const png = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001" +
    "0d0a2db40000000049454e44ae426082",
    "hex"
  );
  const form = new FormData();
  form.set("_csrf", jar.get("cp_csrf"));
  form.set("type", "Identity");
  form.set("file", new Blob([png], { type: "image/png" }), "address-proof.png");
  const res = await fetch(`${BASE}/portal/documents`, {
    method: "POST",
    headers: { cookie: cookieHeader(jar) },
    body: form,
    redirect: "manual"
  });
  readCookies(res, jar);
  assert.equal(res.status, 303);

  const vault = await http("/portal/documents", { jar });
  assert.equal(vault.status, 200);
  assert.match(vault.body, /address-proof\.png/);
  assert.match(vault.body, /Pending review/);
});

test("a non-image upload is rejected on signature", async () => {
  const { jar } = await signIn("amara@example.com", "Client!2026", "client");
  const form = new FormData();
  form.set("_csrf", jar.get("cp_csrf"));
  form.set("type", "Identity");
  form.set("file", new Blob([Buffer.from("not really a pdf")], { type: "application/pdf" }), "fake.pdf");
  const res = await fetch(`${BASE}/portal/documents`, {
    method: "POST",
    headers: { cookie: cookieHeader(jar) },
    body: form,
    redirect: "manual"
  });
  assert.equal(res.status, 303);
  assert.match(res.headers.get("location"), /error=/);
});

test("signing out ends the session", async () => {
  const { jar } = await signIn("dana@denovocredit.com", "Denovo!2026");
  const out = await http("/logout", { method: "POST", jar, form: { _csrf: jar.get("cp_csrf") } });
  assert.equal(out.status, 303);
  const after = await http("/app", { jar });
  assert.equal(after.status, 302);
});

test("inviting a client emails a temporary password and forces it to be replaced", async () => {
  const { jar } = await signIn("dana@denovocredit.com", "Denovo!2026");
  const invite = await http("/app/clients/5/invite", {
    method: "POST",
    jar,
    form: { _csrf: jar.get("cp_csrf") }
  });
  assert.equal(invite.status, 200);
  assert.match(invite.body, /Portal access created for Hannah Kim/);
  assert.match(invite.body, /Mail log/);

  const email = inspect.prepare("SELECT * FROM emails WHERE kind = 'credentials' ORDER BY id DESC LIMIT 1").get();
  assert.equal(email.to_email, "hannah.kim@example.com");
  assert.equal(email.status, "queued", "no transport configured, so the message waits in the outbox");
  const temp = /Temporary password: (\S+)/.exec(email.body_text)?.[1];
  assert.ok(temp, "the credential email should contain the temporary password");

  const client = await signIn("hannah.kim@example.com", temp, "client");
  assert.equal(client.res.status, 303);

  const gate = await http("/portal", { jar: client.jar });
  assert.equal(gate.status, 303);
  assert.match(gate.location, /^\/change-password/);

  const page = await http(gate.location, { jar: client.jar });
  assert.equal(page.status, 200);
  assert.match(page.body, /Choose your password/);

  const changed = await http("/change-password", {
    method: "POST",
    jar: client.jar,
    form: {
      _csrf: client.jar.get("cp_csrf"),
      after: "/portal",
      next: "HannahPass!2027",
      confirm: "HannahPass!2027"
    }
  });
  assert.equal(changed.status, 303);
  const portal = await http("/portal", { jar: client.jar });
  assert.equal(portal.status, 200);
  assert.match(portal.body, /Hannah Kim/);

  const row = inspect.prepare("SELECT must_change_password FROM users WHERE email = ?").get("hannah.kim@example.com");
  assert.equal(Number(row.must_change_password), 0);
});

test("a reset link works once, rotates the password and ends other sessions", async () => {
  const first = await signIn("amara@example.com", "Client!2026", "client");
  const second = await signIn("amara@example.com", "Client!2026", "client");
  assert.equal(first.res.status, 303);

  const requester = new Map();
  const page = await http("/forgot?mode=client", { jar: requester });
  assert.equal(page.status, 200);
  assert.match(page.body, /Reset your password/);
  const sent = await http("/forgot", {
    method: "POST",
    jar: requester,
    form: { _csrf: requester.get("cp_csrf"), mode: "client", email: "amara@example.com" }
  });
  assert.equal(sent.status, 303);
  assert.match(sent.location, /sent=1/);

  const email = inspect.prepare("SELECT * FROM emails WHERE kind = 'password-reset' ORDER BY id DESC LIMIT 1").get();
  assert.ok(email.link, "the reset email should carry a link");
  const pathname = new URL(email.link).pathname;

  const visitor = new Map();
  const form = await http(pathname, { jar: visitor });
  assert.equal(form.status, 200);
  assert.match(form.body, /Choose a new password/);

  const saved = await http(pathname, {
    method: "POST",
    jar: visitor,
    form: { _csrf: visitor.get("cp_csrf"), password: "ClientReset!2027", confirm: "ClientReset!2027" }
  });
  assert.equal(saved.status, 303);
  assert.match(saved.location, /^\/portal\/login/);

  // Both sessions that existed before the reset are gone.
  assert.equal((await http("/portal", { jar: first.jar })).status, 302);
  assert.equal((await http("/portal", { jar: second.jar })).status, 302);

  const reuse = await http(pathname, { jar: new Map() });
  assert.equal(reuse.status, 400, "a used link must not work twice");

  const again = await signIn("amara@example.com", "ClientReset!2027", "client");
  assert.equal(again.res.status, 303);
  assert.equal((await http("/portal", { jar: again.jar })).status, 200);
});

test("the drafting studio turns an approved draft into a dispute with its edited text", async () => {
  const { jar } = await signIn("dana@denovocredit.com", "Denovo!2026");
  const generated = await http("/app/studio/generate", {
    method: "POST",
    jar,
    form: {
      _csrf: jar.get("cp_csrf"),
      tradeline_id: "1",
      strategy: "fcra-611",
      tone: "Firm",
      evidence: "on",
      citations: "on"
    }
  });
  assert.equal(generated.status, 303);
  assert.match(generated.location, /^\/app\/studio\/\d+$/);

  const page = await http(generated.location, { jar });
  assert.equal(page.status, 200);
  assert.match(page.body, /What the file supports/);
  assert.match(page.body, /15 U\.S\.C\./);
  assert.match(page.body, /Jefferson Capital/);

  const draftId = generated.location.split("/").pop();
  const approved = await http(`/app/studio/${draftId}`, {
    method: "POST",
    jar,
    form: {
      _csrf: jar.get("cp_csrf"),
      action: "approve",
      body: "First approved paragraph.\n\nSecond approved paragraph."
    }
  });
  assert.equal(approved.status, 303);
  const disputePath = approved.location.split("?")[0];
  assert.match(disputePath, /^\/app\/disputes\/\d+$/);

  const dispute = await http(disputePath, { jar });
  assert.equal(dispute.status, 200);
  assert.match(dispute.body, /First approved paragraph/);

  const pdf = await http(`${disputePath}/letter.pdf`, { jar, binary: true });
  assert.equal(pdf.body.subarray(0, 5).toString("latin1"), "%PDF-");
  assert.ok(pdf.body.length > 1500);

  const saved = inspect
    .prepare("SELECT letter_body FROM disputes WHERE id = ?")
    .get(Number(disputePath.split("/").pop()));
  assert.match(saved.letter_body, /Second approved paragraph/);
});

test("the mail log lists the outbox and refuses to send without a transport", async () => {
  const { jar } = await signIn("dana@denovocredit.com", "Denovo!2026");
  const page = await http("/app/mail-log", { jar });
  assert.equal(page.status, 200);
  assert.match(page.body, /No mail provider is configured/);
  assert.match(page.body, /queued/);

  const row = inspect.prepare("SELECT id FROM emails ORDER BY id DESC LIMIT 1").get();
  const retry = await http(`/app/mail-log/${row.id}/retry`, {
    method: "POST",
    jar,
    form: { _csrf: jar.get("cp_csrf") }
  });
  assert.equal(retry.status, 303);
  assert.match(retry.location, /error=/);

  const specialist = await signIn("marcus@denovocredit.com", "Specialist!2026");
  assert.equal((await http("/app/mail-log", { jar: specialist.jar })).status, 403);
});

test("password reset requests are rate limited per address", async () => {
  const count = () =>
    inspect.prepare("SELECT COUNT(*) AS n FROM emails WHERE kind = 'password-reset' AND to_email = ?")
      .get("priya@example.com").n;
  const before = count();
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const jar = new Map();
    await http("/forgot", { jar });
    await http("/forgot", {
      method: "POST",
      jar,
      form: { _csrf: jar.get("cp_csrf"), mode: "client", email: "priya@example.com" }
    });
  }
  assert.equal(count(), before + 5, "the sixth request in the window must be dropped");
});

test("changing a password keeps the current session and ends the others", async () => {
  const mine = await signIn("marcus@denovocredit.com", "Specialist!2026");
  const other = await signIn("marcus@denovocredit.com", "Specialist!2026");

  const changed = await http("/change-password", {
    method: "POST",
    jar: mine.jar,
    form: {
      _csrf: mine.jar.get("cp_csrf"),
      current: "Specialist!2026",
      next: "Specialist!2027",
      confirm: "Specialist!2027"
    }
  });
  assert.equal(changed.status, 303);
  assert.equal((await http("/app", { jar: other.jar })).status, 302);
  assert.equal((await http("/app", { jar: mine.jar })).status, 200);

  const relogin = await signIn("marcus@denovocredit.com", "Specialist!2027");
  assert.equal(relogin.res.status, 303);
});

test("a client sees what went into a package and the letter on an open dispute", async () => {
  // A client this file has not signed in yet: the login limiter is per account,
  // and earlier cases already use up the budget on the Denovo demo client.
  const session = await signIn("priya@example.com", "Client!2026", "client");
  assert.equal(session.res.status, 303, "the demo client should be able to sign in");
  const client = inspect.prepare(
    "SELECT c.id, c.tenant_id FROM clients c JOIN users u ON u.client_id = c.id WHERE u.email = ?"
  ).get("priya@example.com");
  assert.ok(client, "the demo client should be seeded");

  const dispute = inspect.prepare(
    "SELECT id, tenant_id, bureau, account FROM disputes WHERE client_id = ? ORDER BY id LIMIT 1"
  ).get(client.id);
  assert.ok(dispute, "the demo client should have a dispute");

  const letter = "Dear Experian, this is a formal dispute of the account listed below.";
  inspect.prepare("UPDATE disputes SET letter_body = ? WHERE id = ?").run(letter, dispute.id);

  const ref = `CP-TEST-${Date.now()}`;
  const pkg = inspect.prepare(
    "INSERT INTO packages (tenant_id, client_id, ref, bureau, letters, status, tracking) VALUES (?, ?, ?, ?, 1, 'mailed', ?)"
  ).run(dispute.tenant_id, client.id, ref, dispute.bureau, "9400TESTTRACKING");
  inspect.prepare(
    "INSERT INTO package_letters (tenant_id, package_id, dispute_id, ref, account, bureau, body) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(dispute.tenant_id, Number(pkg.lastInsertRowid), dispute.id, ref, dispute.account, dispute.bureau, letter);

  const mailings = await http("/portal/packages", { jar: session.jar });
  assert.equal(mailings.status, 200);
  assert.match(mailings.body, new RegExp(ref), "the mailed package should be listed");
  assert.match(mailings.body, /9400TESTTRACKING/);
  assert.match(mailings.body, /formal dispute of the account/, "the letter inside the package should be visible");

  // The dates and the method read as label/value pairs. They need the rule that
  // puts each value under its label: without it every pair collapses into one
  // run-together line ("PostedNot posted yetMethodCertified + return receipt").
  assert.match(mailings.body, /<span class="k">Posted<\/span><span class="v">/);
  const css = await http("/assets/css/app.css");
  assert.equal(css.status, 200);
  assert.match(css.body, /\.kv \.k \{/, "the stylesheet the portal links must style the pairs it renders");

  const detail = await http(`/portal/disputes/${dispute.id}`, { jar: session.jar });
  assert.equal(detail.status, 200);
  assert.match(detail.body, /formal dispute of the account/);
  assert.match(detail.body, /9400TESTTRACKING/, "the dispute should point at the package that carried it");

  const other = inspect.prepare("SELECT id FROM disputes WHERE client_id <> ? LIMIT 1").get(client.id);
  assert.equal((await http(`/portal/disputes/${other.id}`, { jar: session.jar })).status, 404);
});

test("a document is opened for review before it can be verified", async () => {
  const { jar } = await signIn("dana@denovocredit.com", "Denovo!2026");

  const pending = inspect
    .prepare("SELECT * FROM documents WHERE status = 'Pending review' ORDER BY id LIMIT 1")
    .get();
  assert.ok(pending, "the demo seed should leave a document awaiting review");
  assert.ok(pending.stored_name, "a seeded document should have a reviewable file");

  const list = await http("/app/documents", { jar });
  assert.equal(list.status, 200);
  assert.match(list.body, /Review/, "the vault should offer a review, not a blind verify");

  const review = await http(`/app/documents/${pending.id}`, { jar });
  assert.equal(review.status, 200);
  assert.match(review.body, /Verify document/);
  assert.match(review.body, new RegExp(`/app/documents/${pending.id}/file`), "the file should be framed for reading");

  const inline = await http(`/app/documents/${pending.id}/file`, { jar, binary: true });
  assert.equal(inline.status, 200);
  assert.equal(inline.type, "application/pdf");
  assert.match(inline.body.subarray(0, 5).toString("latin1"), /^%PDF-/, "the preview should be the real PDF");

  const download = await http(`/app/documents/${pending.id}/download`, { jar });
  assert.equal(download.status, 200, "the vault download must not 404");

  const verified = await http(`/app/documents/${pending.id}/verify`, {
    method: "POST",
    jar,
    form: { _csrf: jar.get("cp_csrf"), return: "review" }
  });
  assert.equal(verified.status, 303);
  const after = inspect.prepare("SELECT status FROM documents WHERE id = ?").get(pending.id);
  assert.equal(after.status, "Verified");
});

/** A tiny SMTP server: enough for nodemailer to authenticate and hand over a message. */
function startSmtpStub() {
  const messages = [];
  const transcript = [];
  const server = net.createServer((socket) => {
    let buffer = "";
    let inData = false;
    let authStage = 0;
    socket.write("220 stub ESMTP\r\n");

    const pump = () => {
      for (;;) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end === -1) return;
          messages.push(buffer.slice(0, end));
          buffer = buffer.slice(end + 5);
          inData = false;
          socket.write("250 OK queued\r\n");
          continue;
        }
        const at = buffer.indexOf("\r\n");
        if (at === -1) return;
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        transcript.push(line);
        const cmd = line.toUpperCase();
        if (cmd.startsWith("EHLO")) socket.write("250-stub\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n");
        else if (cmd.startsWith("HELO")) socket.write("250 stub\r\n");
        else if (cmd.startsWith("AUTH LOGIN")) { authStage = 1; socket.write("334 VXNlcm5hbWU6\r\n"); }
        else if (authStage === 1) { authStage = 2; socket.write("334 UGFzc3dvcmQ6\r\n"); }
        else if (authStage === 2) { authStage = 0; socket.write("235 Authentication successful\r\n"); }
        else if (cmd.startsWith("AUTH PLAIN")) socket.write("235 Authentication successful\r\n");
        else if (cmd.startsWith("MAIL FROM")) socket.write("250 OK\r\n");
        else if (cmd.startsWith("RCPT TO")) socket.write("250 OK\r\n");
        else if (cmd === "DATA") { inData = true; socket.write("354 End data with <CR><LF>.<CR><LF>\r\n"); }
        else if (cmd === "QUIT") { socket.write("221 Bye\r\n"); socket.end(); return; }
        else socket.write("250 OK\r\n");
      }
    };

    socket.on("data", (chunk) => { buffer += chunk.toString("utf8"); pump(); });
    socket.on("error", () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        port: server.address().port,
        messages,
        transcript,
        close: () => new Promise((done) => server.close(() => done()))
      })
    );
  });
}

test("a workspace saves its own SMTP server and sends through it", async () => {
  const stub = await startSmtpStub();
  try {
    const { jar } = await signIn("dana@denovocredit.com", "Denovo!2026");
    const owner = inspect.prepare("SELECT id, tenant_id FROM users WHERE email = ?").get("dana@denovocredit.com");

    const save = await http("/app/settings/mail", {
      method: "POST",
      jar,
      form: {
        _csrf: jar.get("cp_csrf"),
        host: "127.0.0.1",
        port: String(stub.port),
        security: "none",
        username: "clearpath@example.test",
        password: "app-password",
        from: "Denovo Credit <no-reply@denovocredit.com>",
        enabled: "1",
        action: "save"
      }
    });
    assert.equal(save.status, 303);

    const saved = inspect.prepare("SELECT * FROM tenant_mail WHERE tenant_id = ?").get(owner.tenant_id);
    assert.ok(saved, "the workspace server should be stored");
    assert.equal(saved.host, "127.0.0.1");
    assert.match(saved.password_sealed, /^v1:/, "the SMTP password should be sealed");
    assert.ok(!saved.password_sealed.includes("app-password"), "the password must not be stored in the clear");

    const settings = await http("/app/settings", { jar });
    assert.equal(settings.status, 200);
    assert.match(settings.body, /Workspace server/);
    assert.match(settings.body, /Saved \(encrypted\)/);

    const test = await http("/app/settings/mail", {
      method: "POST",
      jar,
      form: {
        _csrf: jar.get("cp_csrf"),
        host: "127.0.0.1",
        port: String(stub.port),
        security: "none",
        username: "clearpath@example.test",
        password: "",
        from: "Denovo Credit <no-reply@denovocredit.com>",
        enabled: "1",
        action: "test"
      }
    });
    assert.equal(test.status, 303);
    assert.equal(stub.messages.length, 1, "the test message should reach the workspace server");
    assert.match(stub.messages[0], /Subject: Denovo Credit test message/);

    // The saved password, decrypted from the database, is what authenticated.
    const plainAt = stub.transcript.findIndex((line) => /^AUTH PLAIN /i.test(line));
    assert.ok(plainAt >= 0, "the transport should authenticate with the saved credentials");
    const plain = Buffer.from(stub.transcript[plainAt].split(" ")[2], "base64").toString("utf8");
    assert.equal(plain.split("\0").pop(), "app-password");

    const row = inspect
      .prepare("SELECT * FROM emails WHERE tenant_id = ? AND kind = 'test' ORDER BY id DESC LIMIT 1")
      .get(owner.tenant_id);
    assert.equal(row.status, "sent");
    assert.equal(row.provider, "smtp");

    const removed = await http("/app/settings/mail/remove", {
      method: "POST",
      jar,
      form: { _csrf: jar.get("cp_csrf") }
    });
    assert.equal(removed.status, 303);
    assert.equal(inspect.prepare("SELECT COUNT(*) AS n FROM tenant_mail WHERE tenant_id = ?").get(owner.tenant_id).n, 0);
  } finally {
    await stub.close();
  }
});
