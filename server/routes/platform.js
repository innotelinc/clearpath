/**
 * Platform console: the operator surface above the tenants.
 *
 * This mount answers questions a workspace owner cannot: which workspaces
 * exist, how much of the product each one actually uses, and whether one has
 * to be suspended. It is deliberately separate from /app — an operator never
 * reads client dispute detail here, only the roster and the usage counts.
 */
import { Router } from "express";
import {
  audit,
  db,
  deleteTenant,
  getSetting,
  listTenants,
  resetInstall,
  setSetting,
  tenantClients,
  tenantFootprint,
  tenantTeam,
  tenantUsage
} from "../db.js";
import {
  PLANS,
  billingSummary,
  checkStripeConnection,
  maskKey,
  stripeConfigured,
  stripeKeySource,
  stripeMode,
  stripeSecretKey,
  stripeWebhookSecret
} from "../billing.js";
import { createAccount, emailDeliveryNote, sendCredentials } from "../accounts.js";
import { mailConfigured } from "../mail.js";
import { throttle } from "../auth.js";
import { verifyPassword } from "../security.js";
import {
  authenticatePlatform,
  demoPlatformAdmin,
  destroyPlatformSession,
  issuePlatformSession,
  requirePlatform
} from "../platform-auth.js";

const router = Router();

const ADMIN_ROLES = ["owner", "specialist"];

function safeNext(value) {
  const next = String(value || "");
  return next.startsWith("/platform") && !next.startsWith("//") ? next : "/platform";
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function cleanDomain(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return null;
  const host = raw.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return null;
  return host.slice(0, 120);
}

function platformActor(req) {
  return `${req.platformAdmin.name} (platform)`;
}

/* ---------------- sign in ---------------- */

function loginPage(req, res, { error = "", email = "", status = 200 } = {}) {
  const demo = process.env.SEED_DEMO !== "0" ? demoPlatformAdmin() : null;
  // A remembered login page carries an old CSRF token; never serve it from cache.
  res.setHeader("Cache-Control", "no-store");
  res.status(status).render("platform/login", {
    title: "Platform console",
    page: "login",
    layout: false,
    error,
    email,
    next: safeNext(req.query.next || req.body?.next),
    demoEmail: demo ? demo.email : null
  });
}

router.get("/login", (req, res) => {
  if (req.platformAdmin) return res.redirect(303, "/platform");
  loginPage(req, res, { email: String(req.query.email || "") });
});

router.post("/login", (req, res) => {
  const email = String(req.body.email || "").trim().slice(0, 160);
  const overBudget = throttle(`platform-login:${req.ip}`, { max: 10 });
  if (overBudget) {
    return loginPage(req, res, {
      email,
      status: 429,
      error: "Too many attempts from this address. Wait fifteen minutes and try again."
    });
  }
  const admin = authenticatePlatform(email, req.body.password);
  if (!admin) {
    // The most common mistake is a workspace owner typing their tenant
    // credentials here. Only say so when the password actually proves it, so
    // the hint cannot be used to discover which emails exist.
    const workspaceUser = db
      .prepare("SELECT email, password_hash, password_salt FROM users WHERE lower(email) = lower(?)")
      .all(email)
      .find((row) => verifyPassword(req.body.password, row.password_salt, row.password_hash));
    console.warn(
      `Clearpath: platform sign-in rejected for ${email || "(blank)"} — ${workspaceUser ? "workspace credentials" : "no matching operator"}`
    );
    return loginPage(req, res, {
      email,
      status: 401,
      error: workspaceUser
        ? `That is a workspace account, not an operator. Sign in at /login instead — the platform console only takes operator emails.`
        : "That email and password do not match a platform account."
    });
  }
  issuePlatformSession(res, admin);
  res.redirect(303, safeNext(req.body.next));
});

router.post("/logout", (req, res) => {
  destroyPlatformSession(req, res);
  res.redirect(303, "/platform/login");
});

/* Everything below needs an operator session. */
router.use(requirePlatform);

function tenantsPage(req, res, { error = "", status = 200 } = {}) {
  const tenants = listTenants().map((tenant) => ({
    ...tenant,
    usage: tenantUsage(tenant.id),
    billing: billingSummary(tenant)
  }));
  const totals = tenants.reduce(
    (acc, tenant) => {
      acc.tenants += 1;
      if (tenant.status === "active") acc.active += 1;
      else acc.suspended += 1;
      acc.clients += tenant.usage.clients;
      acc.seats += tenant.usage.seats;
      acc.openDisputes += tenant.usage.openDisputes;
      acc.documents += tenant.usage.documents;
      return acc;
    },
    { tenants: 0, active: 0, suspended: 0, clients: 0, seats: 0, openDisputes: 0, documents: 0 }
  );
  res.status(status).render("platform/index", {
    title: "Workspaces",
    page: "tenants",
    tenants,
    totals,
    error
  });
}

router.get("/", (req, res) => {
  tenantsPage(req, res);
});

/* ---------------- provision a workspace ---------------- */

router.get("/tenants/new", (req, res) => {
  res.render("platform/new", {
    title: "New workspace",
    page: "new",
    form: { name: "", slug: "", domain: "", brand_name: "", owner_name: "", owner_email: "" }
  });
});

router.post("/tenants", async (req, res) => {
  const form = {
    name: String(req.body.name || "").trim().slice(0, 80),
    slug: slugify(req.body.slug),
    domain: String(req.body.domain || "").trim(),
    brand_name: String(req.body.brand_name || "").trim().slice(0, 80),
    owner_name: String(req.body.owner_name || "").trim().slice(0, 80),
    owner_email: String(req.body.owner_email || "").trim().toLowerCase().slice(0, 160)
  };

  const problem =
    (!form.name && "Give the workspace a name.") ||
    (form.slug && !/^[a-z0-9][a-z0-9-]{1,39}$/.test(form.slug) && "The slug can only use lowercase letters, numbers and dashes.") ||
    (!form.owner_name && "The first owner needs a name.") ||
    (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.owner_email) && "Enter a valid email for the first owner.") ||
    (form.domain && !cleanDomain(form.domain) && "The domain should look like northstar.clearpath.test.") ||
    "";

  if (problem) {
    return res.status(400).render("platform/new", { title: "New workspace", page: "new", form, error: problem });
  }

  form.slug = form.slug || slugify(form.name);
  if (db.prepare("SELECT id FROM tenants WHERE slug = ?").get(form.slug)) {
    return res.status(400).render("platform/new", {
      title: "New workspace",
      page: "new",
      form,
      error: `The slug "${form.slug}" is already taken.`
    });
  }

  const tenantId = Number(
    db
      .prepare(
        `INSERT INTO tenants (slug, name, domain, brand_name, accent, portal_name, status)
         VALUES (?, ?, ?, ?, '#1f5eff', 'Client portal', 'active')`
      )
      .run(form.slug, form.name, cleanDomain(form.domain), form.brand_name || form.name).lastInsertRowid
  );
  const tenant = db.prepare("SELECT * FROM tenants WHERE id = ?").get(tenantId);

  audit(tenantId, platformActor(req), "Provisioned workspace", `${tenant.name} (${tenant.slug})`);

  const { user, password } = createAccount({
    tenantId,
    name: form.owner_name,
    email: form.owner_email,
    role: "owner"
  });
  const row = await sendCredentials({ tenant, req, user, password, role: "owner" });

  res.status(201).render("platform/tenant", {
    title: tenant.name,
    page: "tenants",
    tenant,
    billing: billingSummary(tenant),
    usage: tenantUsage(tenantId),
    footprint: tenantFootprint(tenantId),
    team: tenantTeam(tenantId),
    clients: [],
    invite: {
      name: form.owner_name,
      email: form.owner_email,
      password: mailConfigured ? null : password,
      delivery: emailDeliveryNote(row)
    }
  });
});

/* ---------------- one workspace ---------------- */

router.get("/tenants/:id", (req, res) => {
  const tenant = db.prepare("SELECT * FROM tenants WHERE id = ?").get(Number(req.params.id));
  if (!tenant) {
    return res.status(404).render("error", {
      title: "Workspace not found",
      status: 404,
      message: "No workspace has that id."
    });
  }
  tenantPage(req, res, tenant);
});

router.post("/tenants/:id/suspend", (req, res) => {
  const tenant = db.prepare("SELECT * FROM tenants WHERE id = ?").get(Number(req.params.id));
  if (!tenant) {
    return res.status(404).render("error", {
      title: "Workspace not found",
      status: 404,
      message: "No workspace has that id."
    });
  }
  if (tenant.status === "suspended") {
    return res.redirect(303, `/platform/tenants/${tenant.id}`);
  }
  const note = String(req.body.note || "").trim().slice(0, 240) || null;
  db.prepare("UPDATE tenants SET status = 'suspended', suspended_at = ?, suspended_note = ? WHERE id = ?").run(
    new Date().toISOString(),
    note,
    tenant.id
  );
  // Suspension has to bite immediately: sign every seat and portal client out.
  db.prepare("DELETE FROM sessions WHERE tenant_id = ?").run(tenant.id);
  audit(tenant.id, platformActor(req), "Suspended workspace", note || "No reason recorded");
  res.redirect(303, `/platform/tenants/${tenant.id}`);
});

router.post("/tenants/:id/reactivate", (req, res) => {
  const tenant = db.prepare("SELECT * FROM tenants WHERE id = ?").get(Number(req.params.id));
  if (!tenant) {
    return res.status(404).render("error", {
      title: "Workspace not found",
      status: 404,
      message: "No workspace has that id."
    });
  }
  db.prepare("UPDATE tenants SET status = 'active', suspended_at = NULL, suspended_note = NULL WHERE id = ?").run(tenant.id);
  audit(tenant.id, platformActor(req), "Reactivated workspace", "Workspace access restored");
  res.redirect(303, `/platform/tenants/${tenant.id}`);
});

/* ---------------- remove a workspace ---------------- */

/**
 * The page a workspace's own console renders, with the reason it did not change.
 *
 * A destructive form that fails has to answer with the page that was submitted —
 * not an error page — because the operator is still looking at the workspace and
 * the confirmation is still theirs to type.
 */
function tenantPage(req, res, tenant, { error = "", status = 200 } = {}) {
  res.status(status).render("platform/tenant", {
    title: tenant.name,
    page: "tenants",
    tenant,
    billing: billingSummary(tenant),
    usage: tenantUsage(tenant.id),
    footprint: tenantFootprint(tenant.id),
    team: tenantTeam(tenant.id),
    clients: tenantClients(tenant.id),
    invite: null,
    error
  });
}

router.post("/tenants/:id/delete", (req, res) => {
  const tenant = db.prepare("SELECT * FROM tenants WHERE id = ?").get(Number(req.params.id));
  if (!tenant) {
    return res.status(404).render("error", {
      title: "Workspace not found",
      status: 404,
      message: "No workspace has that id."
    });
  }
  // Deleting is the one action here with nothing to undo it, so it is gated on
  // typing the slug: a mis-click cannot supply it, and a stale tab cannot either.
  if (String(req.body.confirm || "").trim().toLowerCase() !== tenant.slug.toLowerCase()) {
    return tenantPage(req, res, tenant, {
      status: 400,
      error: `Nothing was deleted. Type the workspace slug (${tenant.slug}) to confirm — this removes its clients, disputes and documents for good.`
    });
  }

  const receipt = deleteTenant(tenant.id);
  const { clients, seats, disputes, documents } = receipt.footprint;
  // The tenant's own audit chain went with the tenant, so the operator's record of
  // this is the console log. Deleting a workspace is not a workspace event.
  console.warn(
    `Clearpath: workspace ${tenant.name} (${tenant.slug}) deleted by ${platformActor(req)} — ` +
      `${clients} clients, ${seats} seats, ${disputes} disputes, ${documents} documents, ${receipt.files} file(s); ` +
      `snapshot ${receipt.backup.dir}`
  );
  const notice =
    `${tenant.name} deleted — ${clients} client${clients === 1 ? "" : "s"}, ${seats} seat${seats === 1 ? "" : "s"}, ` +
    `${documents} document${documents === 1 ? "" : "s"} and ${receipt.files} file${receipt.files === 1 ? "" : "s"} removed. ` +
    `A copy of the database and those files is in backups/${receipt.backup.name}.`;
  res.redirect(303, `/platform?notice=${encodeURIComponent(notice)}`);
});

/* ---------------- back to a clean install ---------------- */

router.post("/reset", (req, res) => {
  if (String(req.body.confirm || "").trim().toUpperCase() !== "RESET") {
    return tenantsPage(req, res, {
      status: 400,
      error: "Nothing was reset. Type RESET in capitals to confirm — it removes every workspace and every client on this deployment."
    });
  }
  const removed = resetInstall();
  console.warn(
    `Clearpath: system reset by ${platformActor(req)} — ${removed.tenants} workspace(s), ${removed.clients} client(s), ` +
      `${removed.files} file(s) removed; operator accounts and payment settings kept; snapshot ${removed.backup.dir}`
  );
  const notice =
    `Reset complete — ${removed.tenants} workspace${removed.tenants === 1 ? "" : "s"} and ` +
    `${removed.clients} client${removed.clients === 1 ? "" : "s"} removed. Your operator account and payment settings are untouched. ` +
    `The previous database and its files are in backups/${removed.backup.name}.`;
  res.redirect(303, `/platform?notice=${encodeURIComponent(notice)}`);
});

/* ---------------- invite another owner ---------------- */

router.post("/tenants/:id/owner", async (req, res) => {
  const tenant = db.prepare("SELECT * FROM tenants WHERE id = ?").get(Number(req.params.id));
  if (!tenant) {
    return res.status(404).render("error", {
      title: "Workspace not found",
      status: 404,
      message: "No workspace has that id."
    });
  }
  const name = String(req.body.owner_name || "").trim().slice(0, 80);
  const email = String(req.body.owner_email || "").trim().toLowerCase().slice(0, 160);
  const back = (error) => tenantPage(req, res, tenant, { status: 400, error });

  if (!name) return back("Give the owner a name.");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return back("Enter a valid email address.");
  if (db.prepare("SELECT id FROM users WHERE tenant_id = ? AND lower(email) = ?").get(tenant.id, email)) {
    return back("That email already has an account in this workspace.");
  }

  const { user, password } = createAccount({ tenantId: tenant.id, name, email, role: "owner" });
  const row = await sendCredentials({ tenant, req, user, password, role: "owner" });
  audit(tenant.id, platformActor(req), "Invited a workspace owner", email);
  res.render("platform/tenant", {
    title: tenant.name,
    page: "tenants",
    tenant,
    billing: billingSummary(tenant),
    usage: tenantUsage(tenant.id),
    footprint: tenantFootprint(tenant.id),
    team: tenantTeam(tenant.id),
    clients: tenantClients(tenant.id),
    invite: { name, email, password: mailConfigured ? null : password, delivery: emailDeliveryNote(row) }
  });
});

/* ---------------- payment settings ---------------- */

function paymentsPage(req, res, { notice = "", error = "", result = null, status = 200 } = {}) {
  res.setHeader("Cache-Control", "no-store");
  res.status(status).render("platform/billing", {
    title: "Payments",
    page: "billing",
    configured: stripeConfigured(),
    mode: stripeMode(),
    source: stripeKeySource(),
    secretMask: maskKey(stripeSecretKey()),
    webhookMask: maskKey(stripeWebhookSecret()),
    secretFromEnv: Boolean(process.env.STRIPE_SECRET_KEY),
    webhookFromEnv: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
    storedSecret: Boolean(getSetting("stripe_secret_key")),
    storedWebhook: Boolean(getSetting("stripe_webhook_secret")),
    plans: PLANS,
    webhookUrl: `${String(process.env.APP_ORIGIN || "").replace(/\/+$/, "") || "https://your-host"}/webhooks/stripe`,
    result,
    notice,
    error
  });
}

router.get("/billing", (req, res) => paymentsPage(req, res));

router.post("/billing", (req, res) => {
  const secret = String(req.body.secret_key || "").trim();
  const webhook = String(req.body.webhook_secret || "").trim();
  const clearStored = req.body.clear_stored === "1";

  if (secret && !/^(sk|rk)_(live|test)_/.test(secret)) {
    return paymentsPage(req, res, {
      status: 400,
      error: "That does not look like a Stripe secret key — they start with sk_live_ or sk_test_ (restricted keys rk_). Nothing was saved."
    });
  }
  if (webhook && !webhook.startsWith("whsec_")) {
    return paymentsPage(req, res, {
      status: 400,
      error: "Stripe webhook secrets start with whsec_. Copy it from the endpoint's detail page in the Stripe dashboard. Nothing was saved."
    });
  }

  if (clearStored) {
    setSetting("stripe_secret_key", "", platformActor(req));
    setSetting("stripe_webhook_secret", "", platformActor(req));
    console.warn(`Clearpath: Stripe keys cleared from the console by ${platformActor(req)}`);
    return paymentsPage(req, res, {
      notice: process.env.STRIPE_SECRET_KEY
        ? "Stored keys removed — the deployment is back on the environment variables."
        : "Stored keys removed. Billing is off until a key is set again."
    });
  }

  if (!secret && !webhook) {
    return paymentsPage(req, res, { status: 400, error: "Paste a key (or the webhook secret) to save." });
  }

  if (secret) setSetting("stripe_secret_key", secret, platformActor(req));
  if (webhook) setSetting("stripe_webhook_secret", webhook, platformActor(req));
  console.log(
    `Clearpath: Stripe settings updated by ${platformActor(req)} — key ${maskKey(stripeSecretKey())}, webhook ${stripeWebhookSecret() ? "set" : "missing"}`
  );
  return paymentsPage(req, res, {
    notice: `${secret ? "Secret key saved" : "Secret key unchanged"}${webhook ? " · webhook secret saved" : ""}. New checkouts use them immediately — no restart needed.`
  });
});

router.post("/billing/test", async (req, res) => {
  try {
    const result = await checkStripeConnection();
    if (result.mode === "live" && !result.livemode) {
      return paymentsPage(req, res, {
        status: 502,
        result,
        error: "The key looks live but Stripe reports test mode. Check which key was pasted."
      });
    }
    return paymentsPage(req, res, {
      result,
      notice: `Stripe accepted the key — ${result.livemode ? "live" : "test"} mode, answered in ${result.ms} ms.`
    });
  } catch (err) {
    console.warn(`Clearpath: Stripe key check failed — ${err.message}`);
    return paymentsPage(req, res, { status: 502, error: err.message });
  }
});

export default router;
