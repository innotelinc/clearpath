import { Router } from "express";
import {
  authenticate,
  clearLoginAttempts,
  destroySession,
  issueSession,
  throttle,
  throttleLogin
} from "../auth.js";
import { audit, db, tenantForHost } from "../db.js";
import { consumeReset, findReset, passwordProblem, sendResetLink, setPassword } from "../accounts.js";
import { verifyPassword } from "../security.js";
import { product, safeNext } from "../util.js";

const router = Router();

const RESET_WINDOW = { max: 5, windowMs: 15 * 60 * 1000 };

function loginPage(req, res, { mode, error = "", notice = "", email = "" }) {
  const tenant = tenantForHost(req.headers.host);
  if (req.user) {
    if (req.user.must_change_password) return res.redirect(302, "/change-password");
    return res.redirect(302, req.user.role === "client" ? "/portal" : "/app");
  }
  res.setHeader("Cache-Control", "no-store");
  res.render("login", {
    title: `${mode === "client" ? "Client sign in" : "Agency sign in"} — ${product.name}`,
    tenant,
    page: "login",
    mode,
    error,
    notice,
    email,
    next: safeNext(req.query.next, mode === "client" ? "/portal" : "/app")
  });
}

router.get("/login", (req, res) => loginPage(req, res, { mode: "agency" }));
router.get("/portal/login", (req, res) => loginPage(req, res, { mode: "client" }));

router.post("/login", (req, res) => {
  const mode = "agency";
  const email = String(req.body.email || "").trim();
  const tenant = tenantForHost(req.headers.host);
  const key = `${req.ip}:${email.toLowerCase()}`;

  if (tenant.status === "suspended") {
    return res.status(403).render("login", {
      title: "Workspace suspended", tenant, page: "login", mode, email,
      error: "This workspace is suspended by the platform operator. No one can sign in until it is reactivated.",
      notice: "",
      next: safeNext(req.body.next, "/app")
    });
  }

  if (throttleLogin(key)) {
    return res.status(429).render("login", {
      title: "Too many attempts", tenant, page: "login", mode, email,
      error: "Too many sign-in attempts. Wait fifteen minutes and try again.",
      notice: "",
      next: safeNext(req.body.next, "/app")
    });
  }

  const user = authenticate(tenant.id, email, req.body.password, ["owner", "specialist"]);
  if (!user) {
    return res.status(401).render("login", {
      title: "Agency sign in", tenant, page: "login", mode, email,
      error: "That email and password do not match an agency account on this workspace.",
      notice: "",
      next: safeNext(req.body.next, "/app")
    });
  }

  clearLoginAttempts(key);
  issueSession(res, user);
  res.redirect(303, safeNext(req.body.next, "/app"));
});

router.post("/portal/login", (req, res) => {
  const mode = "client";
  const email = String(req.body.email || "").trim();
  const tenant = tenantForHost(req.headers.host);
  const key = `${req.ip}:portal:${email.toLowerCase()}`;

  if (tenant.status === "suspended") {
    return res.status(403).render("login", {
      title: "Workspace suspended", tenant, page: "login", mode, email,
      error: "This portal is suspended by the platform operator. No one can sign in until it is reactivated.",
      notice: "",
      next: "/portal"
    });
  }

  if (throttleLogin(key)) {
    return res.status(429).render("login", {
      title: "Too many attempts", tenant, page: "login", mode, email,
      error: "Too many sign-in attempts. Wait fifteen minutes and try again.",
      notice: "",
      next: "/portal"
    });
  }

  const user = authenticate(tenant.id, email, req.body.password, ["client"]);
  if (!user) {
    return res.status(401).render("login", {
      title: "Client sign in", tenant, page: "login", mode, email,
      error: "That email and password do not match a client account on this portal.",
      notice: "",
      next: "/portal"
    });
  }

  clearLoginAttempts(key);
  issueSession(res, user);
  res.redirect(303, "/portal");
});

router.post("/logout", (req, res) => {
  destroySession(req, res);
  res.redirect(303, "/");
});

/* ---------------- password reset ---------------- */

router.get("/forgot", (req, res) => {
  const mode = req.query.mode === "client" ? "client" : "agency";
  const tenant = tenantForHost(req.headers.host);
  res.render("forgot", {
    title: `Reset your password — ${product.name}`,
    tenant,
    page: "forgot",
    mode,
    sent: req.query.sent === "1",
    error: ""
  });
});

router.post("/forgot", async (req, res) => {
  const mode = req.body.mode === "client" ? "client" : "agency";
  const email = String(req.body.email || "").trim().toLowerCase();
  const tenant = tenantForHost(req.headers.host);

  // The response never says whether the address exists.
  if (email && !throttle(`forgot:${req.ip}:${email}`, RESET_WINDOW)) {
    const user = db
      .prepare("SELECT * FROM users WHERE tenant_id = ? AND lower(email) = ?")
      .get(tenant.id, email);
    const allowed = user && (mode === "client" ? user.role === "client" : user.role !== "client");
    if (allowed) {
      try {
        req.tenant = tenant;
        await sendResetLink({ tenant, req, user, ip: req.ip });
      } catch (err) {
        console.error("Clearpath: password reset email failed —", err?.message || err);
      }
    }
  }

  res.redirect(303, `/forgot?sent=1&mode=${mode}`);
});

router.get("/reset/:token", (req, res) => {
  const reset = findReset(req.params.token);
  if (!reset) {
    return res.status(400).render("error", {
      title: "Reset link expired",
      status: 400,
      message: "That reset link has already been used or has expired. Request a new one from the sign-in page."
    });
  }
  res.render("reset", {
    title: `Choose a new password — ${product.name}`,
    tenant: tenantForHost(req.headers.host),
    page: "reset",
    token: req.params.token,
    reset,
    mode: reset.role === "client" ? "client" : "agency",
    error: ""
  });
});

router.post("/reset/:token", (req, res) => {
  const reset = findReset(req.params.token);
  if (!reset) {
    return res.status(400).render("error", {
      title: "Reset link expired",
      status: 400,
      message: "That reset link has already been used or has expired. Request a new one from the sign-in page."
    });
  }

  const password = String(req.body.password || "");
  const confirm = String(req.body.confirm || "");
  const renderError = (error) =>
    res.status(400).render("reset", {
      title: `Choose a new password — ${product.name}`,
      tenant: tenantForHost(req.headers.host),
      page: "reset",
      token: req.params.token,
      reset,
      mode: reset.role === "client" ? "client" : "agency",
      error
    });

  const problem = passwordProblem(password);
  if (problem) return renderError(problem);
  if (password !== confirm) return renderError("Those two passwords do not match.");

  const consumed = consumeReset(req.params.token, password);
  if (!consumed) {
    return res.status(400).render("error", {
      title: "Reset link expired",
      status: 400,
      message: "That link was used a moment ago. Sign in with your new password, or request another link."
    });
  }

  audit(consumed.tenant_id, consumed.name, "Reset their password", consumed.email);
  const target = consumed.role === "client" ? "/portal/login" : "/login";
  res.redirect(303, `${target}?reset=1`);
});

/* ---------------- password change (signed in) ---------------- */

function renderChange(req, res, { error = "", status = 200 } = {}) {
  res.status(status).render("change-password", {
    title: `Change your password — ${product.name}`,
    tenant: req.tenant,
    page: "change-password",
    mode: req.user.role === "client" ? "client" : "agency",
    error,
    next: safeNext(req.query.next, req.user.role === "client" ? "/portal" : "/app")
  });
}

router.get("/change-password", (req, res) => {
  if (!req.user) return res.redirect(302, "/login?next=%2Fchange-password");
  renderChange(req, res);
});

router.post("/change-password", (req, res) => {
  if (!req.user) return res.redirect(302, "/login?next=%2Fchange-password");
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  const current = String(req.body.current || "");
  const next = String(req.body.next || "");
  const confirm = String(req.body.confirm || "");
  const target = safeNext(req.body.after, req.user.role === "client" ? "/portal" : "/app");

  if (!row) return res.status(400).render("error", { title: "Account missing", status: 400, message: "This account no longer exists." });

  if (!Number(row.must_change_password)) {
    if (!verifyPassword(current, row.password_salt, row.password_hash)) {
      return renderChange(req, res, { status: 400, error: "Your current password is not correct." });
    }
  }
  if (passwordProblem(next)) {
    return renderChange(req, res, { status: 400, error: passwordProblem(next) });
  }
  if (next !== confirm) {
    return renderChange(req, res, { status: 400, error: "Those two passwords do not match." });
  }

  setPassword(row.id, next);
  // Keep this session, drop every other one.
  db.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").run(row.id, req.session?.id || "");
  audit(row.tenant_id, row.name, "Changed their password", row.email);

  res.redirect(303, `${target}${target.includes("?") ? "&" : "?"}notice=${encodeURIComponent("Password updated.")}`);
});

export default router;
