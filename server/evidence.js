import { db } from "./db.js";

/**
 * Which papers support which dispute.
 *
 * A dispute names a creditor ("Toyota Financial ••8820"); a document in the
 * client's vault names the same company ("Toyota payment history.pdf"). That is
 * the whole matching rule: the creditor's distinctive words appear in the
 * document's name. It is deliberately narrow — an identity document never
 * becomes evidence for a collection dispute just because they share a client.
 *
 * Links live in `document_disputes`, so a specialist can attach a document that
 * does not match by name, and a detached row is remembered (`detached_at`) so a
 * restart does not quietly undo the decision.
 */

/** Words that appear in half the creditors in a credit file and identify none. */
const GENERIC = new Set([
  "account", "accounts", "auto", "bank", "banking", "capital", "card", "cards",
  "collection", "collections", "company", "corp", "credit", "finance", "financial",
  "group", "health", "holding", "holdings", "inc", "llc", "loan", "loans",
  "limited", "medical", "mortgage", "national", "recovery", "service", "services",
  "solutions", "systems"
]);

/** Document types that can support a dispute. IDs and agreements cannot. */
const EVIDENCE_TYPES = new Set(["Evidence", "Bureau response"]);

export const isEvidenceType = (type) => EVIDENCE_TYPES.has(String(type || ""));

/** "Toyota Financial ••8820" → "Toyota Financial" */
export function creditorOf(account) {
  return String(account || "").split("••")[0].trim();
}

export function creditorTokens(creditor) {
  return String(creditor || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4 && !GENERIC.has(word));
}

/**
 * Does this document name the creditor? The first distinctive word is enough —
 * "Toyota" in "Toyota payment history.pdf" — and when every word is generic
 * ("Capital One") the full phrase is tried instead.
 */
export function namesCreditor(documentName, creditor) {
  const name = String(documentName || "").toLowerCase().replace(/[^a-z0-9]+/g, " ");
  const tokens = creditorTokens(creditor);
  if (tokens.length) return tokens.some((token) => name.split(" ").includes(token));
  const phrase = String(creditor || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return phrase.length > 0 && ` ${name} `.includes(` ${phrase} `);
}

function disputeCreditor(dispute) {
  return String(dispute.creditor || "").trim() || creditorOf(dispute.account);
}

/**
 * Recompute the automatic links for one dispute. Manual links and detached rows
 * are left alone (`INSERT OR IGNORE` keeps both), so this is safe to call on
 * create, on upload and at every boot.
 */
export function autoAttachEvidenceForDispute(tenantId, disputeId) {
  const dispute = db
    .prepare(
      `SELECT d.id, d.client_id, d.account, t.creditor
       FROM disputes d LEFT JOIN tradelines t ON t.id = d.tradeline_id
       WHERE d.id = ? AND d.tenant_id = ?`
    )
    .get(Number(disputeId), Number(tenantId));
  if (!dispute) return 0;

  const creditor = disputeCreditor(dispute);
  if (!creditor) return 0;

  const documents = db
    .prepare("SELECT id, name, type FROM documents WHERE tenant_id = ? AND client_id = ? ORDER BY id")
    .all(Number(tenantId), dispute.client_id)
    .filter((doc) => isEvidenceType(doc.type) && namesCreditor(doc.name, creditor));

  const link = db.prepare(
    `INSERT OR IGNORE INTO document_disputes (tenant_id, document_id, dispute_id, source)
     VALUES (?, ?, ?, 'auto')`
  );
  let added = 0;
  for (const doc of documents) added += Number(link.run(Number(tenantId), doc.id, dispute.id).changes || 0);
  return added;
}

/** After an upload, attach it to every open dispute of that client it names. */
export function autoAttachEvidenceForDocument(tenantId, documentId) {
  const doc = db
    .prepare("SELECT id, client_id, name, type FROM documents WHERE id = ? AND tenant_id = ?")
    .get(Number(documentId), Number(tenantId));
  if (!doc || !isEvidenceType(doc.type)) return 0;

  const disputes = db
    .prepare(
      `SELECT d.id, d.account, t.creditor
       FROM disputes d LEFT JOIN tradelines t ON t.id = d.tradeline_id
       WHERE d.tenant_id = ? AND d.client_id = ? AND d.status NOT IN ('Deleted','Closed')`
    )
    .all(Number(tenantId), doc.client_id)
    .filter((dispute) => namesCreditor(doc.name, disputeCreditor(dispute)));

  const link = db.prepare(
    `INSERT OR IGNORE INTO document_disputes (tenant_id, document_id, dispute_id, source)
     VALUES (?, ?, ?, 'auto')`
  );
  let added = 0;
  for (const dispute of disputes) added += Number(link.run(Number(tenantId), doc.id, dispute.id).changes || 0);
  return added;
}

/** Explicit attach from the dispute page. Also revives a previously detached row. */
export function attachEvidence(tenantId, disputeId, documentId) {
  const doc = db
    .prepare("SELECT id, client_id FROM documents WHERE id = ? AND tenant_id = ?")
    .get(Number(documentId), Number(tenantId));
  const dispute = db
    .prepare("SELECT id, client_id FROM disputes WHERE id = ? AND tenant_id = ?")
    .get(Number(disputeId), Number(tenantId));
  if (!doc || !dispute || doc.client_id !== dispute.client_id) return false;

  db.prepare(
    `INSERT INTO document_disputes (tenant_id, document_id, dispute_id, source, detached_at)
     VALUES (?, ?, ?, 'manual', NULL)
     ON CONFLICT (document_id, dispute_id)
     DO UPDATE SET source = 'manual', detached_at = NULL`
  ).run(Number(tenantId), doc.id, dispute.id);
  return true;
}

/** Remove one paper from one dispute. The row stays so the backfill respects it. */
export function detachEvidence(tenantId, disputeId, documentId) {
  return Number(
    db
      .prepare(
        "UPDATE document_disputes SET detached_at = datetime('now') WHERE tenant_id = ? AND dispute_id = ? AND document_id = ? AND detached_at IS NULL"
      )
      .run(Number(tenantId), Number(disputeId), Number(documentId)).changes || 0
  ) > 0;
}

/** The papers attached to a dispute, newest first. */
export const evidenceDocuments = (tenantId, disputeId) =>
  db
    .prepare(
      `SELECT doc.*, dd.source AS link_source, dd.created_at AS linked_at
       FROM document_disputes dd JOIN documents doc ON doc.id = dd.document_id
       WHERE dd.tenant_id = ? AND dd.dispute_id = ? AND dd.detached_at IS NULL
       ORDER BY doc.id DESC`
    )
    .all(Number(tenantId), Number(disputeId));

/** The client's other documents, for the "attach a document" picker. */
export const unattachedDocuments = (tenantId, disputeId, clientId) =>
  db
    .prepare(
      `SELECT doc.* FROM documents doc
       WHERE doc.tenant_id = ? AND doc.client_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM document_disputes dd
           WHERE dd.document_id = doc.id AND dd.dispute_id = ? AND dd.detached_at IS NULL
         )
       ORDER BY doc.id DESC`
    )
    .all(Number(tenantId), Number(clientId), Number(disputeId));

/** Boot-time repair for rows created before links existed, and for seeds. */
export function backfillEvidenceLinks() {
  const disputes = db.prepare("SELECT id, tenant_id FROM disputes").all();
  let added = 0;
  for (const dispute of disputes) added += autoAttachEvidenceForDispute(dispute.tenant_id, dispute.id);
  return added;
}
