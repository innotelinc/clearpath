/**
 * Stripe billing webhooks.
 *
 * Mounted under /webhooks, before sessions and CSRF: Stripe authenticates with
 * the signature over the raw body, never a cookie. The signature is mandatory
 * here — unlike the Lob endpoint — because these events change what a tenant
 * pays. Without a configured webhook secret the endpoint refuses to run rather
 * than trusting anonymous posts saying "this workspace is paid up".
 *
 * Every event is recorded once, keyed by Stripe's event id, so a retry after a
 * timeout cannot apply the same plan change twice.
 */
import { Router } from "express";
import { audit, db } from "../db.js";
import {
  applySubscription,
  stripeWebhookSecret,
  syncSubscription,
  tenantForStripeObject,
  verifyStripeSignature
} from "../billing.js";

const router = Router();

function record(eventId, tenantId, type, detail) {
  const inserted = db
    .prepare("INSERT OR IGNORE INTO billing_events (id, tenant_id, type, detail, received_at) VALUES (?, ?, ?, ?, ?)")
    .run(eventId, tenantId, type, detail || null, new Date().toISOString());
  return inserted.changes > 0;
}

router.post("/stripe", async (req, res) => {
  const secret = stripeWebhookSecret();
  if (!secret) {
    return res.status(503).json({ ok: false, error: "STRIPE_WEBHOOK_SECRET is not set" });
  }

  const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : String(req.body || "");
  if (!verifyStripeSignature(raw, req.headers["stripe-signature"], secret)) {
    return res.status(400).json({ ok: false, error: "invalid signature" });
  }

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return res.status(400).json({ ok: false, error: "invalid json" });
  }

  const type = String(event?.type || "");
  const eventId = String(event?.id || "");
  if (!type || !eventId) return res.status(200).json({ ok: true, ignored: "not an event" });

  const object = event?.data?.object || {};
  const tenantId =
    tenantForStripeObject({
      metadata: object.metadata,
      customer: object.customer,
      clientReference: object.client_reference_id
    }) || null;

  let detail = "";
  try {
    switch (type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        const subscriptionId =
          typeof object.subscription === "string" ? object.subscription : object.subscription?.id;
        if (tenantId && subscriptionId) {
          await syncSubscription(subscriptionId, tenantId);
          detail = `subscription ${subscriptionId}`;
        } else if (tenantId) {
          detail = "session completed without a subscription";
        }
        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        if (tenantId) {
          const applied = applySubscription(tenantId, object);
          detail = `${applied?.plan || "plan"} · ${applied?.status || object.status}`;
          if (event.previous_attributes?.status || type.endsWith("deleted")) {
            const tenant = db.prepare("SELECT name FROM tenants WHERE id = ?").get(tenantId);
            audit(
              tenantId,
              "Stripe webhook",
              type === "customer.subscription.deleted" ? "Subscription ended" : "Subscription updated",
              `${tenant?.name || "workspace"} · ${applied?.status || object.status}`
            );
          }
        }
        break;
      }

      case "invoice.paid":
      case "invoice.payment_failed": {
        const subscriptionId =
          typeof object.subscription === "string" ? object.subscription : object.subscription?.id;
        if (tenantId && subscriptionId) {
          await syncSubscription(subscriptionId, tenantId);
          detail = `invoice ${object.number || object.id || ""}`.trim();
        } else if (tenantId) {
          db.prepare("UPDATE tenants SET plan_status = ?, plan_updated_at = ? WHERE id = ?").run(
            type === "invoice.paid" ? "active" : "past_due",
            new Date().toISOString(),
            tenantId
          );
          detail = "no subscription on the invoice";
        }
        if (tenantId && type === "invoice.payment_failed") {
          audit(tenantId, "Stripe webhook", "Payment failed", String(object.billing_reason || "invoice"));
        }
        break;
      }

      default:
        // Not a billing event this app models: acknowledge so Stripe stops retrying.
        record(eventId, tenantId, type, "ignored");
        return res.status(200).json({ ok: true, ignored: type });
    }
  } catch (err) {
    // Let Stripe retry: nothing was recorded, so the same event can apply later.
    console.warn(`Clearpath: Stripe webhook ${type} failed — ${err.message}`);
    return res.status(502).json({ ok: false, error: "could not apply the event" });
  }

  const fresh = record(eventId, tenantId, type, detail);
  if (!fresh) return res.status(200).json({ ok: true, duplicate: true });
  if (!tenantId) return res.status(200).json({ ok: true, ignored: "unknown tenant" });

  res.status(200).json({ ok: true });
});

export default router;
