import { Router } from "express";
import { audit, db, tenantForHost } from "../db.js";
import { product } from "../util.js";

const router = Router();

router.get("/", (req, res) => {
  const tenant = tenantForHost(req.headers.host);
  res.render("landing", {
    title: `${product.company} — ${product.name}`,
    tenant,
    page: "home"
  });
});

const legal = {
  privacy: {
    title: "Privacy notice",
    intro:
      "This demo deployment stores workspace records in a local SQLite database on the server that runs it. No analytics, advertising pixels or third-party trackers are loaded.",
    sections: [
      ["What we collect", "Agency account details, client records entered by the agency, documents uploaded by staff or clients, and an audit log of changes. Passwords are stored as salted scrypt hashes, never in plain text."],
      ["How it is used", "Solely to operate the workspace and the client portal: preparing disputes, tracking mail, organizing evidence and communicating with the client."],
      ["Retention", "Records remain until an agency deletes them or the deployment is removed. A production deployment should define a written retention schedule and support deletion requests."],
      ["Your choices", "Contact the agency that invited you to the portal to access, correct or delete your information. For this demo, no real consumer data should be entered."],
      ["Security", "Session cookies are HTTP-only and same-site; forms are CSRF protected; every query is scoped to the signed-in tenant. Production requires HTTPS, backups, monitoring and an independent security review."]
    ]
  },
  terms: {
    title: "Terms of use",
    intro:
      "Clearpath is software for credit repair agencies. It is not a credit repair organization, a law firm, or a consumer reporting agency, and it does not provide legal advice.",
    sections: [
      ["Demo status", "This deployment is a product demonstration with synthetic records. Do not enter real consumer data until a production agreement, hosting review and compliance program are in place."],
      ["No guarantees", "Removing or correcting information depends on the furnisher and the credit bureaus. No outcome, score change or timeline is guaranteed."],
      ["Acceptable use", "Use the workspace only for lawful disputes supported by evidence. Do not upload false documents, impersonate a consumer, or send threats."],
      ["Accounts", "Agency administrators are responsible for their team's access and for revoking it when someone leaves. Client portal accounts are personal and must not be shared."],
      ["Contact", `Questions about these terms: ${product.support}.`]
    ]
  }
};

router.get("/legal/:doc", (req, res, next) => {
  const doc = legal[req.params.doc];
  if (!doc) return next();
  res.render("legal", {
    title: `${doc.title} — ${product.name}`,
    tenant: tenantForHost(req.headers.host),
    page: "legal",
    doc
  });
});

router.post("/contact", (req, res) => {
  const tenant = tenantForHost(req.headers.host);
  const name = String(req.body.name || "").trim().slice(0, 80);
  const email = String(req.body.email || "").trim().toLowerCase().slice(0, 120);
  const agency = String(req.body.agency || "").trim().slice(0, 120);
  const size = String(req.body.size || "").trim().slice(0, 20);
  const message = String(req.body.message || "").trim().slice(0, 1000);

  if (name.length < 2 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.redirect(303, "/?sent=0#contact");
  }

  db.prepare("INSERT INTO leads (tenant_id, name, email, agency, size, message) VALUES (?, ?, ?, ?, ?, ?)")
    .run(tenant ? tenant.id : null, name, email, agency, size, message);
  if (tenant) {
    audit(tenant.id, "Website", "Requested a walkthrough", `${name} · ${agency || "independent"}`);
  }
  res.redirect(303, "/?sent=1#contact");
});

router.get("/robots.txt", (req, res) => {
  res.type("text/plain").send("User-agent: *\nDisallow: /app\nDisallow: /portal\nAllow: /\n");
});

export default router;
