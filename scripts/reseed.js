/**
 * Throw the demonstration data away and rebuild it, files included.
 *
 *   npm run reseed -- --confirm RESEED
 *   npm run reseed -- --confirm RESEED --dry-run
 *
 * This is `npm run reset` followed by `npm run seed`, with the document files
 * generated and the evidence links rebuilt in the same pass. It is meant for a
 * demo deployment whose sample cases have drifted: the same seed that runs on a
 * fresh install is written here, so the mailroom, vault and dispute pages all
 * describe the same records again.
 *
 * A snapshot of the whole database and the uploads is taken before anything is
 * removed (`DATA_DIR/backups/<timestamp>-reset/`), exactly as the reset command
 * does. Stop the service first: this process and the running server both open
 * the same SQLite file.
 */
import "../server/env.js";
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const confirmAt = argv.indexOf("--confirm");
const confirmation = confirmAt >= 0 ? String(argv[confirmAt + 1] || "") : "";

function usage(problem) {
  if (problem) console.error(`reseed: ${problem}\n`);
  console.error("usage: npm run reseed -- --confirm RESEED [--dry-run]");
  console.error("");
  console.error("  Removes every workspace and rebuilds the demonstration seed,");
  console.error("  including generated document PDFs and evidence links. A snapshot");
  console.error("  of the database and files is written to DATA_DIR/backups/ first.");
  process.exit(1);
}

if (confirmation.toUpperCase() !== "RESEED") {
  usage(confirmation === "" ? "nothing was confirmed" : `"${confirmation}" is not RESEED`);
}
if (process.env.NODE_ENV === "production" && process.env.ALLOW_RESET !== "1") {
  console.error("reseed: refusing to reseed with NODE_ENV=production. Set ALLOW_RESET=1 if you are certain.");
  process.exit(1);
}

const dataDir = path.resolve(process.env.DATA_DIR || "./data");
const dbPath = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(dataDir, "clearpath.db");
if (!fs.existsSync(dbPath)) {
  console.error(`reseed: no database at ${dbPath} — start the app once to create it.`);
  process.exit(1);
}

const { db, resetInstall, seedDemo } = await import("../server/db.js");
const { ensureDemoDocumentFiles } = await import("../server/demo-files.js");
const { backfillEvidenceLinks } = await import("../server/evidence.js");

const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n || 0;
const before = {
  workspaces: count("tenants"),
  clients: count("clients"),
  disputes: count("disputes"),
  documents: count("documents"),
  evidence_links: count("document_disputes")
};

console.log(`Database: ${dbPath}`);
console.table(before);
if (dryRun) {
  console.log("Dry run: nothing was removed. Re-run without --dry-run to reseed.");
  process.exit(0);
}

const removed = resetInstall();
const seeded = seedDemo();
const files = ensureDemoDocumentFiles();
const links = backfillEvidenceLinks();

const after = {
  workspaces: count("tenants"),
  clients: count("clients"),
  disputes: count("disputes"),
  documents: count("documents"),
  evidence_links: count("document_disputes"),
  generated_files: files
};

console.log(
  `Removed ${removed.tenants} workspace(s) and ${removed.files} file(s); ` +
    `${seeded ? "seeded a fresh demonstration install" : "the seed was not needed"}.`
);
console.table(after);
if (links) console.log(`Attached ${links} document(s) to their disputes as evidence.`);
console.log(`Snapshot: ${removed.backup.dir}`);
console.log("Restart the service so the new sessions and data are served.");
