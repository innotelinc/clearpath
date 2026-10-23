import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, db, audit, auditEntries, nextDocRef, nextRef, tenantStats, verifyAuditChain } from "../db.js";
import { hashPassword, temporaryPassword, verifyPassword, strongEnough } from "../security.js";
import { letterPdf, letterText, labelsPdf, queuePdf } from "../pdf.js";
import {
  allRequests, clientDisputes, clientDocuments, clientMessages, clientPackages, clientRequests,
  clientTradelines, clientsMap, getClient, getDispute, getDocument, listClients, listDisputes,
  listDocuments, listPackages
} from "../data.js";
import { bureau, fmtDate, fmtDay, money, sendPdf } from "../util.js";
import { sizeLabel, sha256, storeUpload } from "../uploads.js";

const router = Router();

const tenantId = (req) => req.tenant.id;
const actor = (req) => req.user.name;

function back(res, target, { notice = "", error = "" } = {}) {
  const url = `${target}${target.includes("?") ? "&" : "?"}${notice ? `notice=${encodeURIComponent(notice)}` : ""}${error ? `${notice ? "&" : ""}error=${encodeURIComponent(error)}` : ""}`;
  res.redirect(303, url);
}

function fail(res, status, title, message) {
  return res.status(status).render("error", { title, status, message });
}

const STATUSES = ["Needs review", "Queued", "Mailed", "Awaiting response", "Escalated", "Deleted", "Closed"];

router.get("/", (req, res) => {
  const t = tenantId(req);
  const stats = tenantStats(t);
  const recentAudit = auditEntries(t, 6);
  const open = listDisputes(t, { status: "open" }).slice(0, 6);
  const ready = listPackages(t, { status: "Ready" });
  const pendingDocs = listDocuments(t, {}).filter((d) => d.status === "Pending review").slice(0, 5);
  const stages = db
    .prepare("SELECT stage, COUNT(*) AS n FROM clients WHERE tenant_id = ? GROUP BY stage")
    .all(t);
  res.render("admin/dashboard", {
    title: "Overview", page: "dashboard", stats, recentAudit, open, ready, pendingDocs, stages
  });
});

/* ---------------- clients ---------------- */

router.get("/clients", (req, res) => {
  const t = tenantId(req);
  const q = String(req.query.q || "");
  const stage = String(req.query.stage || "");
  const clients = listClients(t, { q, stage });
  const counts = db.prepare("SELECT stage, COUNT(*) AS n FROM clients WHERE tenant_id = ? GROUP BY stage").all(t);
  res.render("admin/clients", { title: "Clients", page: "clients", clients, q, stage, counts });
});

router.post("/clients", (req, res) => {
  const t = tenantId(req);
  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "").trim().toLowerCase();
  const phone = String(req.body.phone || "").trim();
  const stage = ["Onboarding", "Active", "Review", "Graduated"].includes(req.body.stage) ? req.body.stage : "Onboarding";
  if (name.length < 2 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return back(res, "/app/clients", { error: "A client name and a valid email are required." });
  }
  const ref = nextRef(t, "clients", "CL");
  const id = Number(
    db.prepare(
      `INSERT INTO clients (tenant_id, ref, name, email, phone, stage, portal_status, joined, tu, ex, eq, delta, utilization, docs_verified, docs_total, notes)
       VALUES (?, ?, ?, ?, ?, ?, 'Invited', ?, 600, 600, 600, 0, 0, 0, 6, ?)`
    ).run(t, ref, name, email, phone, stage, fmtDate(new Date()), "Added from the workspace.").lastInsertRowid
  );
  audit(t, actor(req), "Added client", `${name} · ${ref}`);
  back(res, `/app/clients/${id}`, { notice: `${name} added. Invite them to the portal when you are ready.` });
});

router.get("/clients/:id", (req, res) => {
  const t = tenantId(req);
  const client = getClient(t, req.params.id);
  if (!client) return fail(res, 404, "Client not found", "That client is not in this workspace.");
  const invites = db.prepare("SELECT id, email, role FROM users WHERE tenant_id = ? AND client_id = ?").all(t, client.id);
  res.render("admin/client", {
    title: client.name,
    page: "clients",
    clientRecord: client,
    disputes: clientDisputes(t, client.id),
    documents: clientDocuments(t, client.id),
    requests: clientRequests(t, client.id),
    messages: clientMessages(t, client.id),
    tradelines: clientTradelines(t, client.id),
    packages: clientPackages(t, client.id),
    portalUser: invites[0] || null,
    invite: null
  });
});

router.post("/clients/:id/notes", (req, res) => {
  const t = tenantId(req);
  const client = getClient(t, req.params.id);
  if (!client) return fail(res, 404, "Client not found", "That client is not in this workspace.");
  const notes = String(req.body.notes || "").slice(0, 2000);
  db.prepare("UPDATE clients SET notes = ? WHERE id = ? AND tenant_id = ?").run(notes, client.id, t);
  audit(t, actor(req), "Updated notes for", client.name);
  back(res, `/app/clients/${client.id}`, { notice: "Client notes saved." });
});

router.post("/clients/:id/tradelines", (req, res) => {
  const t = tenantId(req);
  const client = getClient(t, req.params.id);
  if (!client) return fail(res, 404, "Client not found", "That client is not in this workspace.");
  const creditor = String(req.body.creditor || "").trim();
  const mask = String(req.body.mask || "").trim().slice(0, 8);
  const type = ["Collection", "Late payment", "Charge-off", "Hard inquiry", "Repossession"].includes(req.body.type) ? req.body.type : "Collection";
  const bureauKey = ["tu", "ex", "eq"].includes(req.body.bureau) ? req.body.bureau : "tu";
  const reason = String(req.body.reason || "").trim();
  if (!creditor || !reason) return back(res, `/app/clients/${client.id}`, { error: "Creditor and dispute reason are required." });
  const evidence = String(req.body.evidence || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 8);
  const strength = Math.max(40, Math.min(99, Number(req.body.strength) || 75));
  db.prepare(
    `INSERT INTO tradelines (tenant_id, client_id, bureau, creditor, mask, type, balance, opened, reason, strength, evidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(t, client.id, bureauKey, creditor, mask, type, Math.max(0, Number(req.body.balance) || 0), String(req.body.opened || "").trim(), reason, strength, JSON.stringify(evidence));
  audit(t, actor(req), "Added tradeline", `${client.name} · ${creditor} ${mask}`);
  back(res, `/app/clients/${client.id}`, { notice: "Tradeline added." });
});

router.post("/clients/:id/invite", (req, res) => {
  if (req.user.role !== "owner") return fail(res, 403, "Owner only", "Only an agency owner can invite portal users.");
  const t = tenantId(req);
  const client = getClient(t, req.params.id);
  if (!client) return fail(res, 404, "Client not found", "That client is not in this workspace.");
  const existing = db.prepare("SELECT id FROM users WHERE tenant_id = ? AND client_id = ?").get(t, client.id);
  if (existing) return back(res, `/app/clients/${client.id}`, { error: "This client already has a portal account." });
  const password = temporaryPassword();
  const { hash, salt } = hashPassword(password);
  db.prepare("INSERT INTO users (tenant_id, email, name, role, client_id, password_hash, password_salt) VALUES (?, ?, ?, 'client', ?, ?, ?)")
    .run(t, client.email.toLowerCase(), client.name, client.id, hash, salt);
  db.prepare("UPDATE clients SET portal_status = 'Active' WHERE id = ?").run(client.id);
  audit(t, actor(req), "Invited client to the portal:", client.name);
  res.status(200).render("admin/client", {
    title: client.name,
    page: "clients",
    clientRecord: client,
    disputes: clientDisputes(t, client.id),
    documents: clientDocuments(t, client.id),
    requests: clientRequests(t, client.id),
    messages: clientMessages(t, client.id),
    tradelines: clientTradelines(t, client.id),
    packages: clientPackages(t, client.id),
    portalUser: { email: client.email },
    invite: { email: client.email, password }
  });
});

router.post("/clients/:id/request", (req, res) => {
  const t = tenantId(req);
  const client = getClient(t, req.params.id);
  if (!client) return fail(res, 404, "Client not found", "That client is not in this workspace.");
  const label = String(req.body.label || "").trim().slice(0, 80);
  const type = ["Identity", "Evidence", "Bureau response", "Agreement"].includes(req.body.type) ? req.body.type : "Identity";
  if (!label) return back(res, `/app/clients/${client.id}`, { error: "Name the document you need." });
  db.prepare("INSERT INTO doc_requests (tenant_id, client_id, label, type, due, note) VALUES (?, ?, ?, ?, ?, ?)")
    .run(t, client.id, label, type, String(req.body.due || "").slice(0, 20), String(req.body.note || "").slice(0, 300));
  audit(t, actor(req), "Requested " + label.toLowerCase() + " from", client.name);
  back(res, `/app/clients/${client.id}`, { notice: "Request is live in the client portal." });
});

router.post("/clients/:id/message", (req, res) => {
  const t = tenantId(req);
  const client = getClient(t, req.params.id);
  if (!client) return fail(res, 404, "Client not found", "That client is not in this workspace.");
  const body = String(req.body.body || "").trim().slice(0, 2000);
  if (!body) return back(res, `/app/clients/${client.id}`, { error: "Write a message first." });
  db.prepare("INSERT INTO messages (tenant_id, client_id, author_role, author_name, body) VALUES (?, ?, 'agency', ?, ?)")
    .run(t, client.id, actor(req), body);
  audit(t, actor(req), "Messaged", client.name);
  back(res, `/app/clients/${client.id}`, { notice: "Message sent to the portal." });
});

/* ---------------- disputes ---------------- */

router.get("/disputes", (req, res) => {
  const t = tenantId(req);
  const status = String(req.query.status || "");
  const q = String(req.query.q || "");
  const disputes = listDisputes(t, { status, q });
  const counts = db.prepare("SELECT status, COUNT(*) AS n FROM disputes WHERE tenant_id = ? GROUP BY status").all(t);
  res.render("admin/disputes", { title: "Disputes", page: "disputes", disputes, status, q, counts });
});

router.get("/disputes/:id", (req, res) => {
  const t = tenantId(req);
  const dispute = getDispute(t, req.params.id);
  if (!dispute) return fail(res, 404, "Dispute not found", "That dispute is not in this workspace.");
  const tradeline = {
    creditor: dispute.creditor || String(dispute.account).split("••")[0].trim(),
    mask: dispute.mask || (String(dispute.account).split("••")[1] || "").trim(),
    type: dispute.tradeline_type || "Collection",
    balance: dispute.balance || 0,
    reason: dispute.issue,
    evidence: dispute.evidence || "[]"
  };
  const shipment = db
    .prepare("SELECT * FROM packages WHERE tenant_id = ? AND client_id = ? AND bureau = ? ORDER BY id DESC LIMIT 1")
    .get(t, dispute.client_id, dispute.bureau);
  res.render("admin/dispute", {
    title: dispute.ref,
    page: "disputes",
    dispute,
    tradeline,
    shipment,
    letter: letterText({ tenant: req.tenant, client: { name: dispute.client_name, email: dispute.client_email, phone: dispute.client_phone }, dispute, tradeline }),
    statuses: STATUSES
  });
});

router.get("/disputes/:id/letter.pdf", (req, res) => {
  const t = tenantId(req);
  const dispute = getDispute(t, req.params.id);
  if (!dispute) return fail(res, 404, "Dispute not found", "That dispute is not in this workspace.");
  const client = { name: dispute.client_name, email: dispute.client_email, phone: dispute.client_phone };
  const tradeline = {
    creditor: dispute.creditor || String(dispute.account).split("••")[0].trim(),
    mask: dispute.mask || (String(dispute.account).split("••")[1] || "").trim(),
    type: dispute.tradeline_type || "Collection",
    balance: dispute.balance || 0,
    reason: dispute.issue,
    evidence: dispute.evidence || "[]"
  };
  sendPdf(res, `${dispute.ref}-${dispute.client_name.replace(/\s+/g, "-")}.pdf`, letterPdf({ tenant: req.tenant, client, dispute, tradeline }));
});

router.post("/disputes", (req, res) => {
  const t = tenantId(req);
  const client = getClient(t, req.body.client_id);
  if (!client) return fail(res, 400, "Choose a client", "Select a client before creating a dispute.");
  const tradelineId = req.body.tradeline_id ? Number(req.body.tradeline_id) : null;
  let tradeline = null;
  if (tradelineId) {
    tradeline = db.prepare("SELECT * FROM tradelines WHERE id = ? AND tenant_id = ? AND client_id = ?").get(tradelineId, t, client.id);
    if (!tradeline) return fail(res, 400, "Invalid tradeline", "That tradeline does not belong to this client.");
  }
  const bureauKey = tradeline ? tradeline.bureau : ["tu", "ex", "eq"].includes(req.body.bureau) ? req.body.bureau : "tu";
  const account = tradeline ? `${tradeline.creditor} ••${tradeline.mask}` : String(req.body.account || "").trim();
  const issue = tradeline ? tradeline.reason : String(req.body.issue || "").trim();
  if (!account || !issue) return back(res, `/app/clients/${client.id}`, { error: "An account and a dispute reason are required." });
  const ref = nextRef(t, "disputes", "DSP");
  const round = Math.max(1, Math.min(5, Number(req.body.round) || 1));
  const confidence = Math.max(40, Math.min(99, Number(req.body.confidence) || (tradeline ? tradeline.strength : 80)));
  const disputeId = Number(
    db.prepare(
      `INSERT INTO disputes (tenant_id, client_id, tradeline_id, ref, bureau, account, issue, round, status, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Needs review', ?)`
    ).run(t, client.id, tradeline ? tradeline.id : null, ref, bureauKey, account, issue, round, confidence).lastInsertRowid
  );
  audit(t, actor(req), "Created dispute", `${ref} · ${client.name}`);
  back(res, `/app/disputes/${disputeId}`, { notice: `${ref} created and ready for review.` });
});

router.post("/disputes/:id", (req, res) => {
  const t = tenantId(req);
  const dispute = getDispute(t, req.params.id);
  if (!dispute) return fail(res, 404, "Dispute not found", "That dispute is not in this workspace.");
  const status = STATUSES.includes(req.body.status) ? req.body.status : dispute.status;
  const round = Math.max(1, Math.min(5, Number(req.body.round) || dispute.round));
  const mailed = String(req.body.mailed || "").slice(0, 25) || null;
  const due = String(req.body.due || "").slice(0, 25) || null;
  db.prepare("UPDATE disputes SET status = ?, round = ?, mailed = ?, due = ? WHERE id = ? AND tenant_id = ?")
    .run(status, round, mailed, due, dispute.id, t);
  if (status !== dispute.status) {
    audit(t, actor(req), "Changed dispute status to " + status + " for", dispute.ref);
  } else {
    audit(t, actor(req), "Updated dispute", dispute.ref);
  }
  back(res, `/app/disputes/${dispute.id}`, { notice: "Dispute updated." });
});

/* ---------------- mailroom ---------------- */

router.get("/mailroom", (req, res) => {
  const t = tenantId(req);
  const packages = listPackages(t, {});
  // A letter already sitting in a package that has not been mailed cannot be packaged again.
  const eligible = db
    .prepare(
      `SELECT d.*, c.name AS client_name FROM disputes d JOIN clients c ON c.id = d.client_id
       WHERE d.tenant_id = ? AND d.status IN ('Needs review','Queued')
         AND NOT EXISTS (
           SELECT 1 FROM package_items pi JOIN packages p ON p.id = pi.package_id
           WHERE pi.dispute_id = d.id AND p.status IN ('Ready','In transit')
         )
       ORDER BY c.name, d.id`
    )
    .all(t);
  res.render("admin/mailroom", {
    title: "Mailroom",
    page: "mailroom",
    packages,
    eligible,
    ready: packages.filter((p) => p.status === "Ready"),
    map: clientsMap(t)
  });
});

router.post("/mailroom/packages", (req, res) => {
  const t = tenantId(req);
  const ids = (Array.isArray(req.body.dispute_ids) ? req.body.dispute_ids : [req.body.dispute_ids])
    .filter(Boolean)
    .map(Number);
  if (!ids.length) return back(res, "/app/mailroom", { error: "Select at least one letter." });
  const rows = ids
    .map((id) => db.prepare("SELECT * FROM disputes WHERE id = ? AND tenant_id = ?").get(id, t))
    .filter((d) => d && ["Needs review", "Queued"].includes(d.status));
  if (!rows.length) return back(res, "/app/mailroom", { error: "Those letters are no longer eligible." });

  const methodBase = req.body.method === "priority" ? "Priority mail" : req.body.method === "standard" ? "Standard mail" : "Certified mail";
  const returnReceipt = req.body.return_receipt === "on" && req.body.method !== "standard";
  const method = methodBase + (returnReceipt ? " + return receipt" : "");
  const unit = (req.body.method === "priority" ? 9.45 : req.body.method === "standard" ? 1.1 : 8.2) + (returnReceipt ? 1.65 : 0);

  const groups = new Map();
  rows.forEach((d) => {
    const key = `${d.client_id}:${d.bureau}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(d);
  });

  const refs = [];
  for (const [key, letters] of groups) {
    const [clientId, bureauKey] = key.split(":");
    const ref = nextRef(t, "packages", "PKG");
    const packageId = Number(
      db.prepare(
        `INSERT INTO packages (tenant_id, client_id, ref, bureau, letters, method, status, cost)
         VALUES (?, ?, ?, ?, ?, ?, 'Ready', ?)`
      ).run(t, Number(clientId), ref, bureauKey, letters.length, method, unit).lastInsertRowid
    );
    const addItem = db.prepare("INSERT OR IGNORE INTO package_items (package_id, dispute_id) VALUES (?, ?)");
    const queue = db.prepare("UPDATE disputes SET status = 'Queued' WHERE id = ? AND tenant_id = ? AND status = 'Needs review'");
    letters.forEach((letter) => {
      addItem.run(packageId, letter.id);
      queue.run(letter.id, t);
    });
    refs.push(ref);
    audit(t, actor(req), "Created mailing package", `${ref} · ${letters.length} letters`);
  }
  back(res, "/app/mailroom", { notice: `${refs.join(" · ")} ready to print. One envelope per client and bureau.` });
});

router.post("/mailroom/:id/mailed", (req, res) => {
  const t = tenantId(req);
  const pkg = db.prepare("SELECT * FROM packages WHERE id = ? AND tenant_id = ?").get(Number(req.params.id), t);
  if (!pkg) return fail(res, 404, "Package not found", "That package is not in this workspace.");
  const tracking = String(req.body.tracking || "").trim().slice(0, 40) || null;
  db.prepare("UPDATE packages SET status = 'In transit', tracking = ? WHERE id = ? AND tenant_id = ?").run(tracking, pkg.id, t);
  const mailed = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const items = db.prepare("SELECT dispute_id FROM package_items WHERE package_id = ?").all(pkg.id);
  if (items.length) {
    const mark = db.prepare("UPDATE disputes SET status = 'Mailed', mailed = ? WHERE id = ? AND tenant_id = ?");
    items.forEach((item) => mark.run(mailed, item.dispute_id, t));
  } else {
    // Legacy packages created before items were recorded.
    db.prepare("UPDATE disputes SET status = 'Mailed', mailed = ? WHERE tenant_id = ? AND client_id = ? AND bureau = ? AND status IN ('Needs review','Queued')")
      .run(mailed, t, pkg.client_id, pkg.bureau);
  }
  audit(t, actor(req), "Mailed package", `${pkg.ref}${tracking ? " · " + tracking : ""}`);
  back(res, "/app/mailroom", { notice: `${pkg.ref} marked in transit.` });
});

router.get("/mailroom/labels.pdf", (req, res) => {
  const t = tenantId(req);
  const ready = listPackages(t, { status: "Ready" });
  sendPdf(res, "clearpath-labels.pdf", labelsPdf(req.tenant, ready, clientsMap(t)));
});

router.get("/mailroom/queue.pdf", (req, res) => {
  const t = tenantId(req);
  const map = clientsMap(t);
  const ready = listPackages(t, { status: "Ready" });
  let letters = db
    .prepare(
      `SELECT d.id FROM package_items pi
       JOIN packages p ON p.id = pi.package_id
       JOIN disputes d ON d.id = pi.dispute_id
       WHERE p.tenant_id = ? AND p.status = 'Ready'
       GROUP BY d.id ORDER BY MIN(p.id), d.id`
    )
    .all(t);
  if (!letters.length) {
    // No itemised packages yet (seeded or imported data): fall back to eligible letters.
    letters = listDisputes(t, {}).filter((d) => ["Needs review", "Queued"].includes(d.status));
  }
  const withInput = letters.map((d) => {
    const full = getDispute(t, d.id);
    const tradeline = {
      creditor: full.creditor || String(full.account).split("••")[0].trim(),
      mask: full.mask || (String(full.account).split("••")[1] || "").trim(),
      type: full.tradeline_type || "Collection",
      balance: full.balance || 0,
      reason: full.issue,
      evidence: full.evidence || "[]"
    };
    return {
      ...d,
      __input: {
        tenant: req.tenant,
        client: { name: full.client_name, email: full.client_email, phone: full.client_phone },
        dispute: full,
        tradeline
      }
    };
  });
  sendPdf(res, "clearpath-mailing-queue.pdf", queuePdf(req.tenant, ready, withInput, map));
});

/* ---------------- documents ---------------- */

router.get("/documents", (req, res) => {
  const t = tenantId(req);
  const q = String(req.query.q || "");
  const type = String(req.query.type || "");
  res.render("admin/documents", {
    title: "Documents",
    page: "documents",
    documents: listDocuments(t, { q, type }),
    requests: allRequests(t),
    q,
    type,
    clients: listClients(t, {})
  });
});

router.post("/documents", (req, res) => {
  const t = tenantId(req);
  const client = getClient(t, req.body.client_id);
  if (!client) return fail(res, 400, "Choose a client", "Pick the client this document belongs to.");
  if (!req.file) return back(res, "/app/documents", { error: "Choose a PDF or image to upload." });
  const stored = storeUpload(req.file, t, client.id);
  const digest = sha256(req.file.buffer);
  const ref = nextDocRef(t);
  db.prepare(
    `INSERT INTO documents (tenant_id, client_id, ref, name, type, status, size, sha256, stored_name, uploaded_by, uploaded_at)
     VALUES (?, ?, ?, ?, ?, 'Pending review', ?, ?, ?, 'agency', ?)`
  ).run(t, client.id, ref, req.file.originalname.slice(0, 180), String(req.body.type || "Evidence").slice(0, 40), sizeLabel(req.file.size), digest, stored, new Date().toISOString());
  db.prepare("UPDATE clients SET docs_total = docs_total + 1 WHERE id = ?").run(client.id);
  audit(t, actor(req), "Uploaded document for", client.name);
  back(res, "/app/documents", { notice: `${req.file.originalname} uploaded · SHA-256 ${digest.slice(0, 12)}…` });
});

router.post("/documents/:id/verify", (req, res) => {
  const t = tenantId(req);
  const doc = getDocument(t, req.params.id);
  if (!doc) return fail(res, 404, "Document not found", "That document is not in this workspace.");
  db.prepare("UPDATE documents SET status = 'Verified' WHERE id = ? AND tenant_id = ?").run(doc.id, t);
  const client = getClient(t, doc.client_id);
  if (client) db.prepare("UPDATE clients SET docs_verified = MIN(docs_total, docs_verified + 1) WHERE id = ?").run(client.id);
  audit(t, actor(req), "Verified document", doc.name);
  back(res, "/app/documents", { notice: `${doc.name} verified.` });
});

router.get("/documents/:id/download", (req, res) => {
  const t = tenantId(req);
  const doc = getDocument(t, req.params.id);
  if (!doc) return fail(res, 404, "Document not found", "That document is not in this workspace.");
  if (!doc.stored_name) return fail(res, 404, "No file attached", "This seeded record has metadata only. Upload a file to download it.");
  const file = path.join(DATA_DIR, "uploads", path.basename(doc.stored_name));
  if (!fs.existsSync(file)) return fail(res, 410, "File missing", "The stored file is no longer on this server.");
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="${doc.name.replace(/[^a-zA-Z0-9_.-]+/g, "-")}"`);
  res.setHeader("Cache-Control", "private, no-store");
  fs.createReadStream(file).pipe(res);
});

router.post("/documents/request", (req, res) => {
  const t = tenantId(req);
  const client = getClient(t, req.body.client_id);
  if (!client) return fail(res, 400, "Choose a client", "Pick the client you need a document from.");
  const label = String(req.body.label || "").trim().slice(0, 80);
  if (!label) return back(res, "/app/documents", { error: "Name the document you need." });
  db.prepare("INSERT INTO doc_requests (tenant_id, client_id, label, type, due, note) VALUES (?, ?, ?, ?, ?, ?)")
    .run(t, client.id, label, String(req.body.type || "Identity").slice(0, 40), String(req.body.due || "").slice(0, 20), String(req.body.note || "").slice(0, 300));
  audit(t, actor(req), "Requested " + label.toLowerCase() + " from", client.name);
  back(res, "/app/documents", { notice: "Request is live in the client portal." });
});

/* ---------------- audit ---------------- */

router.get("/audit", (req, res) => {
  const t = tenantId(req);
  const entries = auditEntries(t, 300);
  res.render("admin/audit", {
    title: "Audit log",
    page: "audit",
    entries,
    verification: verifyAuditChain(t)
  });
});

router.get("/audit.csv", (req, res) => {
  const t = tenantId(req);
  const rows = ["seq,when,actor,action,target,prev_hash,hash"].concat(
    auditEntries(t, 5000)
      .slice()
      .reverse()
      .map((e) =>
        [e.seq, e.created_at, e.actor_name, e.action, e.target, e.prev_hash, e.hash]
          .map((v) => `"${String(v).replace(/"/g, '""')}"`)
          .join(",")
      )
  );
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="clearpath-audit.csv"');
  res.send(rows.join("\n"));
});

/* ---------------- settings ---------------- */

router.get("/settings", (req, res) => {
  const t = tenantId(req);
  const team = db.prepare("SELECT id, name, email, role, last_login_at FROM users WHERE tenant_id = ? ORDER BY role, name").all(t);
  res.render("admin/settings", {
    title: "Settings",
    page: "settings",
    team,
    invited: null,
    saved: req.query.notice || ""
  });
});

router.post("/settings/branding", (req, res) => {
  const t = tenantId(req);
  if (req.user.role !== "owner") return fail(res, 403, "Owner only", "Only an agency owner can change branding.");
  const name = String(req.body.name || "").trim().slice(0, 80);
  const accent = /^#[0-9a-fA-F]{6}$/.test(req.body.accent || "") ? req.body.accent : req.tenant.accent;
  if (name.length < 2) return back(res, "/app/settings", { error: "Workspace name is required." });
  db.prepare(
    `UPDATE tenants SET name = ?, brand_name = ?, tagline = ?, logo = ?, accent = ?, support_email = ?, support_phone = ?, address = ?, portal_name = ?, welcome = ?, domain = ?
     WHERE id = ?`
  ).run(
    name,
    String(req.body.brand_name || name).trim().slice(0, 80),
    String(req.body.tagline || "").trim().slice(0, 120),
    String(req.body.logo || "").trim().toUpperCase().slice(0, 3),
    accent,
    String(req.body.support_email || "").trim().slice(0, 120),
    String(req.body.support_phone || "").trim().slice(0, 40),
    String(req.body.address || "").trim().slice(0, 160),
    String(req.body.portal_name || "Client portal").trim().slice(0, 40),
    String(req.body.welcome || "").trim().slice(0, 300),
    String(req.body.domain || req.tenant.domain || "").trim().slice(0, 120),
    t
  );
  audit(t, actor(req), "Updated workspace branding", name);
  back(res, "/app/settings", { notice: "Branding updated across the workspace, portal and PDFs." });
});

router.post("/settings/team", (req, res) => {
  const t = tenantId(req);
  if (req.user.role !== "owner") return fail(res, 403, "Owner only", "Only an agency owner can invite teammates.");
  const name = String(req.body.name || "").trim().slice(0, 80);
  const email = String(req.body.email || "").trim().toLowerCase();
  const role = req.body.role === "owner" ? "owner" : "specialist";
  if (name.length < 2 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return back(res, "/app/settings", { error: "A name and valid email are required." });
  }
  if (db.prepare("SELECT id FROM users WHERE tenant_id = ? AND lower(email) = ?").get(t, email)) {
    return back(res, "/app/settings", { error: "That email already has an account here." });
  }
  const password = temporaryPassword();
  const { hash, salt } = hashPassword(password);
  db.prepare("INSERT INTO users (tenant_id, email, name, role, password_hash, password_salt) VALUES (?, ?, ?, ?, ?, ?)")
    .run(t, email, name, role, hash, salt);
  audit(t, actor(req), "Invited teammate", `${name} · ${role}`);
  const team = db.prepare("SELECT id, name, email, role, last_login_at FROM users WHERE tenant_id = ? ORDER BY role, name").all(t);
  res.render("admin/settings", {
    title: "Settings",
    page: "settings",
    team,
    invited: { name, email, role, password },
    saved: ""
  });
});

router.post("/settings/password", (req, res) => {
  const current = String(req.body.current || "");
  const next = String(req.body.next || "");
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  if (!verifyPassword(current, row.password_salt, row.password_hash)) {
    return back(res, "/app/settings", { error: "Your current password is not correct." });
  }
  if (!strongEnough(next)) {
    return back(res, "/app/settings", { error: "Use at least 10 characters with letters and a number." });
  }
  const { hash, salt } = hashPassword(next);
  db.prepare("UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?").run(hash, salt, req.user.id);
  audit(req.tenant.id, actor(req), "Changed their password", req.user.email);
  back(res, "/app/settings", { notice: "Password updated." });
});

export default router;
