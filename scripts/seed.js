/**
 * Seed or inspect the local database.
 *
 *   npm run seed            seed if the database is empty
 *   npm run seed -- --reset delete the SQLite file and every upload, then seed
 *
 * Never run --reset against a production volume: it destroys client records.
 */
import "../server/env.js";
import fs from "node:fs";
import path from "node:path";

const reset = process.argv.includes("--reset");
const dataDir = path.resolve(process.env.DATA_DIR || "./data");
const dbPath = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(dataDir, "clearpath.db");

if (reset) {
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_RESET !== "1") {
    console.error("Refusing to reset with NODE_ENV=production. Set ALLOW_RESET=1 if you are certain.");
    process.exit(1);
  }
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = `${dbPath}${suffix}`;
    if (fs.existsSync(file)) fs.rmSync(file);
  }
  fs.rmSync(path.join(dataDir, "uploads"), { recursive: true, force: true });
  console.log(`Removed ${dbPath} and stored uploads.`);
}

const { seedDemo, db } = await import("../server/db.js");
const created = seedDemo();

const counts = {
  tenants: db.prepare("SELECT COUNT(*) AS n FROM tenants").get().n,
  users: db.prepare("SELECT COUNT(*) AS n FROM users").get().n,
  clients: db.prepare("SELECT COUNT(*) AS n FROM clients").get().n,
  disputes: db.prepare("SELECT COUNT(*) AS n FROM disputes").get().n,
  documents: db.prepare("SELECT COUNT(*) AS n FROM documents").get().n
};

console.log(created ? "Seeded demo data." : "Database already had data — nothing seeded.");
console.table(counts);

const accounts = db
  .prepare(
    `SELECT u.email, u.role, t.slug AS workspace
     FROM users u JOIN tenants t ON t.id = u.tenant_id
     ORDER BY t.slug, u.role`
  )
  .all();
console.table(accounts);
console.log("Demo passwords: Denovo!2026 (owner) · Specialist!2026 · Client!2026 · Northstar!2026");
console.log(`Database: ${dbPath}`);
