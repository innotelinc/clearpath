/**
 * Lob print-and-mail integration.
 *
 * Enabled only when LOB_API_KEY is set; until then every Lob surface stays
 * hidden and the mailroom keeps its print-and-post workflow. The key prefix
 * (test_ / live_) decides the mode, and test letters never produce tracking
 * events, which the UI says plainly.
 *
 * Lob is spoken to over plain REST with the API key as HTTP Basic auth (key as
 * username, empty password). Certified mail is a First Class letter with
 * extra_service: "certified".
 */
import crypto from "node:crypto";

const DEFAULT_BASE_URL = "https://api.lob.com/v1";

export const lobApiKey = String(process.env.LOB_API_KEY || "").trim();
export const lobBaseUrl = String(process.env.LOB_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
export const lobWebhookSecret = String(process.env.LOB_WEBHOOK_SECRET || "").trim();
export const lobConfigured = lobApiKey.length > 0;
export const lobMode = lobApiKey.startsWith("test_") ? "test" : lobApiKey ? "live" : "off";

export class LobError extends Error {
  constructor(message, { status = 0 } = {}) {
    super(message);
    this.name = "LobError";
    this.status = status;
  }
}

function authHeader() {
  return `Basic ${Buffer.from(`${lobApiKey}:`).toString("base64")}`;
}

/**
 * Split a free-text address into Lob's fields.
 *
 * Handles both shapes the app stores: a bureau block ("TransUnion Consumer
 * Solutions\nP.O. Box 2000\nChester, PA 19016") and the tenant's single-line
 * "2200 Market St, Suite 410 · San Francisco, CA 94114".
 */
export function parseAddress(raw, fallbackName = "") {
  const cleaned = String(raw || "").replace(/\r/g, "").trim();
  if (!cleaned) return null;

  let segments = cleaned
    .split(/\n|·/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (segments.length === 1) {
    segments = segments[0].split(",").map((part) => part.trim()).filter(Boolean);
  }
  if (segments.length < 2) return null;

  const locality = segments[segments.length - 1];
  const match = locality.match(/^(.+?),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/);
  if (!match) return null;
  const [, city, state, zip] = match;

  const rest = segments.slice(0, -1);
  let name = fallbackName;
  if (rest.length > 1 && !/\d/.test(rest[0])) name = rest.shift();
  if (!rest.length) return null;

  return {
    name: String(name || fallbackName || "Clearpath").slice(0, 40),
    address_line1: rest[0].slice(0, 64),
    ...(rest[1] ? { address_line2: rest.slice(1).join(", ").slice(0, 64) } : {}),
    address_city: city.slice(0, 40),
    address_state: state,
    address_zip: zip,
    address_country: "US"
  };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Lob renders this HTML into the printed letter. */
export function letterHtml(text) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Clearpath letter</title></head>
<body style="margin:0;padding:0">
<pre style="font-family:Georgia,'Times New Roman',serif;font-size:11.5pt;line-height:1.45;white-space:pre-wrap;margin:0">${escapeHtml(
    text
  )}</pre>
</body></html>`;
}

async function request(pathname, { method = "GET", body } = {}) {
  if (!lobConfigured) throw new LobError("Lob is not enabled. Set LOB_API_KEY and restart.");
  let response;
  try {
    response = await fetch(`${lobBaseUrl}${pathname}`, {
      method,
      headers: {
        authorization: authHeader(),
        "content-type": "application/json",
        accept: "application/json"
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000)
    });
  } catch (err) {
    const code = err?.cause?.code || err?.code || "";
    throw new LobError(`Could not reach Lob${code ? ` (${code})` : ""}. Try again, or print the package.`);
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    /* no JSON body */
  }
  if (!response.ok) {
    const detail = payload?.error?.message || payload?.message || "";
    throw new LobError(`Lob returned ${response.status}${detail ? `: ${String(detail).slice(0, 240)}` : ""}`, {
      status: response.status
    });
  }
  return payload;
}

/**
 * Create one certified First Class letter.
 *
 * `to` and `from` are parsed address objects; `text` is the exact letter body
 * that was approved, so the print matches what the package page shows.
 */
export async function createCertifiedLetter({ to, from, text, description, metadata = {} }) {
  const payload = await request("/letters", {
    method: "POST",
    body: {
      description: String(description || "Clearpath dispute letter").slice(0, 255),
      to,
      from,
      html: letterHtml(text),
      mail_type: "usps_first_class",
      extra_service: "certified",
      color: false,
      metadata: Object.fromEntries(
        Object.entries(metadata)
          .filter(([, value]) => value !== undefined && value !== null)
          .map(([key, value]) => [key, String(value).slice(0, 500)])
      )
    }
  });

  return {
    id: payload?.id || "",
    tracking: payload?.tracking_number || "",
    expectedDelivery: payload?.expected_delivery_date || "",
    status: payload?.status || "created"
  };
}

export async function getLetter(id) {
  return request(`/letters/${encodeURIComponent(id)}`);
}

/**
 * Lob signs webhooks with HMAC-SHA256 over "<timestamp>.<raw body>".
 * Without LOB_WEBHOOK_SECRET the endpoint still works but logs a warning at
 * boot; setting the secret is the documented way to authenticate deliveries.
 */
export function verifyLobSignature(rawBody, signature, timestamp) {
  if (!lobWebhookSecret) return true;
  if (!signature || !timestamp) return false;
  const expected = crypto
    .createHmac("sha256", lobWebhookSecret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  const left = Buffer.from(String(signature), "utf8");
  const right = Buffer.from(expected, "utf8");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function signatureFresh(timestamp, toleranceSeconds = 300) {
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return false;
  return Math.abs(Date.now() / 1000 - seconds) <= toleranceSeconds;
}

/** Map a Lob event to the mailroom's package status vocabulary. */
export function packageStatusForEvent(eventType) {
  const event = String(eventType || "");
  if (/delivered$/.test(event)) return { packageStatus: "Delivered", dispatchStatus: "delivered" };
  if (/returned_to_sender|\.issue$/.test(event)) return { packageStatus: "Returned", dispatchStatus: "returned" };
  if (/pickup_available$/.test(event)) return { packageStatus: "In transit", dispatchStatus: "pickup available" };
  if (/mailed$/.test(event)) return { packageStatus: "In transit", dispatchStatus: "mailed" };
  if (/in_transit|in_local_area|processed_for_delivery|re-routed/.test(event)) {
    return { packageStatus: "In transit", dispatchStatus: "in transit" };
  }
  return { packageStatus: null, dispatchStatus: null };
}
