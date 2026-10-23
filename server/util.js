export const product = {
  name: "Clearpath",
  company: "Denovo Credit",
  domain: "denovocredit.com",
  support: process.env.SUPPORT_EMAIL || "hello@denovocredit.com"
};

export const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export const money = (value) =>
  "$" +
  Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const initials = (name) =>
  String(name || "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();

export const fmtDate = (value, fallback = "—") => {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};

export const fmtDateTime = (value) => {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
};

export const fmtDay = (value) => {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

export const bureau = {
  tu: { name: "TransUnion", short: "TU", cls: "tu" },
  ex: { name: "Experian", short: "EX", cls: "ex" },
  eq: { name: "Equifax", short: "EQ", cls: "eq" }
};

export const statusClass = (status) =>
  ({
    "Needs review": "amber",
    Queued: "violet",
    Mailed: "blue",
    "Awaiting response": "blue",
    Escalated: "rose",
    Deleted: "teal",
    Closed: "gray",
    Ready: "amber",
    "In transit": "blue",
    Delivered: "teal",
    Returned: "rose",
    Verified: "teal",
    "Pending review": "amber",
    Expiring: "rose",
    Active: "blue",
    Onboarding: "violet",
    Review: "amber",
    Graduated: "teal"
  })[status] || "gray";

export const stageClass = (stage) => statusClass(stage);

export const safeNext = (value, fallback) => {
  const next = String(value || "");
  if (!next.startsWith("/") || next.startsWith("//")) return fallback;
  return next;
};

/**
 * Public tracking link for a carrier barcode. Certified mail and Priority mail
 * use USPS; the UPS and FedEx patterns are recognised so an imported number
 * still links to the right place. Returns "" when there is no number.
 */
export function trackingUrl(tracking) {
  const value = String(tracking || "").replace(/[\s-]+/g, "").toUpperCase();
  if (!value) return "";
  if (/^1Z[0-9A-Z]{16}$/.test(value)) return `https://www.ups.com/track?loc=en_US&tracknum=${value}`;
  if (/^[0-9]{12}$/.test(value)) return `https://www.fedex.com/fedextrack/?trknbr=${value}`;
  return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(value)}`;
}

export function sendPdf(res, filename, buffer) {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename.replace(/[^a-zA-Z0-9_.-]+/g, "-")}"`);
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(buffer);
}
