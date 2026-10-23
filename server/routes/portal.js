import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, db, audit, nextDocRef } from "../db.js";
import {
  clientDisputes,
  clientDocuments,
  clientMessages,
  clientPackages,
  clientRequests,
  getClient,
  getDocument
} from "../data.js";
import { sha256, sizeLabel, storeUpload } from "../uploads.js";
import { fmtDate } from "../util.js";

const router = Router();

/** The portal never trusts an id from the browser: the client is the session's own record. */
function loadClient(req, res) {
  const client = req.user.client_id ? getClient(req.tenant.id, req.user.client_id) : null;
  if (!client) {
    res.status(403).render("error", {
      title: "No client record",
      status: 403,
      message: "This portal account is not linked to a client file. Ask your specialist to re-send the invitation."
    });
    return null;
  }
  return client;
}

function fail(res, status, title, message) {
  return res.status(status).render("error", { title, status, message });
}

function back(res, target, { notice = "", error = "" } = {}) {
  const params = new URLSearchParams();
  if (notice) params.set("notice", notice);
  if (error) params.set("error", error);
  const query = params.toString();
  res.redirect(303, `${target}${query ? `?${query}` : ""}`);
}

function portalData(req, client) {
  const t = req.tenant.id;
  return {
    // EJS treats a local named `client` as a compiler option, so pass it as clientRecord.
    clientRecord: client,
    disputes: clientDisputes(t, client.id),
    documents: clientDocuments(t, client.id),
    requests: clientRequests(t, client.id),
    messages: clientMessages(t, client.id),
    packages: clientPackages(t, client.id)
  };
}

router.get("/", (req, res) => {
  const client = loadClient(req, res);
  if (!client) return;
  const data = portalData(req, client);
  const open = data.disputes.filter((d) => !["Deleted", "Closed"].includes(d.status));
  const due = data.requests.filter((r) => !r.done);
  res.render("portal/overview", {
    title: "Your file",
    page: "overview",
    ...data,
    open,
    due,
    verified: data.documents.filter((d) => d.status === "Verified").length
  });
});

router.get("/disputes", (req, res) => {
  const client = loadClient(req, res);
  if (!client) return;
  const data = portalData(req, client);
  res.render("portal/disputes", {
    title: "Disputes",
    page: "disputes",
    ...data,
    open: data.disputes.filter((d) => !["Deleted", "Closed"].includes(d.status))
  });
});

router.get("/documents", (req, res) => {
  const client = loadClient(req, res);
  if (!client) return;
  const data = portalData(req, client);
  res.render("portal/documents", {
    title: "Documents",
    page: "documents",
    ...data,
    verified: data.documents.filter((d) => d.status === "Verified").length,
    openRequests: data.requests.filter((r) => !r.done)
  });
});

router.post("/documents", (req, res) => {
  const client = loadClient(req, res);
  if (!client) return;
  if (!req.file) return back(res, "/portal/documents", { error: "Choose a PDF or image to upload." });
  const t = req.tenant.id;
  let stored;
  try {
    stored = storeUpload(req.file, t, client.id);
  } catch (err) {
    return back(res, "/portal/documents", { error: "That file does not look like a PDF or an image. Try again." });
  }
  const digest = sha256(req.file.buffer);
  const type = ["Identity", "Evidence", "Bureau response", "Agreement"].includes(req.body.type) ? req.body.type : "Identity";
  db.prepare(
    `INSERT INTO documents (tenant_id, client_id, ref, name, type, status, size, sha256, stored_name, uploaded_by, uploaded_at)
     VALUES (?, ?, ?, ?, ?, 'Pending review', ?, ?, ?, 'client', ?)`
  ).run(
    t,
    client.id,
    nextDocRef(t),
    req.file.originalname.slice(0, 180),
    type,
    sizeLabel(req.file.size),
    digest,
    stored,
    new Date().toISOString()
  );
  db.prepare("UPDATE clients SET docs_total = docs_total + 1 WHERE id = ?").run(client.id);
  const requestId = Number(req.body.request_id);
  if (requestId) {
    db.prepare("UPDATE doc_requests SET done = 1 WHERE id = ? AND client_id = ? AND tenant_id = ?")
      .run(requestId, client.id, t);
  }
  audit(t, client.name, "Uploaded a document from the portal", `${req.file.originalname} · SHA-256 ${digest.slice(0, 12)}`);
  back(res, "/portal/documents", { notice: "Upload received. Your specialist reviews it within one business day." });
});

router.get("/documents/:id/download", (req, res) => {
  const client = loadClient(req, res);
  if (!client) return;
  const doc = getDocument(req.tenant.id, req.params.id);
  if (!doc || doc.client_id !== client.id) return fail(res, 404, "Document not found", "That document is not on your file.");
  if (!doc.stored_name) return fail(res, 404, "No file attached", "This record has metadata only.");
  const file = path.join(DATA_DIR, "uploads", path.basename(doc.stored_name));
  if (!fs.existsSync(file)) return fail(res, 410, "File missing", "The stored file is no longer available. Ask your specialist to re-upload it.");
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="${doc.name.replace(/[^a-zA-Z0-9_.-]+/g, "-")}"`);
  res.setHeader("Cache-Control", "private, no-store");
  fs.createReadStream(file).pipe(res);
});

router.get("/messages", (req, res) => {
  const client = loadClient(req, res);
  if (!client) return;
  const data = portalData(req, client);
  res.render("portal/messages", { title: "Messages", page: "messages", ...data });
});

router.post("/messages", (req, res) => {
  const client = loadClient(req, res);
  if (!client) return;
  const body = String(req.body.body || "").trim().slice(0, 2000);
  if (!body) return back(res, "/portal/messages", { error: "Write a message first." });
  db.prepare(
    "INSERT INTO messages (tenant_id, client_id, author_role, author_name, body) VALUES (?, ?, 'client', ?, ?)"
  ).run(req.tenant.id, client.id, client.name, body);
  audit(req.tenant.id, client.name, "Sent a portal message", `${client.ref}`);
  back(res, "/portal/messages", { notice: "Message sent to your specialist." });
});

router.get("/score", (req, res) => {
  const client = loadClient(req, res);
  if (!client) return;
  const data = portalData(req, client);
  res.render("portal/score", {
    title: "Score history",
    page: "score",
    ...data,
    generated: fmtDate(new Date())
  });
});

export default router;
