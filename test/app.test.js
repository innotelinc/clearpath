import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import nodeHttp from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = Number(process.env.TEST_PORT || 3917);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "clearpath-test-"));
let child;

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
});

after(async () => {
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
