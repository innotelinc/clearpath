import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, db } from "./db.js";
import { documentPdf } from "./pdf.js";
import { sha256 } from "./security.js";

/**
 * Seeded documents describe real paperwork ("Government ID — front.jpg") but
 * carry no file, so the vault's preview and download links used to dead-end in
 * a 404. Give every seeded record a readable PDF that repeats its metadata and
 * says it is a demonstration copy; a real upload later replaces both the row
 * and the file.
 *
 * Only runs in demo mode, and only for rows with no stored file, so it can
 * never overwrite a genuine upload.
 */
export function ensureDemoDocumentFiles() {
  if (process.env.SEED_DEMO === "0") return 0;

  const rows = db
    .prepare(
      `SELECT d.*, c.name AS demo_client_name, c.ref AS demo_client_ref
       FROM documents d
       LEFT JOIN clients c ON c.id = d.client_id
       WHERE d.stored_name IS NULL`
    )
    .all();
  if (!rows.length) return 0;

  const dir = path.join(DATA_DIR, "uploads");
  fs.mkdirSync(dir, { recursive: true });

  const update = db.prepare("UPDATE documents SET stored_name = ?, sha256 = ?, size = ? WHERE id = ?");
  const findTenant = db.prepare("SELECT * FROM tenants WHERE id = ?");
  let written = 0;

  for (const row of rows) {
    const tenant = findTenant.get(row.tenant_id);
    if (!tenant) continue;
    const bytes = documentPdf({
      tenant,
      client: { name: row.demo_client_name, ref: row.demo_client_ref },
      doc: row
    });
    const name = `demo-${row.tenant_id}-${row.id}.pdf`;
    fs.writeFileSync(path.join(dir, name), bytes);
    update.run(name, sha256(bytes), `${Math.max(1, Math.round(bytes.length / 1024))} KB`, row.id);
    written += 1;
  }

  return written;
}
