import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, db } from "./db.js";
import { documentPdf } from "./pdf.js";
import { sha256 } from "./security.js";

/**
 * Seeded documents describe real paperwork ("Government ID — front.jpg") but
 * carry no scan, so the vault's preview and download links used to dead-end in
 * a 404. A restored uploads directory can lose a file the same way. In demo
 * mode every such record gets a generated PDF that repeats its metadata and
 * says it is a record copy; a real upload later replaces both the row and the
 * file.
 *
 * `ensureDocumentFile` is the single entry point and is safe to call per
 * request: it returns an existing file untouched, and only writes when the
 * record has no readable file. Outside demo mode nothing is invented — a
 * missing file stays missing and the caller answers 404.
 */

function uploadsDir() {
  return path.join(DATA_DIR, "uploads");
}

/**
 * Return the path of a document's file, generating a demonstration copy when
 * the record has none (or when the stored file went missing) in demo mode.
 */
export function ensureDocumentFile(tenant, doc) {
  if (!tenant || !doc) return null;

  const stored = doc.stored_name ? path.join(uploadsDir(), path.basename(doc.stored_name)) : null;
  if (stored && fs.existsSync(stored)) return stored;

  if (process.env.SEED_DEMO === "0") return null;

  const client = db
    .prepare("SELECT name, ref FROM clients WHERE id = ? AND tenant_id = ?")
    .get(doc.client_id, tenant.id) || { name: "Client", ref: "" };
  const bytes = documentPdf({ tenant, client, doc });
  const name = `demo-${tenant.id}-${doc.id}.pdf`;
  const file = path.join(uploadsDir(), name);
  fs.mkdirSync(uploadsDir(), { recursive: true });
  fs.writeFileSync(file, bytes);

  const label = bytes.length > 1048576 ? `${(bytes.length / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes.length / 1024))} KB`;
  db.prepare("UPDATE documents SET stored_name = ?, sha256 = ?, size = ? WHERE id = ? AND tenant_id = ?").run(
    name,
    sha256(bytes),
    label,
    doc.id,
    tenant.id
  );
  // Keep the caller's copy in step with the row the next request will read.
  doc.stored_name = name;
  doc.sha256 = sha256(bytes);
  doc.size = label;
  return file;
}

/** Boot-time sweep: every seeded record gets its file before anyone asks. */
export function ensureDemoDocumentFiles() {
  if (process.env.SEED_DEMO === "0") return 0;

  const rows = db.prepare("SELECT * FROM documents ORDER BY id").all();
  const findTenant = db.prepare("SELECT * FROM tenants WHERE id = ?");
  let written = 0;
  for (const row of rows) {
    const tenant = findTenant.get(row.tenant_id);
    if (!tenant) continue;
    const before = row.stored_name ? path.join(uploadsDir(), path.basename(row.stored_name)) : null;
    if (before && fs.existsSync(before)) continue;
    if (ensureDocumentFile(tenant, row)) written += 1;
  }
  return written;
}
