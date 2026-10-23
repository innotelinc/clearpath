/**
 * Billing end to end: checkout, the success redirect, the signed webhook and
 * the operator key page — all against a local Stripe stand-in, so no request
 * ever leaves the machine and no real key is needed.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const PORT = Number(process.env.TEST_BILLING_PORT || 3923);
const BASE = `http://127.0.0.1:${PORT}`;
const WEBHOOK_SECRET = "whsec_test_secret";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "clearpath-billing-test-"));
const dbPath = path.join(dataDir, "test.db");

let child;
let db;
let mock;
let mockBase;
let tenantId;
const captures = [];
const subscriptions = new Map();

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

function cookieHeader(jar) {
  return Array.from(jar, ([k, v]) => `${k}=${v}`).join("; ");
}

function readCookies(res, jar) {
  for (const line of res.headers.getSetCookie?.() || []) {
    const pair = line.split(";")[0];
    const at = pair.indexOf("=");
    if (at > 0) jar.set(pair.slice(0, at), pair.slice(at + 1));
  }
}

async function http(pathname, { method = "GET", form, jar, headers = {} } = {}) {
  const all = { ...headers };
  if (jar) all.cookie = cookieHeader(jar);
  let body;
  if (form) {
    all["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(form).toString();
  }
  const res = await fetch(`${BASE}${pathname}`, { method, headers: all, body, redirect: "manual" });
  if (jar) readCookies(res, jar);
  return { status: res.status, location: res.headers.get("location"), body: await res.text() };
}

async function signIn(email, password) {
  const jar = new Map();
  await http("/login", { jar });
  const res = await http("/login", {
    method: "POST",
    jar,
    form: { _csrf: jar.get("cp_csrf"), email, password, next: "/app/billing" }
  });
  return { jar, res };
}

async function platformSignIn() {
  const jar = new Map();
  await http("/platform/login", { jar });
  const res = await http("/platform/login", {
    method: "POST",
    jar,
    form: {
      _csrf: jar.get("cp_csrf"),
      email: "platform@clearpath.test",
      password: "Platform!2026",
      next: "/platform/billing"
    }
  });
  return { jar, res };
}

function signedEvent(payload, secret = WEBHOOK_SECRET) {
  const raw = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto.createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex");
  return { raw, header: `t=${timestamp},v1=${signature}` };
}

/* ---------------- the Stripe stand-in ---------------- */

function startMock() {
  mock = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const url = new URL(req.url, "http://127.0.0.1");
      const send = (status, payload) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      const form = Object.fromEntries(new URLSearchParams(body));

      if (req.method === "GET" && url.pathname === "/v1/balance") {
        return send(200, { object: "balance", livemode: false, available: [{ amount: 250000, currency: "usd" }] });
      }

      if (req.method === "POST" && url.pathname === "/v1/checkout/sessions") {
        captures.push({ kind: "checkout", form, authorization: req.headers.authorization });
        return send(200, {
          id: "cs_test_1",
          object: "checkout.session",
          url: "https://checkout.stripe.test/pay/cs_test_1",
          client_reference_id: form.client_reference_id,
          status: "open"
        });
      }

      if (req.method === "GET" && url.pathname === "/v1/checkout/sessions/cs_test_1") {
        const checkout = captures.find((entry) => entry.kind === "checkout");
        return send(200, {
          id: "cs_test_1",
          object: "checkout.session",
          status: "complete",
          client_reference_id: checkout?.form?.client_reference_id,
          metadata: { tenant_id: checkout?.form?.["metadata[tenant_id]"] ?? "" },
          subscription: "sub_test_1"
        });
      }

      if (req.method === "GET" && url.pathname.startsWith("/v1/subscriptions/")) {
        const id = url.pathname.split("/").pop();
        const subscription = subscriptions.get(id);
        return subscription ? send(200, subscription) : send(404, { error: { message: "no such subscription" } });
      }

      if (req.method === "POST" && url.pathname === "/v1/prices") {
        captures.push({ kind: "price", form });
        return send(200, { id: `price_${form["metadata[plan]"]}`, object: "price", unit_amount: Number(form.unit_amount) });
      }

      if (req.method === "POST" && url.pathname.startsWith("/v1/subscriptions/")) {
        const id = url.pathname.split("/").pop();
        captures.push({ kind: "switch", form, subscriptionId: id });
        const current = subscriptions.get(id);
        const planKey = form["metadata[plan]"];
        const amount = planKey === "starter" ? 14900 : planKey === "scale" ? 79900 : 39900;
        const updated = {
          ...current,
          status: current?.status === "past_due" ? "past_due" : "active",
          metadata: { ...current?.metadata, plan: planKey },
          items: { data: [{ id: "si_1", price: { unit_amount: amount, recurring: { interval: "month" } } }] }
        };
        subscriptions.set(id, updated);
        return send(200, updated);
      }

      if (req.method === "POST" && url.pathname === "/v1/billing_portal/sessions") {
        captures.push({ kind: "portal", form });
        return send(200, { id: "bps_1", url: "https://billing.stripe.test/session/bps_1" });
      }

      return send(404, { error: { message: `unmocked ${req.method} ${url.pathname}` } });
    });
  });
  return new Promise((resolve) => {
    mock.listen(0, "127.0.0.1", () => {
      mockBase = `http://127.0.0.1:${mock.address().port}/v1`;
      resolve();
    });
  });
}

/* ---------------- lifecycle ---------------- */

before(async () => {
  await startMock();
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
      APP_ORIGIN: BASE,
      PLATFORM_ADMIN_EMAIL: "",
      PLATFORM_ADMIN_PASSWORD: "",
      OMNIROUTE_API_KEY: "",
      LOB_API_KEY: "",
      STRIPE_SECRET_KEY: "sk_test_mock_key",
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      STRIPE_BASE_URL: mockBase
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  await waitForServer();
  db = new DatabaseSync(dbPath);
  tenantId = db.prepare("SELECT id FROM tenants WHERE slug = 'denovo'").get().id;

  subscriptions.set("sub_test_1", {
    id: "sub_test_1",
    object: "subscription",
    status: "active",
    customer: "cus_test_1",
    current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
    metadata: { tenant_id: String(tenantId), plan: "growth" },
    items: { data: [{ id: "si_1", price: { unit_amount: 39900, recurring: { interval: "month" } } }] }
  });
});

after(async () => {
  try {
    db?.close();
  } catch {
    /* already closed */
  }
  await new Promise((resolve) => mock?.close(resolve));
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

/* ---------------- the tests ---------------- */

test("billing is owner-only and lists the plans", async () => {
  const anonymous = await http("/app/billing");
  assert.equal(anonymous.status, 302);
  assert.match(anonymous.location, /^\/login/);

  const specialist = await signIn("marcus@denovocredit.com", "Specialist!2026");
  const denied = await http("/app/billing", { jar: specialist.jar });
  assert.equal(denied.status, 403);
  assert.match(denied.body, /does not have access/);

  const owner = await signIn("dana@denovocredit.com", "Denovo!2026");
  const page = await http("/app/billing", { jar: owner.jar });
  assert.equal(page.status, 200);
  assert.match(page.body, /Choose Starter/);
  assert.match(page.body, /No plan yet/);
  assert.doesNotMatch(page.body, /Stripe is not connected/);
});

test("checkout sends the plan inline and redirects to Stripe", async () => {
  const owner = await signIn("dana@denovocredit.com", "Denovo!2026");
  const res = await http("/app/billing/checkout", {
    method: "POST",
    jar: owner.jar,
    form: { _csrf: owner.jar.get("cp_csrf"), plan: "growth" }
  });

  assert.equal(res.status, 303);
  assert.equal(res.location, "https://checkout.stripe.test/pay/cs_test_1");

  const checkout = captures.find((entry) => entry.kind === "checkout");
  assert.ok(checkout, "checkout should reach Stripe");
  assert.equal(checkout.form.mode, "subscription");
  assert.equal(checkout.form["line_items[0][price_data][unit_amount]"], "39900");
  assert.equal(checkout.form["line_items[0][price_data][recurring][interval]"], "month");
  assert.equal(checkout.form.client_reference_id, String(tenantId));
  assert.match(checkout.form.success_url, /\/app\/billing\?checkout=success/);
  assert.match(checkout.authorization, /^Basic /);
});

test("the success redirect records the subscription on the workspace", async () => {
  const owner = await signIn("dana@denovocredit.com", "Denovo!2026");
  const res = await http("/app/billing?checkout=success&session_id=cs_test_1", { jar: owner.jar });
  assert.equal(res.status, 200);
  assert.match(res.body, /Subscription confirmed/);
  assert.match(res.body, /Growth/);

  const row = db.prepare("SELECT plan, plan_status, stripe_customer_id, stripe_subscription_id FROM tenants WHERE id = ?").get(tenantId);
  assert.equal(row.plan, "growth");
  assert.equal(row.plan_status, "active");
  assert.equal(row.stripe_customer_id, "cus_test_1");
  assert.equal(row.stripe_subscription_id, "sub_test_1");
});

test("switching plans updates the subscription instead of opening a second one", async () => {
  const owner = await signIn("dana@denovocredit.com", "Denovo!2026");
  const before = captures.filter((entry) => entry.kind === "checkout").length;

  const res = await http("/app/billing/checkout", {
    method: "POST",
    jar: owner.jar,
    form: { _csrf: owner.jar.get("cp_csrf"), plan: "starter" }
  });

  assert.equal(res.status, 303);
  assert.match(res.location, /^\/app\/billing\?notice=/);
  assert.equal(
    captures.filter((entry) => entry.kind === "checkout").length,
    before,
    "a subscribed workspace must not be sent back to Checkout"
  );

  const price = captures.find((entry) => entry.kind === "price");
  const change = captures.find((entry) => entry.kind === "switch");
  assert.ok(price && change, "the switch should create a price and update the subscription");
  assert.equal(price.form.unit_amount, "14900");
  assert.equal(change.subscriptionId, "sub_test_1");
  assert.equal(change.form["items[0][id]"], "si_1");
  assert.equal(change.form["items[0][price]"], "price_starter");
  assert.equal(change.form.proration_behavior, "create_prorations");

  const row = db.prepare("SELECT plan, plan_status FROM tenants WHERE id = ?").get(tenantId);
  assert.equal(row.plan, "starter");
  assert.equal(row.plan_status, "active");

  // Put the workspace back on Growth for the webhook test that follows.
  subscriptions.set("sub_test_1", {
    ...subscriptions.get("sub_test_1"),
    metadata: { tenant_id: String(tenantId), plan: "growth" },
    items: { data: [{ id: "si_1", price: { unit_amount: 39900, recurring: { interval: "month" } } }] }
  });
});

test("a signed webhook applies the event once", async () => {
  const owner = await signIn("dana@denovocredit.com", "Denovo!2026");
  const event = {
    id: "evt_billing_2",
    type: "customer.subscription.updated",
    data: {
      object: {
        ...subscriptions.get("sub_test_1"),
        status: "past_due",
        metadata: { tenant_id: String(tenantId), plan: "growth" }
      }
    }
  };
  const { raw, header } = signedEvent(event);
  const post = (signature = header, payload = raw) =>
    fetch(`${BASE}/webhooks/stripe`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": signature },
      body: payload
    });

  const ok = await post();
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).ok, true);
  assert.equal(
    db.prepare("SELECT plan_status FROM tenants WHERE id = ?").get(tenantId).plan_status,
    "past_due"
  );

  const replay = await post();
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).duplicate, true);

  const page = await http("/app/billing", { jar: owner.jar });
  assert.match(page.body, /Payment needs attention/);

  const forged = await post("t=1,v1=deadbeef", raw);
  assert.equal(forged.status, 400);

  const unsigned = await post("", raw);
  assert.equal(unsigned.status, 400);

  // A delivery event the app does not model is acknowledged, not retried.
  const { raw: otherRaw, header: otherHeader } = signedEvent({ id: "evt_other", type: "invoice.finalized", data: { object: {} } });
  const other = await post(otherHeader, otherRaw);
  assert.equal(other.status, 200);
  assert.equal((await other.json()).ignored, "invoice.finalized");
});

test("an operator can store a Stripe key and check the connection", async () => {
  const { jar } = await platformSignIn();
  const page = await http("/platform/billing", { jar });
  assert.equal(page.status, 200);
  assert.match(page.body, /Test mode/);
  assert.match(page.body, /Check connection/);

  const rejected = await http("/platform/billing", {
    method: "POST",
    jar,
    form: { _csrf: jar.get("cp_csrf"), secret_key: "not-a-key" }
  });
  assert.equal(rejected.status, 400);
  assert.match(rejected.body, /does not look like a Stripe secret key/);

  const saved = await http("/platform/billing", {
    method: "POST",
    jar,
    form: { _csrf: jar.get("cp_csrf"), secret_key: "sk_test_console_key_1234", webhook_secret: "whsec_console_1" }
  });
  assert.equal(saved.status, 200);
  assert.match(saved.body, /Secret key saved/);
  assert.match(saved.body, /Platform console/);
  assert.match(saved.body, /sk_test_…1234/);

  const check = await http("/platform/billing/test", {
    method: "POST",
    jar,
    form: { _csrf: jar.get("cp_csrf") }
  });
  assert.equal(check.status, 200);
  assert.match(check.body, /Stripe accepted the key/);
  assert.match(check.body, /test mode/);
});

test("the owner sees the stored subscription, not the Stripe key", async () => {
  const owner = await signIn("dana@denovocredit.com", "Denovo!2026");
  const page = await http("/app/billing", { jar: owner.jar });
  assert.equal(page.status, 200);
  assert.match(page.body, /Growth/);
  assert.match(page.body, /Payment due/);
  assert.doesNotMatch(page.body, /sk_test_/, "the secret key must never reach a workspace page");
  assert.doesNotMatch(page.body, /whsec_/);
});
