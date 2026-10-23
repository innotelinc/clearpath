/**
 * Lob delivery webhooks.
 *
 * Mounted before session handling and CSRF: Lob calls this from outside, so it
 * authenticates with the HMAC signature Lob sends (LOB_WEBHOOK_SECRET) rather
 * than a cookie. Every event is stored in package_events and the package's
 * status follows the furthest scan.
 */
import { Router } from "express";
import { audit, db } from "../db.js";
import { lobWebhookSecret, packageStatusForEvent, signatureFresh, verifyLobSignature } from "../lob.js";

const router = Router();

router.post("/lob", (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : String(req.body || "");
  const signature = req.headers["lob-signature"];
  const timestamp = req.headers["lob-signature-timestamp"];

  if (lobWebhookSecret) {
    if (!signatureFresh(timestamp) || !verifyLobSignature(raw, signature, timestamp)) {
      return res.status(401).json({ ok: false, error: "invalid signature" });
    }
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return res.status(400).json({ ok: false, error: "invalid json" });
  }

  const eventType = String(
    (typeof payload.event_type === "string" ? payload.event_type : payload?.event_type?.id) || ""
  );
  const letterId = String(payload?.body?.id || "");
  if (!eventType || !letterId) {
    return res.status(200).json({ ok: true, ignored: "not a letter event" });
  }

  const dispatch = db
    .prepare("SELECT * FROM mail_dispatches WHERE provider = 'lob' AND provider_letter_id = ?")
    .get(letterId);
  if (!dispatch) {
    // Letter created outside Clearpath or trimmed from the database: accept and ignore.
    return res.status(200).json({ ok: true, ignored: "unknown letter" });
  }

  const eventId = String(payload?.id || `${letterId}:${eventType}:${payload?.date_created || ""}`);
  const occurredAt = String(payload?.date_created || new Date().toISOString());
  const detail = String(payload?.body?.tracking_events?.at?.(-1)?.description || payload?.body?.status || "").slice(0, 300);
  const { packageStatus, dispatchStatus } = packageStatusForEvent(eventType);

  db.prepare(
    "INSERT OR IGNORE INTO package_events (tenant_id, package_id, provider, provider_event_id, event, detail, occurred_at) VALUES (?, ?, 'lob', ?, ?, ?, ?)"
  ).run(dispatch.tenant_id, dispatch.package_id, eventId, eventType, detail, occurredAt);

  if (dispatchStatus) {
    db.prepare("UPDATE mail_dispatches SET status = ?, updated_at = ? WHERE id = ?").run(
      dispatchStatus,
      new Date().toISOString(),
      dispatch.id
    );
  }
  if (packageStatus) {
    const pkg = db.prepare("SELECT * FROM packages WHERE id = ?").get(dispatch.package_id);
    // Never walk a package backwards (a late "in transit" after "delivered").
    const rank = { Ready: 0, "In transit": 1, Delivered: 2, Returned: 3 };
    if (pkg && (rank[packageStatus] ?? 0) >= (rank[pkg.status] ?? 0)) {
      db.prepare("UPDATE packages SET status = ? WHERE id = ?").run(packageStatus, pkg.id);
      if (packageStatus === "Delivered" || packageStatus === "Returned") {
        audit(
          dispatch.tenant_id,
          "Lob webhook",
          packageStatus === "Delivered" ? "Package delivered" : "Package returned to sender",
          `${pkg.ref} · ${eventType}`
        );
      }
    }
  }

  res.status(200).json({ ok: true });
});

export default router;
