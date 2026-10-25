import { db } from "./db.js";
import { letterText } from "./pdf.js";

export const getClient = (tenantId, clientId) =>
  db.prepare("SELECT * FROM clients WHERE id = ? AND tenant_id = ?").get(Number(clientId), tenantId);

export const getDispute = (tenantId, disputeId) =>
  db
    .prepare(
      `SELECT d.*, c.name AS client_name, c.email AS client_email, c.phone AS client_phone,
              t.creditor, t.mask, t.type AS tradeline_type, t.balance,
              t.evidence AS tradeline_evidence, t.evidence,
              COALESCE((SELECT json_group_array(doc.name)
                        FROM document_disputes dd JOIN documents doc ON doc.id = dd.document_id
                        WHERE dd.dispute_id = d.id AND dd.detached_at IS NULL), '[]') AS document_evidence
       FROM disputes d
       JOIN clients c ON c.id = d.client_id
       LEFT JOIN tradelines t ON t.id = d.tradeline_id
       WHERE d.id = ? AND d.tenant_id = ?`
    )
    .get(Number(disputeId), tenantId);

/**
 * What the letter should list under Enclosures.
 *
 * The tradeline's evidence notes come first (they existed before documents were
 * linked), then the papers actually attached to the dispute. A document whose
 * name already answers an evidence note — "Toyota payment history.pdf" behind
 * "Payment history" — is not listed twice.
 */
export function letterEvidence(dispute) {
  const parse = (value) => {
    try {
      const list = JSON.parse(value || "[]");
      return Array.isArray(list) ? list.map((item) => String(item).trim()).filter(Boolean) : [];
    } catch {
      return [];
    }
  };
  const evidence = parse(dispute?.tradeline_evidence ?? dispute?.evidence);
  const covered = (label) =>
    evidence.some((item) => {
      const a = item.toLowerCase();
      const b = label.toLowerCase();
      return a.includes(b) || b.includes(a);
    });
  for (const name of parse(dispute?.document_evidence)) {
    const label = name.replace(/\.[a-z0-9]+$/i, "").trim();
    if (label && !covered(label)) evidence.push(label);
  }
  return JSON.stringify(evidence);
}

export const getDocument = (tenantId, documentId) =>
  db.prepare("SELECT * FROM documents WHERE id = ? AND tenant_id = ?").get(Number(documentId), tenantId);

export const listClients = (tenantId, { q = "", stage = "" } = {}) => {
  const term = `%${String(q).trim().toLowerCase()}%`;
  const params = [tenantId];
  let sql = "SELECT * FROM clients WHERE tenant_id = ?";
  if (q) {
    sql += " AND (lower(name) LIKE ? OR lower(email) LIKE ? OR lower(ref) LIKE ?)";
    params.push(term, term, term);
  }
  if (stage) {
    sql += " AND stage = ?";
    params.push(stage);
  }
  sql += " ORDER BY CASE stage WHEN 'Active' THEN 0 WHEN 'Review' THEN 1 WHEN 'Onboarding' THEN 2 ELSE 3 END, name";
  return db.prepare(sql).all(...params);
};

export const clientDisputes = (tenantId, clientId) =>
  db.prepare("SELECT * FROM disputes WHERE tenant_id = ? AND client_id = ? ORDER BY id DESC").all(tenantId, clientId);

export const clientDocuments = (tenantId, clientId) =>
  db.prepare("SELECT * FROM documents WHERE tenant_id = ? AND client_id = ? ORDER BY id DESC").all(tenantId, clientId);

export const clientRequests = (tenantId, clientId) =>
  db.prepare("SELECT * FROM doc_requests WHERE tenant_id = ? AND client_id = ? ORDER BY done, id DESC").all(tenantId, clientId);

export const clientMessages = (tenantId, clientId) =>
  db.prepare("SELECT * FROM messages WHERE tenant_id = ? AND client_id = ? ORDER BY id ASC").all(tenantId, clientId);

export const clientTradelines = (tenantId, clientId) =>
  db.prepare("SELECT * FROM tradelines WHERE tenant_id = ? AND client_id = ? ORDER BY id").all(tenantId, clientId);

export const clientPackages = (tenantId, clientId) =>
  db.prepare("SELECT * FROM packages WHERE tenant_id = ? AND client_id = ? ORDER BY id DESC").all(tenantId, clientId);

/**
 * The letter a dispute would print today.
 *
 * Packages posted before `package_letters.body` was filled in have the
 * reference, the bureau and nothing to read: the mailroom could only say so.
 * The dispute itself still carries everything the letter is built from, and
 * this is the same function `/app/disputes/:id` renders, so the package page
 * can show the text the operator would see there — labelled as the current
 * text, because it is not a copy of what went in the envelope.
 */
export function liveLetterBody(tenant, tenantId, disputeId) {
  const dispute = getDispute(tenantId, disputeId);
  if (!dispute) return "";
  const tradeline = {
    creditor: dispute.creditor || String(dispute.account).split("••")[0].trim(),
    mask: dispute.mask || (String(dispute.account).split("••")[1] || "").trim(),
    type: dispute.tradeline_type || "Collection",
    balance: dispute.balance || 0,
    reason: dispute.issue,
    evidence: letterEvidence(dispute)
  };
  return letterText({
    tenant,
    client: { name: dispute.client_name, email: dispute.client_email, phone: dispute.client_phone },
    dispute,
    tradeline
  });
}

/**
 * Exactly what went into each envelope, frozen at mailing time. The portal
 * shows these rather than the live dispute text, because a dispute keeps moving
 * after it is posted and the client is entitled to see what was actually sent.
 */
export const clientPackageLetters = (tenantId, clientId) =>
  db
    .prepare(
      `SELECT l.* FROM package_letters l
       JOIN packages p ON p.id = l.package_id
       WHERE l.tenant_id = ? AND p.client_id = ?
       ORDER BY l.package_id DESC, l.id`
    )
    .all(tenantId, clientId);

/**
 * The mailed snapshot for one dispute, with the envelope it travelled in, so
 * the portal can point the client at the tracking number for that letter.
 */
export const clientSentLetter = (tenantId, clientId, disputeId) =>
  db
    .prepare(
      `SELECT l.*, p.ref AS package_ref, p.tracking AS package_tracking,
              p.status AS package_status, p.method AS package_method, p.sent_at AS package_sent_at
       FROM package_letters l
       JOIN packages p ON p.id = l.package_id
       WHERE l.tenant_id = ? AND p.client_id = ? AND l.dispute_id = ?
       ORDER BY l.id DESC LIMIT 1`
    )
    .get(tenantId, clientId, Number(disputeId));

export const listDisputes = (tenantId, { status = "", q = "" } = {}) => {
  const params = [tenantId];
  let sql = `SELECT d.*, c.name AS client_name FROM disputes d JOIN clients c ON c.id = d.client_id WHERE d.tenant_id = ?`;
  if (status === "open") sql += " AND d.status NOT IN ('Deleted','Closed')";
  else if (status) {
    sql += " AND d.status = ?";
    params.push(status);
  }
  if (q) {
    sql += " AND (lower(c.name) LIKE ? OR lower(d.account) LIKE ? OR lower(d.ref) LIKE ?)";
    const term = `%${String(q).toLowerCase()}%`;
    params.push(term, term, term);
  }
  sql += " ORDER BY d.id DESC";
  return db.prepare(sql).all(...params);
};

export const listPackages = (tenantId, { status = "" } = {}) => {
  const params = [tenantId];
  let sql = `SELECT p.*, c.name AS client_name FROM packages p JOIN clients c ON c.id = p.client_id WHERE p.tenant_id = ?`;
  if (status) {
    sql += " AND p.status = ?";
    params.push(status);
  }
  sql += " ORDER BY p.id DESC";
  return db.prepare(sql).all(...params);
};

export const listDocuments = (tenantId, { q = "", type = "" } = {}) => {
  const params = [tenantId];
  let sql = `SELECT d.*, c.name AS client_name FROM documents d JOIN clients c ON c.id = d.client_id WHERE d.tenant_id = ?`;
  if (type) {
    sql += " AND d.type = ?";
    params.push(type);
  }
  if (q) {
    sql += " AND (lower(d.name) LIKE ? OR lower(c.name) LIKE ?)";
    const term = `%${String(q).toLowerCase()}%`;
    params.push(term, term);
  }
  sql += " ORDER BY d.id DESC";
  return db.prepare(sql).all(...params);
};

export const allRequests = (tenantId) =>
  db
    .prepare(
      `SELECT r.*, c.name AS client_name FROM doc_requests r JOIN clients c ON c.id = r.client_id
       WHERE r.tenant_id = ? ORDER BY r.done, r.id DESC`
    )
    .all(tenantId);

export const clientsMap = (tenantId) => {
  const map = {};
  db.prepare("SELECT * FROM clients WHERE tenant_id = ?").all(tenantId).forEach((c) => { map[c.id] = c; });
  return map;
};

export const unreadMessages = (tenantId) =>
  db
    .prepare(`SELECT c.id, c.name, MAX(m.created_at) AS last_at FROM messages m JOIN clients c ON c.id = m.client_id
              WHERE m.tenant_id = ? GROUP BY c.id ORDER BY last_at DESC LIMIT 5`)
    .all(tenantId);
