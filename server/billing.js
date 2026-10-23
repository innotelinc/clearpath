/**
 * Subscription billing through Stripe.
 *
 * Stripe is spoken to over plain REST, like Lob and the mail providers: no SDK,
 * no webhook library. The secret key is resolved on every call — first from the
 * operator settings table (the console can change it without a redeploy), then
 * from the environment — so a rotated key takes effect immediately.
 *
 * Checkout creates the subscription and the customer; the webhook is what keeps
 * `tenants.plan_status` current afterwards. The success redirect also verifies
 * the session directly, which is what makes the flow testable on a laptop with
 * no public webhook URL.
 */
import crypto from "node:crypto";
import { db, getSetting } from "./db.js";

const DEFAULT_BASE_URL = "https://api.stripe.com/v1";

export const stripeBaseUrl = () =>
  String(process.env.STRIPE_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");

/** Plan catalogue. Amounts are monthly and in cents, which is what Stripe wants. */
export const PLANS = [
  {
    key: "starter",
    name: "Starter",
    amount: 14900,
    clients: 50,
    staff: 2,
    blurb: "One office getting its first disputes out the door."
  },
  {
    key: "growth",
    name: "Growth",
    amount: 39900,
    clients: 250,
    staff: 6,
    blurb: "A team running mail rounds every week."
  },
  {
    key: "scale",
    name: "Scale",
    amount: 79900,
    clients: null,
    staff: null,
    blurb: "Multi-office operation with an unlimited client book."
  }
];

export const planByKey = (key) => PLANS.find((plan) => plan.key === String(key || "")) || null;

export class BillingError extends Error {
  constructor(message, { status = 0, code = "" } = {}) {
    super(message);
    this.name = "BillingError";
    this.status = status;
    this.code = code;
  }
}

/* ---------------- configuration ---------------- */

export function stripeSecretKey() {
  return String(getSetting("stripe_secret_key") || process.env.STRIPE_SECRET_KEY || "").trim();
}

export function stripeWebhookSecret() {
  return String(getSetting("stripe_webhook_secret") || process.env.STRIPE_WEBHOOK_SECRET || "").trim();
}

export function stripeConfigured() {
  return stripeSecretKey().length > 0;
}

/**
 * `live`, `test`, `unrecognised` or `off`. The prefix is the only reliable
 * signal: both key types are otherwise identical.
 */
export function stripeMode() {
  const key = stripeSecretKey();
  if (!key) return "off";
  if (key.startsWith("sk_live_")) return "live";
  if (key.startsWith("sk_test_")) return "test";
  return "unrecognised";
}

/** Where the active key came from, so the console can explain itself. */
export function stripeKeySource() {
  if (getSetting("stripe_secret_key")) return "console";
  if (process.env.STRIPE_SECRET_KEY) return "environment";
  return "none";
}

export function maskKey(key) {
  const value = String(key || "");
  if (!value) return "";
  if (value.length <= 12) return "…";
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

/* ---------------- REST plumbing ---------------- */

/**
 * Stripe wants form encoding with bracketed nesting:
 * line_items[0][price_data][unit_amount]=14900. Everything nested in the
 * payload objects below goes through here.
 */
function encodeForm(value, prefix = "", out = new URLSearchParams()) {
  if (value === undefined || value === null) return out;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => encodeForm(entry, `${prefix}[${index}]`, out));
    return out;
  }
  if (typeof value === "object") {
    Object.entries(value).forEach(([key, entry]) => {
      encodeForm(entry, prefix ? `${prefix}[${key}]` : key, out);
    });
    return out;
  }
  out.append(prefix, String(value));
  return out;
}

async function request(pathname, { method = "GET", form, query } = {}) {
  const key = stripeSecretKey();
  if (!key) {
    throw new BillingError(
      "Stripe is not configured. A platform operator has to add the secret key in the platform console."
    );
  }
  const params = query ? `?${encodeForm(query).toString()}` : "";
  let response;
  try {
    response = await fetch(`${stripeBaseUrl()}${pathname}${params}`, {
      method,
      headers: {
        authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json"
      },
      body: form ? encodeForm(form).toString() : undefined,
      signal: AbortSignal.timeout(30_000)
    });
  } catch (err) {
    const code = err?.cause?.code || err?.code || "";
    throw new BillingError(`Could not reach Stripe${code ? ` (${code})` : ""}. Try again in a moment.`);
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    /* no JSON body */
  }
  if (!response.ok) {
    const detail = payload?.error?.message || payload?.message || "";
    const code = payload?.error?.code || payload?.error?.type || "";
    throw new BillingError(
      `Stripe returned ${response.status}${detail ? `: ${String(detail).slice(0, 240)}` : ""}`,
      { status: response.status, code }
    );
  }
  return payload;
}

/** Read-only key check: the balance endpoint needs no arguments and changes nothing. */
export async function checkStripeConnection() {
  const started = Date.now();
  const balance = await request("/balance");
  return {
    ok: true,
    mode: stripeMode(),
    livemode: Boolean(balance?.livemode),
    currencies: (balance?.available || []).map((entry) => ({
      currency: entry.currency,
      amount: Number(entry.amount || 0)
    })),
    ms: Date.now() - started
  };
}

/* ---------------- checkout and portal ---------------- */

export async function createCheckoutSession({ tenant, plan, origin, email }) {
  const chosen = planByKey(plan?.key || plan);
  if (!chosen) throw new BillingError("Pick one of the published plans.");

  const metadata = { tenant_id: String(tenant.id), tenant_slug: tenant.slug, plan: chosen.key };
  const form = {
    mode: "subscription",
    success_url: `${origin}/app/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/app/billing?checkout=cancelled`,
    client_reference_id: String(tenant.id),
    "line_items[0][quantity]": 1,
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": chosen.amount,
    "line_items[0][price_data][recurring][interval]": "month",
    "line_items[0][price_data][product_data][name]": `Clearpath ${chosen.name}`,
    "subscription_data[metadata][tenant_id]": metadata.tenant_id,
    "subscription_data[metadata][plan]": chosen.key
  };
  Object.entries(metadata).forEach(([key, value]) => {
    form[`metadata[${key}]`] = value;
  });

  // An existing customer keeps their payment methods and invoices together.
  if (tenant.stripe_customer_id) form.customer = tenant.stripe_customer_id;
  else if (email) form.customer_email = email;

  const session = await request("/checkout/sessions", { method: "POST", form });
  if (!session?.url) throw new BillingError("Stripe accepted the request but returned no checkout URL.");
  return session;
}

export async function retrieveCheckoutSession(id) {
  return request(`/checkout/sessions/${encodeURIComponent(String(id))}`, {
    query: { expand: ["subscription"] }
  });
}

/**
 * Move an existing subscription onto another plan.
 *
 * Checkout would create a *second* subscription on the same customer and bill
 * them twice, so a workspace that is already subscribed changes the item on the
 * subscription it has. Stripe prorates the difference onto the next invoice.
 */
export async function changeSubscriptionPlan({ tenant, plan }) {
  const chosen = planByKey(plan?.key || plan);
  if (!chosen) throw new BillingError("Pick one of the published plans.");
  if (!tenant?.stripe_subscription_id) {
    throw new BillingError("This workspace has no subscription to change. Choose a plan instead.");
  }

  const current = await retrieveSubscription(tenant.stripe_subscription_id);
  const item = current?.items?.data?.[0];
  if (!item?.id) throw new BillingError("Stripe did not return a subscription item to change.");

  // Subscription items need a real Price object; inline price_data is only
  // accepted when the subscription is created.
  const price = await request("/prices", {
    method: "POST",
    form: {
      currency: "usd",
      unit_amount: chosen.amount,
      "recurring[interval]": "month",
      "product_data[name]": `Clearpath ${chosen.name}`,
      "metadata[plan]": chosen.key
    }
  });

  const updated = await request(`/subscriptions/${encodeURIComponent(current.id)}`, {
    method: "POST",
    form: {
      "items[0][id]": item.id,
      "items[0][price]": price.id,
      proration_behavior: "create_prorations",
      "metadata[plan]": chosen.key,
      "metadata[tenant_id]": String(tenant.id)
    }
  });

  const applied = applySubscription(tenant.id, updated);
  return { plan: chosen.key, status: applied?.status || updated?.status || "active", subscriptionId: current.id };
}

export async function createBillingPortalSession({ customerId, returnUrl }) {
  if (!customerId) {
    throw new BillingError("This workspace has no Stripe customer yet. Choose a plan first.");
  }
  const session = await request("/billing_portal/sessions", {
    method: "POST",
    form: { customer: customerId, return_url: returnUrl }
  });
  if (!session?.url) throw new BillingError("Stripe returned no portal URL.");
  return session;
}

export async function retrieveSubscription(id) {
  return request(`/subscriptions/${encodeURIComponent(String(id))}`);
}

/**
 * Statuses where a subscription exists and should be changed in place rather
 * than re-created. `canceled` is deliberately absent: that workspace resubscribes.
 */
export const CHANGEABLE_STATUSES = ["active", "trialing", "past_due", "unpaid", "incomplete", "paused"];

/* ---------------- keeping tenants in step ---------------- */

const STATUS_LABELS = {
  active: "Active",
  trialing: "Trial",
  past_due: "Payment due",
  unpaid: "Unpaid",
  canceled: "Cancelled",
  incomplete: "Incomplete",
  incomplete_expired: "Expired",
  paused: "Paused"
};

const STATUS_TONES = {
  active: "teal",
  trialing: "blue",
  past_due: "rose",
  unpaid: "rose",
  canceled: "gray",
  incomplete: "amber",
  incomplete_expired: "gray",
  paused: "amber"
};

export const statusLabel = (status) => STATUS_LABELS[String(status || "")] || "No plan";
export const statusTone = (status) => STATUS_TONES[String(status || "")] || "gray";

/** Which plan a subscription pays for: metadata first, then the price amount. */
export function planKeyFromSubscription(subscription) {
  const named = planByKey(subscription?.metadata?.plan);
  if (named) return named.key;
  const item = subscription?.items?.data?.[0];
  const amount = Number(item?.price?.unit_amount ?? item?.plan?.amount ?? 0);
  if (!amount) return null;
  const interval = item?.price?.recurring?.interval || item?.plan?.interval || "month";
  if (interval !== "month") return null;
  return PLANS.find((plan) => plan.amount === amount)?.key || null;
}

function periodEnd(subscription) {
  const seconds = Number(subscription?.current_period_end || subscription?.items?.data?.[0]?.current_period_end || 0);
  return seconds ? new Date(seconds * 1000).toISOString() : null;
}

/** Write a subscription's state onto its tenant. Idempotent. */
export function applySubscription(tenantId, subscription) {
  const tenant = db.prepare("SELECT id FROM tenants WHERE id = ?").get(Number(tenantId));
  if (!tenant) return null;
  const planKey = planKeyFromSubscription(subscription);
  const status = String(subscription?.status || "incomplete");
  const customer = typeof subscription?.customer === "string" ? subscription.customer : subscription?.customer?.id || null;
  db.prepare(
    `UPDATE tenants
        SET plan = COALESCE(?, plan),
            plan_status = ?,
            plan_renews_at = ?,
            plan_updated_at = ?,
            stripe_customer_id = COALESCE(?, stripe_customer_id),
            stripe_subscription_id = ?
      WHERE id = ?`
  ).run(
    planKey,
    status,
    periodEnd(subscription),
    new Date().toISOString(),
    customer,
    subscription?.id || null,
    tenant.id
  );
  return { tenantId: tenant.id, plan: planKey, status };
}

/** Find the tenant a Stripe object belongs to, by metadata, customer or reference. */
export function tenantForStripeObject({ metadata, customer, clientReference } = {}) {
  const byId = Number(metadata?.tenant_id || clientReference || 0);
  if (byId) {
    const direct = db.prepare("SELECT id FROM tenants WHERE id = ?").get(byId);
    if (direct) return direct.id;
  }
  const bySlug = metadata?.tenant_slug
    ? db.prepare("SELECT id FROM tenants WHERE slug = ?").get(String(metadata.tenant_slug))
    : null;
  if (bySlug) return bySlug.id;
  if (customer) {
    const id = typeof customer === "string" ? customer : customer?.id;
    const row = id
      ? db.prepare("SELECT id FROM tenants WHERE stripe_customer_id = ?").get(String(id))
      : null;
    if (row) return row.id;
  }
  return null;
}

/** Pull a subscription from Stripe and apply it (used after checkout). */
export async function syncSubscription(subscriptionId, tenantId = null) {
  if (!subscriptionId) return null;
  const subscription = await retrieveSubscription(subscriptionId);
  const target = tenantId || tenantForStripeObject({ metadata: subscription?.metadata, customer: subscription?.customer });
  if (!target) return null;
  return applySubscription(target, subscription);
}

/* ---------------- what the UI renders ---------------- */

export function billingSummary(tenant) {
  if (!tenant) return null;
  const plan = planByKey(tenant.plan);
  const status = String(tenant.plan_status || "");
  return {
    configured: stripeConfigured(),
    mode: stripeMode(),
    keySource: stripeKeySource(),
    plan,
    status,
    statusLabel: status ? statusLabel(status) : tenant.plan ? "Active" : "No plan",
    statusTone: status ? statusTone(status) : tenant.plan ? "teal" : "gray",
    renewsAt: tenant.plan_renews_at || null,
    customerId: tenant.stripe_customer_id || "",
    subscriptionId: tenant.stripe_subscription_id || "",
    paying: ["active", "trialing"].includes(status),
    needsAttention: ["past_due", "unpaid", "incomplete", "incomplete_expired"].includes(status)
  };
}

/* ---------------- webhook signatures ---------------- */

/**
 * Stripe signs `"<timestamp>.<raw body>"` with HMAC-SHA256 and sends
 * `Stripe-Signature: t=…,v1=…` (v1 may repeat while keys are rotated).
 */
export function verifyStripeSignature(rawBody, header, secret, toleranceSeconds = 300) {
  if (!secret) return false;
  const parts = String(header || "")
    .split(",")
    .map((part) => part.trim().split("="))
    .filter(([key, value]) => key && value);
  const timestamp = parts.find(([key]) => key === "t")?.[1];
  const signatures = parts.filter(([key]) => key === "v1").map(([, value]) => value);
  if (!timestamp || !signatures.length) return false;
  if (!Number.isFinite(Number(timestamp))) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > toleranceSeconds) return false;

  const expected = crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const left = Buffer.from(expected, "utf8");
  return signatures.some((signature) => {
    const right = Buffer.from(String(signature), "utf8");
    return left.length === right.length && crypto.timingSafeEqual(left, right);
  });
}
