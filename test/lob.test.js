import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const PORT = Number(process.env.TEST_LOB_PORT || 3921);
const LOB_PORT = Number(process.env.TEST_LOB_MOCK_PORT || 20131);
const BASE = `http://127.0.0.1:${PORT}`;
const LOB_BASE = `http://127.0.0.1:${LOB_PORT}/v1`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "clearpath-lob-test-"));
const dbPath = path.join(dataDir, "test.db");
const WEBHOOK_SECRET = "whsec_test";

let child;
let db;
let mock;
const lobRequests = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, label) {
  for (let i = 0; i < 120; i += 1) {
    try {
      if (await check()) return;
    } catch {
      /* not ready */
    }
    await sleep(100);
  }
  throw new Error(`${label} did not become ready`);
}

function readCookies(res, jar) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const line of raw) {
    const pair = line.split(";")[0];
    const at = pair.indexOf("=");
    if (at > 0) jar.set(pair.slice(0, at), pair.slice(at + 1));
  }
}

async function request(pathname, { method = "GET", form, jar, json, headers = {} } = {}) {
  const allHeaders = { ...headers };
  if (jar) allHeaders.cookie = Array.from(jar, ([k, v]) => `${k}=${v}`).join("; ");
  let body;
  if (form) {
    allHeaders["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(form).toString();
  } else if (json !== undefined) {
    allHeaders["content-type"] = "application/json";
    body = typeof json === "string" ? json : JSON.stringify(json);
  }
  const res = await fetch(`${BASE}${pathname}`, { method, headers: allHeaders, body, redirect: "manual" });
  if (jar) readCookies(res, jar);
  return { status: res.status, location: res.headers.get("location"), body: await res.text() };
}

async function agencySignIn() {
  const jar = new Map();
  const page = await request("/login", { jar });
  assert.equal(page.status, 200);
  const res = await request("/login", {
    method: "POST",
    jar,
    form: { _csrf: jar.get("cp_csrf"), email: "dana@denovocredit.com", password: "Denovo!2026", next: "/app" }
  });
  assert.equal(res.status, 303);
  return jar;
}

before(async () => {
  mock = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      let payload = {};
      try {
        payload = JSON.parse(raw || "{}");
      } catch {
        /* ignore */
      }
      lobRequests.push({ headers: req.headers, body: payload });
      const n = lobRequests.length;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: `ltr_test_${n}`,
          tracking_number: `9405 5118 9956 0000 000${n}`,
          expected_delivery_date: "2026-11-02",
          status: "created"
        })
      );
    });
  });
  await new Promise((resolve) => mock.listen(LOB_PORT, "127.0.0.1", resolve));

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
      LOB_API_KEY: "test_lob_key",
      LOB_BASE_URL: LOB_BASE,
      LOB_WEBHOOK_SECRET: WEBHOOK_SECRET,
      OMNIROUTE_API_KEY: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  await waitFor(async () => (await fetch(`${BASE}/healthz`)).ok, "server");
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
  if (mock) await new Promise((resolve) => mock.close(resolve));
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
      return;
    } catch {
      await sleep(200);
    }
  }
});

test("a ready package is printed and posted through Lob", async () => {
  const jar = await agencySignIn();

  // Build a package with itemised letters through the automation.
  assert.equal((await request("/app/pipeline/run", { method: "POST", jar, form: { _csrf: jar.get("cp_csrf") } })).status, 303);
  assert.equal((await request("/app/pipeline/approve", { method: "POST", jar, form: { _csrf: jar.get("cp_csrf") } })).status, 303);

  const pkg = db
    .prepare(
      `SELECT p.*, (SELECT COUNT(*) FROM package_items pi WHERE pi.package_id = p.id) AS items
       FROM packages p WHERE p.status = 'Ready' AND items > 0 ORDER BY p.id LIMIT 1`
    )
    .get();
  assert.ok(pkg, "a ready package with letters exists");

  const page = await request(`/app/mailroom/${pkg.id}`, { jar });
  assert.equal(page.status, 200);
  assert.match(page.body, /Send via Lob/);

  const sent = await request(`/app/mailroom/${pkg.id}/send`, {
    method: "POST",
    jar,
    form: { _csrf: jar.get("cp_csrf") }
  });
  assert.equal(sent.status, 303);
  assert.match(decodeURIComponent(sent.location), /handed to Lob/);

  assert.ok(lobRequests.length > 0, "Lob received at least one letter");
  const first = lobRequests[0];
  assert.equal(first.headers.authorization, `Basic ${Buffer.from("test_lob_key:").toString("base64")}`);
  assert.equal(first.body.extra_service, "certified");
  assert.equal(first.body.mail_type, "usps_first_class");
  assert.equal(first.body.to.address_country, "US");
  assert.ok(first.body.to.address_city && first.body.to.address_state && first.body.to.address_zip);
  assert.ok(first.body.from.address_line1, "the agency return address is parsed");
  assert.match(first.body.html, /dispute/i);

  const stored = db.prepare("SELECT * FROM packages WHERE id = ?").get(pkg.id);
  assert.equal(stored.status, "In transit");
  assert.ok(stored.sent_at);
  assert.ok(stored.tracking, "the USPS tracking number is recorded on the package");

  const dispatches = db.prepare("SELECT * FROM mail_dispatches WHERE package_id = ?").all(pkg.id);
  assert.equal(dispatches.length, lobRequests.length);
  assert.equal(dispatches[0].provider, "lob");
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM package_letters WHERE package_id = ?").get(pkg.id).n > 0);

  const after = await request(`/app/mailroom/${pkg.id}`, { jar });
  assert.equal(after.status, 200);
  assert.match(after.body, /Dispatch/);
  assert.match(after.body, /Lob test/);
});

test("a signed Lob webhook moves the package to delivered, once", async () => {
  const dispatch = db.prepare("SELECT * FROM mail_dispatches ORDER BY id LIMIT 1").get();
  assert.ok(dispatch, "a dispatch exists from the previous test");

  const event = {
    id: "evt_test_delivered_1",
    event_type: { id: "letter.certified.delivered", resource: "letters" },
    date_created: new Date().toISOString(),
    body: { id: dispatch.provider_letter_id, tracking_events: [{ description: "Delivered, front door" }] }
  };
  const raw = JSON.stringify(event);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto.createHmac("sha256", WEBHOOK_SECRET).update(`${timestamp}.${raw}`).digest("hex");

  const accepted = await request("/webhooks/lob", {
    method: "POST",
    json: raw,
    headers: { "lob-signature": signature, "lob-signature-timestamp": timestamp }
  });
  assert.equal(accepted.status, 200);

  assert.equal(db.prepare("SELECT status FROM packages WHERE id = ?").get(dispatch.package_id).status, "Delivered");
  assert.equal(db.prepare("SELECT status FROM mail_dispatches WHERE id = ?").get(dispatch.id).status, "delivered");

  // Replaying the same event id must not duplicate the audit row.
  const replay = await request("/webhooks/lob", {
    method: "POST",
    json: raw,
    headers: { "lob-signature": signature, "lob-signature-timestamp": timestamp }
  });
  assert.equal(replay.status, 200);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM package_events WHERE provider_event_id = ?").get("evt_test_delivered_1").n,
    1
  );

  const page = await request(`/app/mailroom/${dispatch.package_id}`, { jar: await agencySignIn() });
  assert.equal(page.status, 200);
  assert.match(page.body, /Delivery events/);
  assert.match(page.body, /Delivered/);
});

test("a webhook with a bad signature is rejected", async () => {
  const before = db.prepare("SELECT COUNT(*) AS n FROM package_events").get().n;
  const raw = JSON.stringify({ id: "evt_bad", event_type: { id: "letter.certified.delivered" }, body: { id: "ltr_test_1" } });
  const timestamp = String(Math.floor(Date.now() / 1000));

  const rejected = await request("/webhooks/lob", {
    method: "POST",
    json: raw,
    headers: { "lob-signature": "not-a-real-signature", "lob-signature-timestamp": timestamp }
  });
  assert.equal(rejected.status, 401);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM package_events").get().n, before);
});
