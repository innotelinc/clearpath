/**
 * Return the deployment to a clean install, from the host, without a browser.
 *
 *   npm run reset -- --confirm RESET              do it
 *   npm run reset -- --confirm RESET --dry-run    say what would go, change nothing
 *
 * This is the platform console's "Reset system" button with the same meaning:
 * every workspace, client, dispute, letter, document and uploaded file goes;
 * the operator accounts and the payment settings stay, so the console is still
 * usable afterwards and billing does not silently turn off.
 *
 * A snapshot is taken first — the whole database plus the uploads about to be
 * swept — into `DATA_DIR/backups/<timestamp>-reset/`. To undo a reset by hand,
 * stop the server, copy that `database.db` over `DATA_DIR/clearpath.db` (removing
 * `-wal` and `-shm` beside it) and copy its `uploads/` back. That is the whole
 * recovery procedure, which is why the snapshot is not optional.
 *
 * The confirmation is a word, not a flag, for the same reason it is in the
 * console: this is the one command here with nothing behind it.
 */
import "../server/env.js";
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const confirmAt = argv.indexOf("--confirm");
const confirmation = confirmAt >= 0 ? String(argv[confirmAt + 1] || "") : "";

function usage(problem) {
  if (problem) console.error(`reset: ${problem}\n`);
  console.error("usage: npm run reset -- --confirm RESET [--dry-run]");
  console.error("");
  console.error("  Removes every workspace and client on this deployment and keeps");
  console.error("  the operator accounts and payment settings. A snapshot of the");
  console.error("  database and its files is written to DATA_DIR/backups/ first.");
  process.exit(1);
}

if (confirmation.toUpperCase() !== "RESET") {
  usage(confirmation === "" ? "nothing was confirmed" : `"${confirmation}" is not RESET`);
}

// The same guard `scripts/seed.js --reset` uses: a production volume should not
// be reaped by a command that was typed at the wrong prompt.
if (process.env.NODE_ENV === "production" && process.env.ALLOW_RESET !== "1") {
  console.error("reset: refusing to reset with NODE_ENV=production. Set ALLOW_RESET=1 if you are certain.");
  process.exit(1);
}

const dataDir = path.resolve(process.env.DATA_DIR || "./data");
const dbPath = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(dataDir, "clearpath.db");
if (!fs.existsSync(dbPath)) {
  console.error(`reset: no database at ${dbPath} — nothing to reset.`);
  process.exit(1);
}

const { db, resetInstall } = await import("../server/db.js");

const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n || 0;
const before = {
  workspaces: count("tenants"),
  clients: count("clients"),
  seats: count("users"),
  operators: count("platform_admins")
};

console.log(`Database: ${dbPath}`);
console.table(before);

if (before.workspaces === 0) {
  console.log("Nothing to reset — this deployment has no workspace.");
  process.exit(0);
}

if (dryRun) {
  console.log("Dry run: nothing was removed. Re-run without --dry-run to reset.");
  process.exit(0);
}

const removed = resetInstall();

const after = {
  workspaces: count("tenants"),
  clients: count("clients"),
  seats: count("users"),
  operators: count("platform_admins"),
  settings: count("platform_settings")
};

console.log(
  `Removed ${removed.tenants} workspace(s), ${removed.clients} client(s) and ${removed.files} uploaded file(s).`
);
console.table(after);
console.log(`Snapshot: ${removed.backup.dir}`);
console.log(
  `Undo: stop the server, copy ${path.join(removed.backup.name, "database.db")} over ${dbPath}`
);
console.log(`(removing ${path.basename(dbPath)}-wal and -shm beside it), and copy its uploads/ back.`);
if (after.operators === 0) {
  console.warn("No operator account is left — seed one before signing in to the console.");
}
