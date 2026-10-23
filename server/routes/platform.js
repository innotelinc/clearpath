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
  listTenants,
  tenantClients,
  tenantTeam,
  tenantUsage
} from "../db.js";
import { createAccount, emailDeliveryNote, sendCredentials } from "../accounts.js";
import { mailConfigured } from "../mail.js";
import { throttle } from "../auth.js";
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
    return loginPage(req, res, { email, status: 401, error: "That email and password do not match a platform account." });
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

router.get("/", (req, res) => {
  const tenants = listTenants().map((tenant) => ({ ...tenant, usage: tenantUsage(tenant.id) }));
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
  res.render("platform/index", {
    title: "Workspaces",
    page: "tenants",
    tenants,
    totals
  });
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
    usage: tenantUsage(tenantId),
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
  res.render("platform/tenant", {
    title: tenant.name,
    page: "tenants",
    tenant,
    usage: tenantUsage(tenant.id),
    team: tenantTeam(tenant.id),
    clients: tenantClients(tenant.id),
    invite: null
  });
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
  const back = (error) =>
    res.status(400).render("platform/tenant", {
      title: tenant.name,
      page: "tenants",
      tenant,
      usage: tenantUsage(tenant.id),
      team: tenantTeam(tenant.id),
      clients: tenantClients(tenant.id),
      invite: null,
      error
    });

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
    usage: tenantUsage(tenant.id),
    team: tenantTeam(tenant.id),
    clients: tenantClients(tenant.id),
    invite: { name, email, password: mailConfigured ? null : password, delivery: emailDeliveryNote(row) }
  });
});

export default router;
