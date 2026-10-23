/**
 * Workspace billing: the owner's view of the subscription, and the two POSTs
 * that hand them to Stripe (checkout and the billing portal).
 *
 * Mounted at /app/billing behind an owner-only guard: a specialist runs cases,
 * not the money. When Stripe has no key the page still renders and explains
 * exactly what is missing, because that is a deployment problem the operator
 * fixes, not something the owner can do anything about.
 */
import { Router } from "express";
import { audit, db } from "../db.js";
import { originFor } from "../accounts.js";
import {
  BillingError,
  PLANS,
  billingSummary,
  createBillingPortalSession,
  createCheckoutSession,
  planByKey,
  retrieveCheckoutSession,
  stripeConfigured,
  syncSubscription
} from "../billing.js";
import { fmtDate } from "../util.js";

const router = Router();

function usage(tenantId) {
  const one = (sql, ...args) => db.prepare(sql).get(...args)?.n || 0;
  return {
    clients: one("SELECT COUNT(*) AS n FROM clients WHERE tenant_id = ?", tenantId),
    staff: one("SELECT COUNT(*) AS n FROM users WHERE tenant_id = ? AND role IN ('owner','specialist')", tenantId),
    disputes: one("SELECT COUNT(*) AS n FROM disputes WHERE tenant_id = ?", tenantId)
  };
}

function events(tenantId) {
  return db
    .prepare("SELECT * FROM billing_events WHERE tenant_id = ? ORDER BY received_at DESC, id LIMIT 8")
    .all(tenantId);
}

function render(req, res, { notice = "", error = "", status = 200 } = {}) {
  const tenant = db.prepare("SELECT * FROM tenants WHERE id = ?").get(req.tenant.id);
  res.setHeader("Cache-Control", "private, no-store");
  res.status(status).render("admin/billing", {
    title: "Billing",
    page: "billing",
    plans: PLANS,
    billing: billingSummary(tenant),
    used: usage(tenant.id),
    events: events(tenant.id),
    notice,
    error
  });
}

router.get("/", async (req, res, next) => {
  try {
    // Coming back from Checkout: trust Stripe's own record of the session, not
    // the query string. This is also the only path that works without a public
    // webhook URL (a laptop, a staging box behind a firewall).
    if (req.query.checkout === "success" && req.query.session_id && stripeConfigured()) {
      const session = await retrieveCheckoutSession(String(req.query.session_id)).catch(() => null);
      const tenantId = Number(session?.client_reference_id || session?.metadata?.tenant_id || 0);
      if (session && tenantId === req.tenant.id) {
        const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
        if (subscriptionId) {
          const applied = await syncSubscription(subscriptionId, req.tenant.id).catch(() => null);
          if (applied) {
            audit(req.tenant.id, req.user.name, "Activated a subscription", `${applied.plan || "plan"} · ${applied.status}`);
            return render(req, res, {
              notice: `Subscription confirmed — ${applied.plan || "plan"} is ${applied.status}.`
            });
          }
        }
        if (session.status === "complete") {
          return render(req, res, { notice: "Checkout completed. Stripe is still confirming the subscription." });
        }
      }
    }
    if (req.query.checkout === "cancelled") {
      return render(req, res, { notice: "Checkout cancelled — nothing was charged." });
    }
    return render(req, res);
  } catch (err) {
    next(err);
  }
});

router.post("/checkout", async (req, res) => {
  const plan = planByKey(req.body.plan);
  if (!plan) return render(req, res, { status: 400, error: "Choose one of the published plans." });
  if (!stripeConfigured()) {
    return render(req, res, {
      status: 503,
      error: "Stripe is not configured for this deployment. A platform operator has to add the secret key in the platform console."
    });
  }
  if (req.tenant.status === "suspended") {
    return render(req, res, {
      status: 403,
      error: "This workspace is suspended. Billing cannot change until an operator reactivates it."
    });
  }

  try {
    const session = await createCheckoutSession({
      tenant: req.tenant,
      plan,
      origin: originFor(req),
      email: req.user.email
    });
    audit(req.tenant.id, req.user.name, "Started checkout", `${plan.name} · ${plan.amount / 100} USD/month`);
    res.redirect(303, session.url);
  } catch (err) {
    const message =
      err instanceof BillingError
        ? err.message
        : "Stripe could not start the checkout. Try again, or ask the operator to check the API key.";
    console.warn(`Clearpath: checkout failed for tenant ${req.tenant.slug} — ${err.message}`);
    render(req, res, { status: 502, error: message });
  }
});

router.post("/portal", async (req, res) => {
  try {
    const session = await createBillingPortalSession({
      customerId: req.tenant.stripe_customer_id,
      returnUrl: `${originFor(req)}/app/billing`
    });
    res.redirect(303, session.url);
  } catch (err) {
    console.warn(`Clearpath: billing portal failed for tenant ${req.tenant.slug} — ${err.message}`);
    render(req, res, {
      status: 502,
      error:
        err instanceof BillingError
          ? err.message
          : "Stripe could not open the billing portal. Try again, or ask the operator to check the API key."
    });
  }
});

export default router;
