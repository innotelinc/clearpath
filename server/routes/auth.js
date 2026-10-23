import { Router } from "express";
import {
  authenticate,
  clearLoginAttempts,
  destroySession,
  issueSession,
  throttleLogin
} from "../auth.js";
import { tenantForHost } from "../db.js";
import { product, safeNext } from "../util.js";

const router = Router();

function loginPage(req, res, { mode, error = "", email = "" }) {
  const tenant = tenantForHost(req.headers.host);
  if (req.user) {
    return res.redirect(302, req.user.role === "client" ? "/portal" : "/app");
  }
  res.render("login", {
    title: `${mode === "client" ? "Client sign in" : "Agency sign in"} — ${product.name}`,
    tenant,
    page: "login",
    mode,
    error,
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

  if (throttleLogin(key)) {
    return res.status(429).render("login", {
      title: "Too many attempts", tenant, page: "login", mode, email,
      error: "Too many sign-in attempts. Wait fifteen minutes and try again.",
      next: safeNext(req.body.next, "/app")
    });
  }

  const user = authenticate(tenant.id, email, req.body.password, ["owner", "specialist"]);
  if (!user) {
    return res.status(401).render("login", {
      title: "Agency sign in", tenant, page: "login", mode, email,
      error: "That email and password do not match an agency account on this workspace.",
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

  if (throttleLogin(key)) {
    return res.status(429).render("login", {
      title: "Too many attempts", tenant, page: "login", mode, email,
      error: "Too many sign-in attempts. Wait fifteen minutes and try again.",
      next: "/portal"
    });
  }

  const user = authenticate(tenant.id, email, req.body.password, ["client"]);
  if (!user) {
    return res.status(401).render("login", {
      title: "Client sign in", tenant, page: "login", mode, email,
      error: "That email and password do not match a client account on this portal.",
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

export default router;
