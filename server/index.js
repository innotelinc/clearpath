import "./env.js";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { attachSession, checkCsrf, requireUser } from "./auth.js";
import { upload } from "./uploads.js";
import { db, ensurePlatformAdmin, seedDemo, tenantForHost, tenantStats } from "./db.js";
import { aiConfigured, aiLabel } from "./ai.js";
import { mailStatus, retryPending } from "./mail.js";
import { bureau, fmtDate, fmtDateTime, fmtDay, initials, money, product, stageClass, statusClass, trackingUrl } from "./util.js";
import publicRoutes from "./routes/public.js";
import authRoutes from "./routes/auth.js";
import adminRoutes from "./routes/admin.js";
import portalRoutes from "./routes/portal.js";
import platformRoutes from "./routes/platform.js";
import lobWebhookRoutes from "./routes/lob-webhook.js";
import stripeWebhookRoutes from "./routes/stripe-webhook.js";
import billingRoutes from "./routes/billing.js";
import { lobConfigured, lobMode, lobWebhookSecret } from "./lob.js";
import { billingSummary, stripeConfigured, stripeMode, stripeWebhookSecret } from "./billing.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

if (process.env.SEED_DEMO !== "0") {
  const seeded = seedDemo();
  if (seeded) console.log("Clearpath: seeded demo tenants and records");
}

if (stripeConfigured()) {
  console.log(`Clearpath: Stripe billing enabled in ${stripeMode()} mode`);
  if (!stripeWebhookSecret()) {
    console.warn("Clearpath: STRIPE_WEBHOOK_SECRET is not set, so /webhooks/stripe refuses events until it is");
  }
}

if (lobConfigured) {
  console.log(`Clearpath: Lob print-and-mail enabled in ${lobMode} mode`);
  if (!lobWebhookSecret) {
    console.warn("Clearpath: LOB_WEBHOOK_SECRET is not set, so /webhooks/lob accepts unsigned delivery events");
  }
}

const mail = mailStatus();
if (mail.configured) {
  console.log(
    `Clearpath: mail delivery via ${mail.transport}${mail.server ? ` — ${mail.server} · ${mail.security} · ${mail.auth}` : ""}`
  );
}

const platformAdmin = ensurePlatformAdmin();
if (platformAdmin.created) {
  console.log(
    `Clearpath: platform operator created for ${platformAdmin.email}${platformAdmin.demo ? " (demo password Platform!2026 — set PLATFORM_ADMIN_EMAIL/PASSWORD in production)" : ""}`
  );
}

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.set("view engine", "ejs");
app.set("views", path.join(root, "views"));

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "img-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'",
      "font-src 'self'",
      "connect-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "object-src 'none'"
    ].join("; ")
  );
  if (process.env.COOKIE_SECURE === "1") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});

app.use(
  "/assets",
  express.static(path.join(root, "public"), {
    maxAge: process.env.NODE_ENV === "production" ? "7d" : 0,
    etag: true,
    index: false
  })
);

app.get("/healthz", (req, res) => {
  try {
    db.prepare("SELECT 1 AS ok").get();
    res.json({ ok: true, service: "clearpath", time: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ ok: false, error: "database unavailable" });
  }
});

// Provider webhooks arrive without a session or CSRF token, so they are parsed
// raw (the signature covers the exact bytes) and mounted before the app's
// cookie-authenticated pipeline.
app.use("/webhooks", express.raw({ type: "application/json", limit: "1mb" }), lobWebhookRoutes);
app.use("/webhooks", express.raw({ type: "application/json", limit: "1mb" }), stripeWebhookRoutes);

app.use(express.urlencoded({ extended: false, limit: "1mb" }));
app.use(express.json({ limit: "1mb" }));
app.use(attachSession);

app.use((req, res, next) => {
  res.locals.product = product;
  res.locals.path = req.path;
  res.locals.query = req.query;
  res.locals.notice = typeof req.query.notice === "string" ? req.query.notice.slice(0, 300) : "";
  res.locals.error = typeof req.query.error === "string" ? req.query.error.slice(0, 300) : "";
  res.locals.bureau = bureau;
  res.locals.money = money;
  res.locals.initials = initials;
  res.locals.trackingUrl = trackingUrl;
  res.locals.statusClass = statusClass;
  res.locals.fmtDate = fmtDate;
  res.locals.fmtDateTime = fmtDateTime;
  res.locals.fmtDay = fmtDay;
  res.locals.csrf = res.locals.csrf || "";
  res.locals.hostTenant = res.locals.tenant || tenantForHost(req.headers.host);
  res.locals.demoMode = process.env.SEED_DEMO !== "0";
  res.locals.aiConfigured = aiConfigured;
  res.locals.aiLabel = aiLabel();
  res.locals.billing =
    res.locals.tenant && res.locals.user && res.locals.user.role !== "client"
      ? billingSummary(res.locals.tenant)
      : null;
  res.locals.navCounts =
    res.locals.tenant && res.locals.user && res.locals.user.role !== "client"
      ? tenantStats(res.locals.tenant.id)
      : null;
  res.locals.stage = stageClass;
  next();
});

// Multipart bodies must be parsed before the CSRF check can see the token.
app.use(["/app/documents", "/portal/documents"], upload.single("file"));

app.use(checkCsrf);

app.use("/platform", platformRoutes);
app.use("/", publicRoutes);
app.use("/", authRoutes);
// Billing is owner-only, so it is mounted ahead of the workspace routes.
app.use("/app/billing", requireUser(["owner"]), billingRoutes);
app.use("/app", requireUser(["owner", "specialist"]), adminRoutes);
app.use("/portal", requireUser(["client"]), portalRoutes);

app.use((req, res) => {
  res.status(404).render("error", {
    title: "Not found",
    status: 404,
    message: "That page does not exist. Check the link, or head back to the workspace."
  });
});

app.use((err, req, res, next) => {
  console.error("Clearpath error:", err);
  if (res.headersSent) return next(err);
  const tooLarge = err.code === "LIMIT_FILE_SIZE";
  const status = tooLarge ? 413 : err.status || 500;
  res.status(status).render("error", {
    title: status === 413 ? "File too large" : status === 400 ? "Upload rejected" : "Something went wrong",
    status,
    message:
      status === 413
        ? "That upload is larger than the 10 MB limit."
        : status === 400
          ? err.message || "The file could not be accepted."
          : "The request could not be completed. Try again, or contact support if it keeps happening."
  });
});

const port = Number(process.env.PORT || 3000);
const server = app.listen(port, () => {
  console.log(`Clearpath listening on http://localhost:${port}`);
});

const cleanup = setInterval(() => {
  try {
    db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(new Date().toISOString());
    db.prepare("DELETE FROM password_resets WHERE expires_at < ?").run(new Date().toISOString());
  } catch { /* ignore */ }
}, 60 * 60 * 1000);
cleanup.unref?.();

retryPending().catch(() => {});
const mailRetry = setInterval(() => {
  retryPending().catch(() => {});
}, 5 * 60 * 1000);
mailRetry.unref?.();

process.on("unhandledRejection", (reason) => {
  console.error("Clearpath unhandled rejection:", reason);
});

const shutdown = (signal) => {
  console.log(`Clearpath: ${signal}, closing`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 8000).unref();
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

export default app;
