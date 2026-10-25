import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, db, audit, auditEntries, emailRows, latestInsight, nextDocRef, nextRef, tenantStats, verifyAuditChain } from "../db.js";
import { aiChat, aiConfigured, parseJsonReply } from "../ai.js";
import { approvePipeline, runPipeline, scanPipeline } from "../pipeline.js";
import { hashPassword, verifyPassword, strongEnough } from "../security.js";
import { createAccount, emailDeliveryNote, sendCredentials, sendResetLink } from "../accounts.js";
import { clearMailSettings, deliver, mailConfiguredFor, mailStatus, saveMailSettings, sendMail } from "../mail.js";
import { STRATEGIES, TONES, generateDraft, getDraft, listDrafts, parseList } from "../studio.js";
import { BUREAUS, letterPdf, letterText, labelsPdf, queuePdf } from "../pdf.js";
import { createCertifiedLetter, lobConfigured, lobMode, parseAddress } from "../lob.js";
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
const truthy = (value) => /^(1|true|yes|on)$/i.test(String(value || ""));

/** Freeze the exact printed text of the letters in a package. */
function captureLetters(tenant, pkg, letterIds, t) {
  const snapshot = db.prepare(
    "INSERT OR IGNORE INTO package_letters (tenant_id, package_id, dispute_id, ref, account, bureau, body) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  letterIds.forEach((id) => {
    const full = getDispute(t, id);
    if (!full) return;
    const tradeline = {
      creditor: full.creditor || String(full.account).split("••")[0].trim(),
      mask: full.mask || (String(full.account).split("••")[1] || "").trim(),
      type: full.tradeline_type || "Collection",
      balance: full.balance || 0,
      reason: full.issue,
      evidence: full.evidence || "[]"
    };
    const body = letterText({
      tenant,
      client: { name: full.client_name, email: full.client_email, phone: full.client_phone },
      dispute: full,
      tradeline
    });
    snapshot.run(t, pkg.id, full.id, full.ref, full.account, full.bureau, body);
  });
}

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

function renderClient(req, res, client, extra = {}) {
  const t = tenantId(req);
  const portalUser = db
    .prepare("SELECT id, email, role, must_change_password FROM users WHERE tenant_id = ? AND client_id = ? ORDER BY id LIMIT 1")
    .get(t, client.id) || null;
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
    portalUser,
    insight: latestInsight(t, client.id) || null,
    aiConfigured,
    invite: null,
    ...extra
  });
}

router.get("/clients/:id", (req, res) => {
  const t = tenantId(req);
  const client = getClient(t, req.params.id);
  if (!client) return fail(res, 404, "Client not found", "That client is not in this workspace.");
  renderClient(req, res, client);
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

router.post("/clients/:id/invite", async (req, res) => {
  if (req.user.role !== "owner") return fail(res, 403, "Owner only", "Only an agency owner can invite portal users.");
  const t = tenantId(req);
  const client = getClient(t, req.params.id);
  if (!client) return fail(res, 404, "Client not found", "That client is not in this workspace.");
  const existing = db.prepare("SELECT id FROM users WHERE tenant_id = ? AND client_id = ?").get(t, client.id);
  if (existing) return back(res, `/app/clients/${client.id}`, { error: "This client already has a portal account. Email them a reset link instead." });

  const { user, password } = createAccount({
    tenantId: t,
    name: client.name,
    email: client.email,
    role: "client",
    clientId: client.id
  });
  db.prepare("UPDATE clients SET portal_status = 'Active' WHERE id = ?").run(client.id);
  audit(t, actor(req), "Invited client to the portal:", client.name);

  let delivery = "The invitation email could not be queued.";
  try {
    const row = await sendCredentials({ tenant: req.tenant, req, user, password, role: "client" });
    delivery = emailDeliveryNote(row);
    if (row.status !== "failed") audit(t, actor(req), "Emailed portal invitation to", client.email);
  } catch (err) {
    delivery = `The invitation email could not be queued: ${err.message}`;
  }

  renderClient(req, res, client, {
    invite: { email: client.email, password: mailConfiguredFor(t) ? null : password, delivery }
  });
});

router.post("/clients/:id/portal-reset", async (req, res) => {
  if (req.user.role !== "owner") return fail(res, 403, "Owner only", "Only an agency owner can reset a portal password.");
  const t = tenantId(req);
  const client = getClient(t, req.params.id);
  if (!client) return fail(res, 404, "Client not found", "That client is not in this workspace.");
  const user = db.prepare("SELECT * FROM users WHERE tenant_id = ? AND client_id = ?").get(t, client.id);
  if (!user) return back(res, `/app/clients/${client.id}`, { error: "This client has no portal account yet." });

  try {
    const { row } = await sendResetLink({ tenant: req.tenant, req, user, ip: req.ip });
    back(res, `/app/clients/${client.id}`, { notice: emailDeliveryNote(row) });
  } catch (err) {
    back(res, `/app/clients/${client.id}`, { error: `The reset email could not be queued: ${err.message}` });
  }
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
  const sentAt = new Date().toISOString();
  db.prepare("UPDATE packages SET status = 'In transit', tracking = ?, sent_at = ? WHERE id = ? AND tenant_id = ?").run(
    tracking,
    sentAt,
    pkg.id,
    t
  );
  const mailed = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const items = db.prepare("SELECT dispute_id FROM package_items WHERE package_id = ?").all(pkg.id);
  let letterIds = items.map((item) => item.dispute_id).filter(Boolean);
  if (letterIds.length) {
    const mark = db.prepare("UPDATE disputes SET status = 'Mailed', mailed = ? WHERE id = ? AND tenant_id = ?");
    letterIds.forEach((id) => mark.run(mailed, id, t));
  } else {
    // Legacy packages created before items were recorded.
    letterIds = db
      .prepare(
        "SELECT id FROM disputes WHERE tenant_id = ? AND client_id = ? AND bureau = ? AND status IN ('Needs review','Queued')"
      )
      .all(t, pkg.client_id, pkg.bureau)
      .map((row) => row.id);
    db.prepare("UPDATE disputes SET status = 'Mailed', mailed = ? WHERE tenant_id = ? AND client_id = ? AND bureau = ? AND status IN ('Needs review','Queued')")
      .run(mailed, t, pkg.client_id, pkg.bureau);
  }

  // Freeze what was actually posted. Disputes keep evolving; this cannot.
  captureLetters(req.tenant, pkg, letterIds, t);

  audit(t, actor(req), "Mailed package", `${pkg.ref}${tracking ? " · " + tracking : ""}`);
  back(res, "/app/mailroom", { notice: `${pkg.ref} marked in transit. What was sent is stored on the package.` });
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

/* Hand the package to Lob: print, postage and certified mail in one call. */
router.post("/mailroom/:id/send", async (req, res) => {
  const t = tenantId(req);
  const pkg = db.prepare("SELECT * FROM packages WHERE id = ? AND tenant_id = ?").get(Number(req.params.id), t);
  if (!pkg) return fail(res, 404, "Package not found", "That package is not in this workspace.");
  const target = `/app/mailroom/${pkg.id}`;

  if (!lobConfigured) {
    return back(res, target, {
      error: "Lob is not enabled yet. Set LOB_API_KEY (and LOB_WEBHOOK_SECRET) and restart, or mark the package mailed by hand."
    });
  }
  if (pkg.status !== "Ready") {
    return back(res, target, { error: "Only a package that is still ready can be sent through Lob." });
  }

  const from = parseAddress(req.tenant.address, req.tenant.brand_name || req.tenant.name);
  if (!from) {
    return back(res, target, {
      error: "Add the agency's full mailing address in Settings first — Lob needs a return address with city, state and ZIP."
    });
  }

  const items = db.prepare("SELECT dispute_id FROM package_items WHERE package_id = ?").all(pkg.id);
  let letterIds = items.map((item) => item.dispute_id).filter(Boolean);
  if (!letterIds.length) {
    letterIds = db
      .prepare(
        "SELECT id FROM disputes WHERE tenant_id = ? AND client_id = ? AND bureau = ? AND status IN ('Needs review','Queued')"
      )
      .all(t, pkg.client_id, pkg.bureau)
      .map((row) => row.id);
  }
  if (!letterIds.length) return back(res, target, { error: "This package has no letters to send." });

  const sent = [];
  const problems = [];
  for (const id of letterIds) {
    const full = getDispute(t, id);
    if (!full) continue;
    const bureauEntry = BUREAUS[full.bureau] || BUREAUS.tu;
    const to = parseAddress(bureauEntry.address, bureauEntry.name);
    if (!to) {
      problems.push(`${full.ref}: the bureau address could not be read`);
      continue;
    }
    const tradeline = {
      creditor: full.creditor || String(full.account).split("••")[0].trim(),
      mask: full.mask || (String(full.account).split("••")[1] || "").trim(),
      type: full.tradeline_type || "Collection",
      balance: full.balance || 0,
      reason: full.issue,
      evidence: full.evidence || "[]"
    };
    const body = letterText({
      tenant: req.tenant,
      client: { name: full.client_name, email: full.client_email, phone: full.client_phone },
      dispute: full,
      tradeline
    });
    try {
      const letter = await createCertifiedLetter({
        to,
        from,
        text: body,
        description: `${pkg.ref} · ${full.ref}`,
        metadata: { tenant: req.tenant.slug, package: pkg.ref, dispute: full.ref }
      });
      db.prepare(
        `INSERT OR IGNORE INTO mail_dispatches (tenant_id, package_id, dispute_id, provider, provider_letter_id, tracking, expected_delivery, status)
         VALUES (?, ?, ?, 'lob', ?, ?, ?, 'created')`
      ).run(t, pkg.id, full.id, letter.id, letter.tracking || null, letter.expectedDelivery || null);
      sent.push({ ...letter, disputeId: full.id, ref: full.ref });
    } catch (err) {
      problems.push(`${full.ref}: ${err.message}`);
    }
  }

  if (!sent.length) {
    return back(res, target, { error: problems[0] || "Lob did not accept any letter in this package." });
  }

  const tracking = sent.find((letter) => letter.tracking)?.tracking || null;
  const sentAt = new Date().toISOString();
  db.prepare("UPDATE packages SET status = 'In transit', tracking = ?, sent_at = ? WHERE id = ? AND tenant_id = ?").run(
    tracking,
    sentAt,
    pkg.id,
    t
  );
  const mailed = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const mark = db.prepare("UPDATE disputes SET status = 'Mailed', mailed = ? WHERE id = ? AND tenant_id = ?");
  sent.forEach((letter) => mark.run(mailed, letter.disputeId, t));
  captureLetters(req.tenant, pkg, sent.map((letter) => letter.disputeId), t);

  audit(t, actor(req), "Sent package through Lob", `${pkg.ref} · ${sent.length} certified letter(s)`);
  const partial = problems.length ? ` ${problems.length} letter(s) failed: ${problems.join("; ")}` : "";
  back(res, target, {
    notice: `${pkg.ref} handed to Lob — ${sent.length} certified letter(s)${lobMode === "test" ? " in test mode" : ""}.${partial}`
  });
});

router.get("/mailroom/:id", (req, res) => {
  const t = tenantId(req);
  const pkg = db.prepare("SELECT * FROM packages WHERE id = ? AND tenant_id = ?").get(Number(req.params.id), t);
  if (!pkg) return fail(res, 404, "Package not found", "That package is not in this workspace.");
  const client = db.prepare("SELECT * FROM clients WHERE id = ? AND tenant_id = ?").get(pkg.client_id, t);

  let letters = db
    .prepare("SELECT * FROM package_letters WHERE tenant_id = ? AND package_id = ? ORDER BY id")
    .all(t, pkg.id);
  // Packages posted before snapshots existed still show their disputes.
  if (!letters.length) {
    letters = db
      .prepare(
        `SELECT pi.dispute_id, d.ref, d.account, d.bureau, COALESCE(d.letter_body, '') AS body
         FROM package_items pi JOIN disputes d ON d.id = pi.dispute_id
         WHERE pi.package_id = ? AND d.tenant_id = ? ORDER BY d.id`
      )
      .all(pkg.id, t);
  }

  const dispatches = db
    .prepare("SELECT * FROM mail_dispatches WHERE tenant_id = ? AND package_id = ? ORDER BY id")
    .all(t, pkg.id);
  const events = db
    .prepare("SELECT * FROM package_events WHERE tenant_id = ? AND package_id = ? ORDER BY id DESC LIMIT 25")
    .all(t, pkg.id);

  res.render("admin/package", {
    title: pkg.ref,
    page: "mailroom",
    pkg,
    // `client` is reserved as an EJS compiler option — the view needs another name.
    clientRecord: client,
    letters,
    snapshot: letters.length > 0 && Boolean(letters[0].captured_at),
    dispatches,
    events,
    lobConfigured,
    lobMode
  });
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

/** Openable types, so a preview can be served with the browser's own viewer. */
const DOC_TYPES = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  heic: "image/heic",
  heif: "image/heif"
};

function documentFile(doc) {
  if (!doc?.stored_name) return null;
  const file = path.join(DATA_DIR, "uploads", path.basename(doc.stored_name));
  return fs.existsSync(file) ? file : null;
}

/** Review one document: the file itself, its metadata, and the verify action. */
router.get("/documents/:id", (req, res) => {
  const t = tenantId(req);
  const doc = getDocument(t, req.params.id);
  if (!doc) return fail(res, 404, "Document not found", "That document is not in this workspace.");
  const file = documentFile(doc);
  const ext = file ? path.extname(file).slice(1).toLowerCase() : "";
  res.render("admin/document", {
    title: doc.name,
    page: "documents",
    doc,
    documentClient: getClient(t, doc.client_id),
    hasFile: Boolean(file),
    previewKind: DOC_TYPES[ext] ? ext : "",
    backTo: String(req.query.from || "") === "client" && doc.client_id ? `/app/clients/${doc.client_id}` : "/app/documents"
  });
});

/** Inline copy for the review page. Same origin only, never cached. */
router.get("/documents/:id/file", (req, res) => {
  const t = tenantId(req);
  const doc = getDocument(t, req.params.id);
  if (!doc) return fail(res, 404, "Document not found", "That document is not in this workspace.");
  const file = documentFile(doc);
  if (!file) return fail(res, 404, "No file attached", "This record has metadata only. Upload the file to replace it.");
  const ext = path.extname(file).slice(1).toLowerCase();
  res.setHeader("Content-Type", DOC_TYPES[ext] || "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename="${doc.name.replace(/[^a-zA-Z0-9_.-]+/g, "-")}"`);
  res.setHeader("Cache-Control", "private, no-store");
  // The review page frames this response; everything else keeps the DENY default.
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  fs.createReadStream(file).pipe(res);
});

router.post("/documents/:id/verify", (req, res) => {
  const t = tenantId(req);
  const doc = getDocument(t, req.params.id);
  if (!doc) return fail(res, 404, "Document not found", "That document is not in this workspace.");
  const target = String(req.body.return || "") === "review" ? `/app/documents/${doc.id}` : "/app/documents";
  if (doc.status === "Verified") return back(res, target, { notice: `${doc.name} is already verified.` });
  db.prepare("UPDATE documents SET status = 'Verified' WHERE id = ? AND tenant_id = ?").run(doc.id, t);
  const client = getClient(t, doc.client_id);
  if (client) db.prepare("UPDATE clients SET docs_verified = MIN(docs_total, docs_verified + 1) WHERE id = ?").run(client.id);
  audit(t, actor(req), "Verified document", doc.name);
  back(res, target, { notice: `${doc.name} verified.` });
});

router.get("/documents/:id/download", (req, res) => {
  const t = tenantId(req);
  const doc = getDocument(t, req.params.id);
  if (!doc) return fail(res, 404, "Document not found", "That document is not in this workspace.");
  const file = documentFile(doc);
  if (!file) {
    return fail(res, 404, "No file attached", "This record has metadata only, so there is nothing to download yet. Open it to review the details.");
  }
  const ext = path.extname(file).slice(1).toLowerCase();
  res.setHeader("Content-Type", ext === "heic" || ext === "heif" ? "application/octet-stream" : DOC_TYPES[ext] || "application/octet-stream");
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

/* ---------------- drafting studio ---------------- */

const strategyList = () =>
  Object.entries(STRATEGIES).map(([id, plan]) => ({
    id,
    label: plan.label,
    short: plan.short,
    authority: plan.authority
  }));

function studioLocals(req, extra = {}) {
  const t = tenantId(req);
  const tradelines = db
    .prepare(
      `SELECT tr.*, c.name AS client_name, c.ref AS client_ref
       FROM tradelines tr JOIN clients c ON c.id = tr.client_id
       WHERE tr.tenant_id = ? ORDER BY c.name, tr.bureau, tr.creditor`
    )
    .all(t);
  return {
    title: "Drafting studio",
    page: "studio",
    tradelines,
    drafts: listDrafts(t, 10),
    draft: null,
    strategies: strategyList(),
    tones: TONES,
    form: { tradeline_id: "", strategy: "fcra-611", tone: "Professional", evidence: true, citations: true },
    ...extra
  };
}

router.get("/studio", (req, res) => {
  res.render("studio", studioLocals(req));
});

router.get("/studio/:id", (req, res) => {
  const t = tenantId(req);
  const draft = getDraft(t, req.params.id);
  if (!draft) return fail(res, 404, "Draft not found", "That draft is not in this workspace.");
  res.render(
    "studio",
    studioLocals(req, {
      title: `Draft ${draft.id}`,
      draft: {
        ...draft,
        citations: parseList(draft.citations),
        signals: parseList(draft.signals)
      },
      form: { tradeline_id: draft.tradeline_id || "", strategy: draft.strategy, tone: draft.tone }
    })
  );
});

router.post("/studio/generate", (req, res) => {
  const t = tenantId(req);
  const tradeline = db
    .prepare(
      `SELECT tr.*, c.name AS client_name FROM tradelines tr
       JOIN clients c ON c.id = tr.client_id
       WHERE tr.id = ? AND tr.tenant_id = ?`
    )
    .get(Number(req.body.tradeline_id), t);
  if (!tradeline) return back(res, "/app/studio", { error: "Choose a tradeline to draft against." });
  const client = getClient(t, tradeline.client_id);
  if (!client) return back(res, "/app/studio", { error: "That client is not in this workspace." });

  const result = generateDraft({
    tenant: req.tenant,
    client,
    tradeline,
    strategy: String(req.body.strategy || "fcra-611"),
    tone: String(req.body.tone || "Professional"),
    includeEvidence: req.body.evidence === "on",
    includeCitations: req.body.citations === "on"
  });

  const draftId = Number(
    db.prepare(
      `INSERT INTO drafts (tenant_id, client_id, tradeline_id, strategy, tone, confidence, subject, body, citations, signals, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Draft', ?)`
    ).run(
      t,
      client.id,
      tradeline.id,
      result.strategy,
      result.tone,
      result.confidence,
      result.subject,
      result.body,
      JSON.stringify(result.citations),
      JSON.stringify(result.signals),
      actor(req)
    ).lastInsertRowid
  );

  audit(t, actor(req), "Drafted a dispute letter for", `${client.name} · ${tradeline.creditor} ••${tradeline.mask}`);
  res.redirect(303, `/app/studio/${draftId}`);
});

router.post("/studio/:id", (req, res) => {
  const t = tenantId(req);
  const draft = getDraft(t, req.params.id);
  if (!draft) return fail(res, 404, "Draft not found", "That draft is not in this workspace.");

  const body = String(req.body.body || "").trim().slice(0, 20000) || draft.body;
  db.prepare("UPDATE drafts SET body = ? WHERE id = ? AND tenant_id = ?").run(body, draft.id, t);

  if (req.body.action !== "approve") {
    return back(res, `/app/studio/${draft.id}`, { notice: "Draft saved. Nothing is mailed until you approve it." });
  }
  if (draft.status === "Approved") {
    return back(res, `/app/studio/${draft.id}`, { error: "This draft was already approved." });
  }

  const tradeline = db
    .prepare("SELECT * FROM tradelines WHERE id = ? AND tenant_id = ?")
    .get(Number(draft.tradeline_id), t);
  if (!tradeline) {
    return back(res, `/app/studio/${draft.id}`, { error: "The tradeline behind this draft no longer exists. Regenerate it first." });
  }

  const prior = db
    .prepare("SELECT MAX(round) AS round FROM disputes WHERE tenant_id = ? AND tradeline_id = ?")
    .get(t, tradeline.id);
  const round = Math.min(5, (Number(prior?.round) || 0) + 1);
  const ref = nextRef(t, "disputes", "DSP");
  const disputeId = Number(
    db.prepare(
      `INSERT INTO disputes (tenant_id, client_id, tradeline_id, ref, bureau, account, issue, round, status, confidence, letter_body)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Needs review', ?, ?)`
    ).run(
      t,
      draft.client_id,
      tradeline.id,
      ref,
      tradeline.bureau,
      `${tradeline.creditor} ••${tradeline.mask}`,
      tradeline.reason,
      round,
      draft.confidence,
      body
    ).lastInsertRowid
  );
  db.prepare("UPDATE drafts SET status = 'Approved', dispute_id = ? WHERE id = ? AND tenant_id = ?").run(disputeId, draft.id, t);
  audit(t, actor(req), "Approved a studio draft for", `${draft.client_name} · ${ref}`);
  back(res, `/app/disputes/${disputeId}`, { notice: `${ref} created from the approved draft.` });
});

router.post("/studio/:id/discard", (req, res) => {
  const t = tenantId(req);
  const draft = getDraft(t, req.params.id);
  if (!draft) return fail(res, 404, "Draft not found", "That draft is not in this workspace.");
  db.prepare("DELETE FROM drafts WHERE id = ? AND tenant_id = ?").run(draft.id, t);
  audit(t, actor(req), "Discarded a studio draft for", draft.client_name);
  back(res, "/app/studio", { notice: "Draft discarded. No dispute was created." });
});

/* ---------------- automated pipeline ---------------- */

router.get("/pipeline", (req, res) => {
  const t = tenantId(req);
  const scan = scanPipeline(t);
  const ready = db
    .prepare(
      `SELECT d.*, c.name AS client_name, tr.creditor, tr.mask, tr.bureau
       FROM drafts d
       JOIN clients c ON c.id = d.client_id
       LEFT JOIN tradelines tr ON tr.id = d.tradeline_id
       WHERE d.tenant_id = ? AND d.status = 'Ready' ORDER BY d.id`
    )
    .all(t);
  res.render("admin/pipeline", {
    title: "Dispute pipeline",
    page: "pipeline",
    scan,
    ready,
    evidenceFloor: 75,
    aiConfigured
  });
});

router.post("/pipeline/run", (req, res) => {
  const result = runPipeline(req.tenant, actor(req));
  if (!result.created) {
    return back(res, "/app/pipeline", {
      notice: `Nothing new to draft. ${result.scan.exceptions.length} item(s) still need a human.`
    });
  }
  back(res, "/app/pipeline", {
    notice: `${result.created} letter${result.created === 1 ? "" : "s"} drafted. ${result.scan.exceptions.length} item(s) went to the review queue.`
  });
});

router.post("/pipeline/approve", (req, res) => {
  const result = approvePipeline(req.tenant, actor(req));
  if (!result.disputes) {
    return back(res, "/app/pipeline", { error: "There are no auto-drafted letters to approve. Run the automation first." });
  }
  back(res, "/app/mailroom", {
    notice: `${result.disputes} dispute${result.disputes === 1 ? "" : "s"} approved · ${result.packages.length} package${result.packages.length === 1 ? "" : "s"} ready to print and post.`
  });
});

/* ---------------- AI: letter refinement through OmniRoute ---------------- */

router.post("/studio/:id/refine", async (req, res) => {
  const t = tenantId(req);
  const draft = getDraft(t, req.params.id);
  if (!draft) return fail(res, 404, "Draft not found", "That draft is not in this workspace.");
  if (draft.status === "Approved") {
    return back(res, `/app/studio/${draft.id}`, { error: "This draft was already approved, so it can no longer be rewritten." });
  }
  if (!aiConfigured) {
    return back(res, `/app/studio/${draft.id}`, {
      error: "OmniRoute is not configured. Set OMNIROUTE_API_KEY and restart — the deterministic draft is still valid without it."
    });
  }

  const instruction =
    String(req.body.instruction || "").trim().slice(0, 300) ||
    "Tighten the letter and keep every fact and citation.";
  const strategy = STRATEGIES[draft.strategy] || STRATEGIES["fcra-611"];
  const caseFile = [
    `Client: ${draft.client_name}`,
    `Bureau: ${bureau[draft.bureau]?.name || draft.bureau}`,
    `Account: ${draft.creditor || "unknown"} ending ${draft.mask || "unknown"} (${draft.tradeline_type || "item"})`,
    `Reported balance: ${draft.balance ? money(draft.balance) : "none"}`,
    `Basis of dispute: ${draft.reason || "not recorded"}`,
    `Legal basis: ${strategy.label} (${strategy.authority})`,
    `Citations to preserve: ${parseList(draft.citations).join("; ") || strategy.support}`,
    `Evidence on file: ${parseList(draft.evidence).join("; ") || "none recorded"}`
  ].join("\n");

  try {
    const { text, model } = await aiChat({
      maxTokens: 1800,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            "You edit credit-repair dispute letters inside a compliance workflow. Rewrite only the letter body supplied. Never invent facts, dates, balances, documents or statutes, and never add a citation the case file does not support. Keep every citation that is already in the letter and keep the remedy requested. Reply with the letter body only: no markdown fences, no subject line, no commentary."
        },
        {
          role: "user",
          content: `CASE FILE\n${caseFile}\n\nINSTRUCTION\n${instruction}\n\nCURRENT LETTER\n${draft.body}`
        }
      ]
    });

    const body = text
      .replace(/^```[a-z]*\s*/i, "")
      .replace(/```\s*$/, "")
      .trim()
      .slice(0, 20000);
    if (!body) throw new Error("The gateway returned an empty letter.");

    db.prepare("UPDATE drafts SET body = ?, ai_model = ?, ai_refined_at = ? WHERE id = ? AND tenant_id = ?").run(
      body,
      model,
      new Date().toISOString(),
      draft.id,
      t
    );
    audit(t, actor(req), "Refined a letter with AI for", `${draft.client_name} · ${model}`);
    back(res, `/app/studio/${draft.id}`, { notice: `Letter refined with ${model}. Read it before approving.` });
  } catch (err) {
    back(res, `/app/studio/${draft.id}`, { error: err.message });
  }
});

/* ---------------- AI: case intelligence through OmniRoute ---------------- */

router.post("/clients/:id/analyze", async (req, res) => {
  const t = tenantId(req);
  const client = getClient(t, req.params.id);
  if (!client) return fail(res, 404, "Client not found", "That client is not in this workspace.");
  if (!aiConfigured) {
    return back(res, `/app/clients/${client.id}`, {
      error: "OmniRoute is not configured. Set OMNIROUTE_API_KEY and restart to use case summaries."
    });
  }

  const caseFile = {
    client: {
      name: client.name,
      stage: client.stage,
      scores: { transunion: client.tu, experian: client.ex, equifax: client.eq },
      joined: client.joined,
      notes: client.notes || ""
    },
    tradelines: clientTradelines(t, client.id).map((row) => ({
      bureau: row.bureau,
      creditor: row.creditor,
      mask: row.mask,
      type: row.type,
      balance: row.balance,
      opened: row.opened,
      dispute_basis: row.reason,
      evidence_strength: row.strength,
      evidence: parseList(row.evidence)
    })),
    open_disputes: clientDisputes(t, client.id)
      .filter((row) => !["Deleted", "Closed"].includes(row.status))
      .map((row) => ({
        ref: row.ref,
        bureau: row.bureau,
        account: row.account,
        status: row.status,
        round: row.round,
        due: row.due
      })),
    documents: clientDocuments(t, client.id).map((row) => ({
      name: row.name,
      type: row.type,
      status: row.status
    })),
    outstanding_requests: clientRequests(t, client.id)
      .filter((row) => !row.done)
      .map((row) => ({ label: row.label, due: row.due }))
  };

  try {
    const { text, model } = await aiChat({
      maxTokens: 1200,
      temperature: 0.3,
      messages: [
        {
          role: "system",
          content:
            'You are a credit-repair case analyst. Use only the JSON case file provided and do not invent documents, dates or balances. Reply with JSON only, shaped exactly like {"summary":"<=120 words of plain text","theories":[{"title":"short name","basis":"the FCRA or Regulation V section relied on","evidence":"the documents in this file that support it, or what is missing","next_step":"the single next action for the specialist"}]}. At most three theories, strongest first. An empty theories array is a valid answer.'
        },
        { role: "user", content: JSON.stringify(caseFile) }
      ]
    });

    const parsed = parseJsonReply(text) || { summary: text.slice(0, 2000), theories: [] };
    const summary = String(parsed.summary || "").trim().slice(0, 4000);
    if (!summary) throw new Error("The gateway returned an empty summary.");
    const theories = (Array.isArray(parsed.theories) ? parsed.theories : []).slice(0, 5).map((item) => ({
      title: String(item?.title || "Theory").slice(0, 140),
      basis: String(item?.basis || "").slice(0, 200),
      evidence: String(item?.evidence || "").slice(0, 400),
      next_step: String(item?.next_step || "").slice(0, 300)
    }));

    db.prepare(
      "INSERT INTO case_insights (tenant_id, client_id, summary, theories, model, created_by) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(t, client.id, summary, JSON.stringify(theories), model, actor(req));
    audit(t, actor(req), "Generated a case summary with AI for", `${client.name} · ${model}`);
    back(res, `/app/clients/${client.id}`, { notice: `Case summary generated with ${model}. It is advisory — check it against the file.` });
  } catch (err) {
    back(res, `/app/clients/${client.id}`, { error: err.message });
  }
});

/* ---------------- mail log ---------------- */

router.get("/mail-log", (req, res) => {
  if (req.user.role !== "owner") {
    return fail(res, 403, "Owner only", "The mail log can contain account credentials, so only an owner can open it.");
  }
  res.render("admin/mail-log", {
    title: "Mail log",
    page: "mail-log",
    emails: emailRows(tenantId(req), 100),
    mail: mailStatus(tenantId(req))
  });
});

router.post("/mail-log/:id/retry", async (req, res) => {
  if (req.user.role !== "owner") return fail(res, 403, "Owner only", "Only an agency owner can resend mail.");
  const t = tenantId(req);
  const row = db.prepare("SELECT * FROM emails WHERE id = ? AND tenant_id = ?").get(Number(req.params.id), t);
  if (!row) return fail(res, 404, "Message not found", "That message is not in this workspace.");
  const after = await deliver(row.id);
  if (after.status === "sent") return back(res, "/app/mail-log", { notice: `Message to ${after.to_email} accepted by ${after.provider}.` });
  if (!mailConfiguredFor(t)) {
    return back(res, "/app/mail-log", {
      error: "No mail server is configured for this workspace, so the message stays in this log. Set one in Settings → Email server, or configure SMTP_HOST/SMTP_USER/SMTP_PASS in the environment and restart."
    });
  }
  back(res, "/app/mail-log", { error: `Still failing: ${after.error || "provider rejected the message"}` });
});

/* ---------------- settings ---------------- */

router.get("/settings", (req, res) => {
  const t = tenantId(req);
  const team = db
    .prepare("SELECT id, name, email, role, last_login_at, must_change_password FROM users WHERE tenant_id = ? ORDER BY role, name")
    .all(t);
  const queued = db
    .prepare("SELECT COUNT(*) AS n FROM emails WHERE tenant_id = ? AND status IN ('queued','failed')")
    .get(t).n;
  res.render("admin/settings", {
    title: "Settings",
    page: "settings",
    team,
    invited: null,
    mail: mailStatus(t),
    queuedMail: queued,
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

router.post("/settings/team", async (req, res) => {
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
  const { user, password } = createAccount({ tenantId: t, name, email, role });
  audit(t, actor(req), "Invited teammate", `${name} · ${role}`);

  let delivery = "The invitation email could not be queued.";
  try {
    const row = await sendCredentials({ tenant: req.tenant, req, user, password, role });
    delivery = emailDeliveryNote(row);
    if (row.status !== "failed") audit(t, actor(req), "Emailed workspace invitation to", email);
  } catch (err) {
    delivery = `The invitation email could not be queued: ${err.message}`;
  }

  const team = db
    .prepare("SELECT id, name, email, role, last_login_at, must_change_password FROM users WHERE tenant_id = ? ORDER BY role, name")
    .all(t);
  res.render("admin/settings", {
    title: "Settings",
    page: "settings",
    team,
    invited: { name, email, role, password: mailConfiguredFor(t) ? null : password, delivery },
    mail: mailStatus(t),
    queuedMail: 0,
    saved: ""
  });
});

/* ---------------- workspace email server ---------------- */

/** Pull the address out of either `name@domain` or `Name <name@domain>`. */
function mailAddress(value) {
  const text = String(value || "").trim();
  const angled = text.match(/<([^<>]+)>/);
  return (angled ? angled[1] : text).trim().toLowerCase();
}

router.post("/settings/mail", async (req, res) => {
  const t = tenantId(req);
  if (req.user.role !== "owner") return fail(res, 403, "Owner only", "Only an agency owner can change the email server.");

  const host = String(req.body.host || "").trim().slice(0, 160);
  const port = Number(req.body.port || 0);
  const security = String(req.body.security || "starttls");
  const username = String(req.body.username || "").trim().slice(0, 160);
  const password = String(req.body.password || "");
  const fromRaw = String(req.body.from || "").trim().slice(0, 180);
  const from = mailAddress(fromRaw);
  const enabled = truthy(req.body.enabled);

  if (!host) return back(res, "/app/settings", { error: "Enter the SMTP server hostname." });
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return back(res, "/app/settings", { error: "The SMTP port must be a number between 1 and 65535." });
  }
  if (from && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(from)) {
    return back(res, "/app/settings", { error: "The From address must be a valid email address." });
  }

  saveMailSettings({
    tenantId: t,
    host,
    port,
    secure: security === "tls",
    starttls: security === "starttls",
    username,
    password,
    from: fromRaw,
    enabled,
    updatedBy: actor(req)
  });
  audit(t, actor(req), enabled ? "Set the workspace email server" : "Disabled the workspace email server", `${host}:${port}`);

  if (String(req.body.action || "") !== "test") {
    return back(res, "/app/settings", {
      notice: enabled ? `Email server saved — sending through ${host}:${port}.` : "Email server saved, but switched off."
    });
  }

  if (!enabled) return back(res, "/app/settings", { error: "Switch the server on before sending a test." });
  try {
    const row = await sendMail({
      tenantId: t,
      userId: req.user.id,
      to: req.user.email,
      subject: `${req.tenant.brand_name} test message`,
      kind: "test",
      text: [
        `This is a test from ${req.tenant.brand_name}.`,
        `If you are reading it, the workspace email server (${host}:${port}) accepted the message and delivered it.`,
        `Sent to ${req.user.email} from ${from || "the default From address"}.`
      ].join("\n\n")
    });
    if (row.status === "sent") {
      return back(res, "/app/settings", { notice: `Test message accepted by ${host}:${port} — check ${req.user.email}.` });
    }
    return back(res, "/app/settings", {
      error: `The server rejected the test: ${row.error || "no response from the server"}`
    });
  } catch (err) {
    return back(res, "/app/settings", { error: `The test message could not be sent: ${err.message}` });
  }
});

router.post("/settings/mail/remove", (req, res) => {
  const t = tenantId(req);
  if (req.user.role !== "owner") return fail(res, 403, "Owner only", "Only an agency owner can change the email server.");
  clearMailSettings(t);
  audit(t, actor(req), "Removed the workspace email server", "settings");
  back(res, "/app/settings", { notice: "Workspace email server removed. Delivery falls back to the deployment configuration." });
});

router.post("/settings/team/:id/reset", async (req, res) => {
  if (req.user.role !== "owner") return fail(res, 403, "Owner only", "Only an agency owner can reset a teammate's password.");
  const t = tenantId(req);
  const user = db
    .prepare("SELECT * FROM users WHERE id = ? AND tenant_id = ? AND role != 'client'")
    .get(Number(req.params.id), t);
  if (!user) return fail(res, 404, "Account not found", "That account is not in this workspace.");
  if (user.id === req.user.id) return back(res, "/app/settings", { error: "Use the password form below to change your own password." });
  try {
    const { row } = await sendResetLink({ tenant: req.tenant, req, user, ip: req.ip });
    back(res, "/app/settings", { notice: emailDeliveryNote(row) });
  } catch (err) {
    back(res, "/app/settings", { error: `The reset email could not be queued: ${err.message}` });
  }
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
  db.prepare("UPDATE users SET password_hash = ?, password_salt = ?, must_change_password = 0 WHERE id = ?").run(hash, salt, req.user.id);
  db.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").run(req.user.id, req.session?.id || "");
  audit(req.tenant.id, actor(req), "Changed their password", req.user.email);
  back(res, "/app/settings", { notice: "Password updated." });
});

export default router;
