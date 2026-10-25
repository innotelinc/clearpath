import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hashPassword, sha256 } from "./security.js";

const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data");
const DB_PATH = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(DATA_DIR, "clearpath.db");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, "uploads"), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

const schema = `
CREATE TABLE IF NOT EXISTS tenants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  domain TEXT,
  brand_name TEXT NOT NULL,
  tagline TEXT,
  logo TEXT,
  accent TEXT NOT NULL DEFAULT '#1f5eff',
  support_email TEXT,
  support_phone TEXT,
  address TEXT,
  portal_name TEXT NOT NULL DEFAULT 'Client portal',
  welcome TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ref TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  stage TEXT NOT NULL DEFAULT 'Onboarding',
  portal_status TEXT NOT NULL DEFAULT 'Invited',
  joined TEXT NOT NULL,
  tu INTEGER NOT NULL DEFAULT 600,
  ex INTEGER NOT NULL DEFAULT 600,
  eq INTEGER NOT NULL DEFAULT 600,
  delta INTEGER NOT NULL DEFAULT 0,
  utilization INTEGER NOT NULL DEFAULT 0,
  docs_verified INTEGER NOT NULL DEFAULT 0,
  docs_total INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, ref)
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','specialist','client')),
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT,
  UNIQUE (tenant_id, email)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tradelines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  bureau TEXT NOT NULL CHECK (bureau IN ('tu','ex','eq')),
  creditor TEXT NOT NULL,
  mask TEXT NOT NULL,
  type TEXT NOT NULL,
  balance INTEGER NOT NULL DEFAULT 0,
  opened TEXT,
  reason TEXT NOT NULL,
  strength INTEGER NOT NULL DEFAULT 70,
  evidence TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS disputes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  tradeline_id INTEGER REFERENCES tradelines(id) ON DELETE SET NULL,
  ref TEXT NOT NULL,
  bureau TEXT NOT NULL CHECK (bureau IN ('tu','ex','eq')),
  account TEXT NOT NULL,
  issue TEXT NOT NULL,
  round INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'Needs review',
  confidence INTEGER NOT NULL DEFAULT 80,
  mailed TEXT,
  due TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, ref)
);

CREATE TABLE IF NOT EXISTS packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  ref TEXT NOT NULL,
  bureau TEXT NOT NULL CHECK (bureau IN ('tu','ex','eq')),
  letters INTEGER NOT NULL DEFAULT 1,
  method TEXT NOT NULL DEFAULT 'Certified mail',
  status TEXT NOT NULL DEFAULT 'Ready',
  tracking TEXT,
  eta TEXT,
  cost REAL NOT NULL DEFAULT 9.85,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, ref)
);

CREATE TABLE IF NOT EXISTS package_items (
  package_id INTEGER NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  dispute_id INTEGER NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
  PRIMARY KEY (package_id, dispute_id)
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  ref TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Pending review',
  size TEXT,
  sha256 TEXT NOT NULL,
  stored_name TEXT,
  uploaded_by TEXT NOT NULL DEFAULT 'agency',
  uploaded_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS doc_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'Identity',
  due TEXT,
  done INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  author_role TEXT NOT NULL CHECK (author_role IN ('agency','client')),
  author_name TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER REFERENCES tenants(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  agency TEXT,
  size TEXT,
  message TEXT,
  source TEXT NOT NULL DEFAULT 'landing',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  actor_name TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, seq)
);

CREATE TABLE IF NOT EXISTS password_resets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  requested_ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  kind TEXT NOT NULL,
  body_text TEXT NOT NULL,
  link TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  provider TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_attempt_at TEXT,
  sent_at TEXT
);

CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  tradeline_id INTEGER REFERENCES tradelines(id) ON DELETE SET NULL,
  dispute_id INTEGER REFERENCES disputes(id) ON DELETE SET NULL,
  strategy TEXT NOT NULL,
  tone TEXT NOT NULL DEFAULT 'Professional',
  confidence INTEGER NOT NULL DEFAULT 70,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  citations TEXT NOT NULL DEFAULT '[]',
  signals TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'Draft',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS platform_admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

/* Platform operators are not tenant users: their sessions live in their own
   table so a workspace suspension can never lock the operator out. */
CREATE TABLE IF NOT EXISTS platform_sessions (
  id TEXT PRIMARY KEY,
  admin_id INTEGER NOT NULL REFERENCES platform_admins(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

/* A workspace's own SMTP submission server, set from Settings → Email server.
   The password is sealed with server/secrets.js, never stored in the clear and
   never sent back to the browser. */
CREATE TABLE IF NOT EXISTS tenant_mail (
  tenant_id INTEGER PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 587,
  secure INTEGER NOT NULL DEFAULT 0,
  starttls INTEGER NOT NULL DEFAULT 1,
  username TEXT,
  password_sealed TEXT,
  from_address TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT
);

/* Deployment-wide operator settings: the Stripe keys live here when they are
   set from the console instead of the environment. Values are secrets, so the
   UI only ever renders a mask. */
CREATE TABLE IF NOT EXISTS platform_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT
);

/* Every billing webhook Stripe delivers, deduplicated on its event id so a
   retry cannot apply the same subscription change twice. */
CREATE TABLE IF NOT EXISTS billing_events (
  id TEXT PRIMARY KEY,
  tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  detail TEXT,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);

/* Exactly what went into the envelope, captured at mailing time. The disputes
   can keep moving after a package is posted; this snapshot cannot. */
CREATE TABLE IF NOT EXISTS package_letters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  package_id INTEGER NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  dispute_id INTEGER REFERENCES disputes(id) ON DELETE SET NULL,
  ref TEXT NOT NULL,
  account TEXT NOT NULL,
  bureau TEXT NOT NULL,
  body TEXT NOT NULL,
  captured_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (package_id, dispute_id)
);

/* One row per physical letter handed to a print-and-mail provider. */
CREATE TABLE IF NOT EXISTS mail_dispatches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  package_id INTEGER NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  dispute_id INTEGER REFERENCES disputes(id) ON DELETE SET NULL,
  provider TEXT NOT NULL DEFAULT 'lob',
  provider_letter_id TEXT NOT NULL,
  tracking TEXT,
  expected_delivery TEXT,
  status TEXT NOT NULL DEFAULT 'created',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (provider, provider_letter_id)
);

/* Provider webhook events, kept as the delivery audit trail. */
CREATE TABLE IF NOT EXISTS package_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
  package_id INTEGER REFERENCES packages(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_event_id TEXT,
  event TEXT NOT NULL,
  detail TEXT,
  occurred_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS case_insights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  theories TEXT NOT NULL DEFAULT '[]',
  model TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_clients_tenant ON clients (tenant_id);
CREATE INDEX IF NOT EXISTS idx_disputes_tenant ON disputes (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_documents_tenant ON documents (tenant_id, client_id);
CREATE INDEX IF NOT EXISTS idx_messages_client ON messages (client_id);
CREATE INDEX IF NOT EXISTS idx_audit_tenant ON audit_log (tenant_id, seq);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions (expires_at);
CREATE INDEX IF NOT EXISTS idx_resets_token ON password_resets (token_hash);
CREATE INDEX IF NOT EXISTS idx_emails_tenant ON emails (tenant_id, id);
CREATE INDEX IF NOT EXISTS idx_drafts_tenant ON drafts (tenant_id, id);
CREATE INDEX IF NOT EXISTS idx_platform_sessions_expiry ON platform_sessions (expires_at);
CREATE INDEX IF NOT EXISTS idx_insights_client ON case_insights (tenant_id, client_id, id);
CREATE INDEX IF NOT EXISTS idx_package_letters ON package_letters (tenant_id, package_id);
CREATE INDEX IF NOT EXISTS idx_dispatches_package ON mail_dispatches (tenant_id, package_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_package_events_dedupe ON package_events (provider, provider_event_id);
CREATE INDEX IF NOT EXISTS idx_package_events_package ON package_events (package_id, id);
CREATE INDEX IF NOT EXISTS idx_billing_events_tenant ON billing_events (tenant_id, received_at);
`;

db.exec(schema);

/** Additive migrations for databases created before a column existed. */
function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((entry) => entry.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

ensureColumn("users", "must_change_password", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("disputes", "letter_body", "TEXT");
/* Workspace lifecycle, driven from the platform console. */
ensureColumn("tenants", "status", "TEXT NOT NULL DEFAULT 'active'");
ensureColumn("tenants", "suspended_at", "TEXT");
ensureColumn("tenants", "suspended_note", "TEXT");
/* Which gateway/model produced a draft, so an AI-edited letter stays traceable. */
ensureColumn("drafts", "ai_model", "TEXT");
ensureColumn("drafts", "ai_refined_at", "TEXT");
ensureColumn("packages", "sent_at", "TEXT");
/* Billing, driven by Stripe Checkout and kept current by its webhooks. */
ensureColumn("tenants", "plan", "TEXT");
ensureColumn("tenants", "plan_status", "TEXT");
ensureColumn("tenants", "plan_renews_at", "TEXT");
ensureColumn("tenants", "plan_updated_at", "TEXT");
ensureColumn("tenants", "stripe_customer_id", "TEXT");
ensureColumn("tenants", "stripe_subscription_id", "TEXT");
ensureColumn("tenants", "billing_email", "TEXT");
// Created after the column exists: the schema block runs before the migrations.
db.exec("CREATE INDEX IF NOT EXISTS idx_tenants_stripe_customer ON tenants (stripe_customer_id);");
try {
  db.exec("PRAGMA busy_timeout = 5000;");
} catch { /* older SQLite builds */ }

export function getTenantById(id) {
  return db.prepare("SELECT * FROM tenants WHERE id = ?").get(Number(id));
}

/** Read an operator setting (Stripe keys and anything else deployment-wide). */
export function getSetting(key) {
  return db.prepare("SELECT value FROM platform_settings WHERE key = ?").get(String(key))?.value || "";
}

export function setSetting(key, value, updatedBy = "platform operator") {
  const clean = String(value ?? "").trim();
  if (!clean) {
    db.prepare("DELETE FROM platform_settings WHERE key = ?").run(String(key));
    return;
  }
  db.prepare(
    `INSERT INTO platform_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
  ).run(String(key), clean, new Date().toISOString(), updatedBy);
}

export function getTenantBySlug(slug) {
  return db.prepare("SELECT * FROM tenants WHERE slug = ?").get(String(slug));
}

export function tenantForHost(host) {
  const clean = String(host || "").split(":")[0].toLowerCase();
  const byDomain = db.prepare("SELECT * FROM tenants WHERE lower(domain) = ?").get(clean);
  if (byDomain) return byDomain;
  return db.prepare("SELECT * FROM tenants ORDER BY id LIMIT 1").get();
}

export function audit(tenantId, actorName, action, target, when = new Date().toISOString()) {
  const last = db
    .prepare("SELECT seq, hash FROM audit_log WHERE tenant_id = ? ORDER BY seq DESC LIMIT 1")
    .get(tenantId);
  const seq = (last?.seq || 0) + 1;
  const prev = last?.hash || "0".repeat(64);
  const hash = sha256([prev, seq, actorName, action, target, when].join("|"));
  db.prepare(
    "INSERT INTO audit_log (tenant_id, seq, actor_name, action, target, prev_hash, hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(tenantId, seq, actorName, action, target, prev, hash, when);
  return { seq, hash, prev, when };
}

export function verifyAuditChain(tenantId) {
  const rows = db
    .prepare("SELECT * FROM audit_log WHERE tenant_id = ? ORDER BY seq ASC")
    .all(tenantId);
  let prev = "0".repeat(64);
  for (const row of rows) {
    const expected = sha256([prev, row.seq, row.actor_name, row.action, row.target, row.created_at].join("|"));
    if (row.prev_hash !== prev || row.hash !== expected) {
      return { ok: false, checked: row.seq - 1, total: rows.length, at: row.seq };
    }
    prev = row.hash;
  }
  return { ok: true, checked: rows.length, total: rows.length };
}

export function auditEntries(tenantId, limit = 100) {
  return db
    .prepare("SELECT * FROM audit_log WHERE tenant_id = ? ORDER BY seq DESC LIMIT ?")
    .all(tenantId, limit);
}

/** Next reference uses the highest numeric suffix, not the newest row (seed data is out of order). */
export function nextRef(tenantId, table, prefix) {
  const row = db
    .prepare(
      `SELECT MAX(CAST(substr(ref, ?) AS INTEGER)) AS n FROM ${table} WHERE tenant_id = ? AND ref LIKE ?`
    )
    .get(prefix.length + 2, tenantId, `${prefix}-%`);
  const n = Number(row?.n) || 1000;
  return `${prefix}-${n + 1}`;
}

export function nextDocRef(tenantId) {
  const row = db
    .prepare("SELECT MAX(CAST(substr(ref, 5) AS INTEGER)) AS n FROM documents WHERE tenant_id = ? AND ref LIKE 'DOC-%'")
    .get(tenantId);
  const n = Number(row?.n) || 1000;
  return `DOC-${n + 1}`;
}

export function emailRows(tenantId, limit = 100) {
  return db
    .prepare("SELECT * FROM emails WHERE tenant_id = ? ORDER BY id DESC LIMIT ?")
    .all(tenantId, limit);
}

export function tenantStats(tenantId) {
  const one = (sql) => db.prepare(sql).get(tenantId)?.n || 0;
  return {
    clients: one("SELECT COUNT(*) AS n FROM clients WHERE tenant_id = ?"),
    openDisputes: one(
      "SELECT COUNT(*) AS n FROM disputes WHERE tenant_id = ? AND status NOT IN ('Deleted','Closed')"
    ),
    readyPackages: one("SELECT COUNT(*) AS n FROM packages WHERE tenant_id = ? AND status = 'Ready'"),
    pendingDocs: one("SELECT COUNT(*) AS n FROM documents WHERE tenant_id = ? AND status = 'Pending review'"),
    removed: one("SELECT COUNT(*) AS n FROM disputes WHERE tenant_id = ? AND status = 'Deleted'"),
    awaiting: one(
      "SELECT COUNT(*) AS n FROM disputes WHERE tenant_id = ? AND status = 'Awaiting response'"
    )
  };
}

/**
 * What one workspace owns, counted before it is removed.
 *
 * A delete that only says "done" is not enough: removing a workspace takes its
 * clients, their disputes, their letters and every seat with it, and the
 * operator who pressed the button should be told the size of what went. This is
 * the receipt, read before the rows are.
 */
export function tenantFootprint(tenantId) {
  const one = (table) =>
    db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id = ?`).get(tenantId)?.n || 0;
  return {
    clients: one("clients"),
    seats: one("users"),
    disputes: one("disputes"),
    packages: one("packages"),
    documents: one("documents"),
    messages: one("messages")
  };
}

/**
 * Remove one document's stored file from `DATA_DIR/uploads`.
 *
 * `stored_name` comes out of the database, so it is a filename and not a path —
 * but it is still a value a row controls, and `path.basename` is what stops a
 * row from naming a file outside the uploads directory. Best effort: a missing
 * file is not a failed delete.
 */
function removeUpload(storedName) {
  if (!storedName) return false;
  try {
    fs.unlinkSync(path.join(DATA_DIR, "uploads", path.basename(String(storedName))));
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy the database, and the uploads about to be removed, somewhere safe.
 *
 * `VACUUM INTO` rather than a file copy: the deployment runs in WAL mode, so
 * `clearpath.db` plus everything committed since the last checkpoint lives in
 * `clearpath.db-wal` — copying the first file alone can lose the rows written
 * most recently, which are exactly the ones a mistaken delete is about.
 * `VACUUM INTO` writes one consistent, already-checkpointed file.
 *
 * The files go with it: a restored database whose document rows point at
 * uploads that were deleted is only half an undo. `storedNames === null` means
 * "everything in the uploads directory", which is what a reset needs.
 *
 * Returns `{ name, dir, database, files }`; `name` is the directory's own name
 * so a notice can name the snapshot without printing a host path.
 */
function archive(tag, storedNames) {
  const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${tag}`;
  const dir = path.join(DATA_DIR, "backups", name);
  fs.mkdirSync(path.join(dir, "uploads"), { recursive: true });
  const database = path.join(dir, "database.db");
  // VACUUM INTO takes a path in SQL, so a quote in DATA_DIR would end the string.
  db.exec(`VACUUM INTO '${database.replace(/'/g, "''")}'`);

  const names = storedNames === null ? fs.readdirSync(path.join(DATA_DIR, "uploads")) : storedNames;
  let files = 0;
  for (const storedName of names) {
    if (!storedName) continue;
    const base = path.basename(String(storedName));
    try {
      fs.copyFileSync(path.join(DATA_DIR, "uploads", base), path.join(dir, "uploads", base));
      files += 1;
    } catch {
      // A document row can outlive its file (a manual cleanup, a restore). One
      // missing file must not turn a delete into a refusal.
    }
  }
  return { name, dir, database, files };
}

/**
 * Delete a workspace and everything hanging off it.
 *
 * The schema carries `ON DELETE CASCADE` from `tenants` to clients, users,
 * sessions, tradelines, disputes, packages, documents, messages, drafts and the
 * rest, with `PRAGMA foreign_keys = ON` set at connect time — so this is one
 * row, and SQLite takes the workspace with it. `leads` is deliberately not
 * cascaded (`ON DELETE SET NULL`): a prospect who filled the marketing form is
 * not the workspace's to delete.
 *
 * Files are removed only after the commit succeeds: a delete that rolls back
 * must not have taken the documents with it. Returns the receipt, or null when
 * the workspace was already gone.
 */
export function deleteTenant(tenantId) {
  const tenant = getTenantById(tenantId);
  if (!tenant) return null;
  const footprint = tenantFootprint(tenant.id);
  const files = db
    .prepare("SELECT stored_name FROM documents WHERE tenant_id = ? AND stored_name IS NOT NULL")
    .all(tenant.id)
    .map((row) => row.stored_name);

  // Before anything is deleted, and outside the transaction: VACUUM cannot run
  // inside one, and a snapshot taken after the delete would be an empty comfort.
  const backup = archive(`delete-${tenant.slug}`, files);

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM tenants WHERE id = ?").run(tenant.id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  const removedFiles = files.filter(removeUpload).length;
  return { tenant, footprint, files: removedFiles, backup };
}

/**
 * Return the deployment to a fresh install: every workspace, client and their
 * records gone, this deployment's own identity left intact.
 *
 * What survives is deliberate. `platform_admins` and `platform_sessions` stay,
 * because a reset that signs the operator out of the console they just used is
 * a lockout with extra steps. `platform_settings` stays, because it holds the
 * Stripe keys and losing them silently turns billing off — the reset is about
 * the customers, not the operator's configuration.
 *
 * Everything else goes, including the rows that have no tenant to cascade from:
 * `leads` (a prospect list is not an install), `emails` and `package_events`
 * and `billing_events` carry tenant-less rows of their own, and the `sqlite_sequence`
 * counters are cleared so the first workspace of the new install is id 1.
 */
export function resetInstall() {
  const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n || 0;
  const before = { tenants: count("tenants"), clients: count("clients"), files: 0 };
  // The whole uploads directory is about to be swept, so the whole directory is
  // what the snapshot carries — otherwise "undo" means a database of rows that
  // point at files nobody can produce.
  const backup = archive("reset", null);

  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DELETE FROM tenants");
    db.exec("DELETE FROM leads");
    db.exec("DELETE FROM emails");
    db.exec("DELETE FROM billing_events");
    db.exec("DELETE FROM package_events");
    // A `sqlite_sequence` table only exists once an AUTOINCREMENT table has held
    // a row, so on a never-used install this is legitimately absent.
    try {
      db.exec("DELETE FROM sqlite_sequence");
    } catch {
      /* no AUTOINCREMENT rows yet */
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  // The directory is swept rather than the document rows walked: a file whose
  // row was already gone would otherwise stay on disk through every reset, and
  // "clean install" has to mean the disk too.
  try {
    for (const entry of fs.readdirSync(path.join(DATA_DIR, "uploads"), { withFileTypes: true })) {
      if (entry.isFile() && removeUpload(entry.name)) before.files += 1;
    }
  } catch {
    /* the uploads directory is created at start-up; a reset on a bare install has none */
  }
  return { ...before, backup };
}

export function seedDemo() {
  const existing = db.prepare("SELECT COUNT(*) AS n FROM tenants").get().n;
  if (existing > 0) return false;

  const insertTenant = db.prepare(
    `INSERT INTO tenants (slug, name, domain, brand_name, tagline, logo, accent, support_email, support_phone, address, portal_name, welcome)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const denovo = Number(
    insertTenant.run(
      "denovo",
      "Denovo Credit",
      "denovocredit.com",
      "Denovo Credit",
      "Credit repair, handled properly.",
      "DC",
      "#1f5eff",
      "hello@denovocredit.com",
      "(774) 505-7135",
      "2200 Market St, Suite 410 · San Francisco, CA 94114",
      "Client portal",
      "Track every dispute, upload what we need, and see exactly what changed on your file."
    ).lastInsertRowid
  );

  const northstar = Number(
    insertTenant.run(
      "northstar",
      "Northstar Credit Group",
      "northstar.clearpath.test",
      "Northstar Credit Group",
      "A clearer path to a stronger file.",
      "NC",
      "#0f766e",
      "care@northstar.test",
      "(312) 555-0142",
      "18 W Lake St, Chicago, IL 60601",
      "Your account",
      "Your disputes, documents and updates in one place."
    ).lastInsertRowid
  );

  const insertClient = db.prepare(
    `INSERT INTO clients (tenant_id, ref, name, email, phone, stage, portal_status, joined, tu, ex, eq, delta, utilization, docs_verified, docs_total, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const addClient = (tenantId, ref, name, email, phone, stage, tu, ex, eq, delta, util, dv, dt, notes) =>
    Number(
      insertClient.run(
        tenantId, ref, name, email, phone, stage, "Active", "Feb 12, 2026",
        tu, ex, eq, delta, util, dv, dt, notes
      ).lastInsertRowid
    );

  const amara = addClient(denovo, "CL-1001", "Amara Okafor", "amara.okafor@example.com", "(415) 555-0142", "Active", 648, 622, 639, 42, 34, 9, 11, "Round 2 packets went out certified on Oct 14. Prefers SMS updates.");
  const devon = addClient(denovo, "CL-1002", "Devon Clarke", "devon.clarke@example.com", "(202) 555-0110", "Active", 663, 671, 655, 27, 44, 7, 8, "Round 2 scheduled automatically for Nov 12.");
  const priya = addClient(denovo, "CL-1003", "Priya Raman", "priya.raman@example.com", "(646) 555-0177", "Onboarding", 584, 561, 578, 6, 58, 3, 7, "Waiting on signed service agreement and proof of address.");
  const sofia = addClient(denovo, "CL-1004", "Sofia Marquez", "sofia.marquez@example.com", "(786) 555-0164", "Review", 599, 588, 604, 12, 62, 5, 9, "Escalated inquiry response from TransUnion on Oct 2.");
  const hannah = addClient(denovo, "CL-1005", "Hannah Kim", "hannah.kim@example.com", "(206) 555-0125", "Active", 690, 684, 699, 33, 29, 8, 8, "Auto-pay enrollment confirmed with Toyota Financial.");

  const northClient = Number(
    insertClient.run(
      northstar, "CL-1001", "Rosa Diaz", "rosa.diaz@example.com", "(312) 555-0199",
      "Active", "Active", "Mar 3, 2026", 701, 688, 695, 51, 18, 6, 7, "Round 1 complete, waiting on Experian."
    ).lastInsertRowid
  );

  const insertUser = db.prepare(
    "INSERT INTO users (tenant_id, email, name, role, client_id, password_hash, password_salt) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  const addUser = (tenantId, email, name, role, clientId, password) => {
    const { hash, salt } = hashPassword(password);
    insertUser.run(tenantId, email, name, role, clientId, hash, salt);
  };

  addUser(denovo, "dana@denovocredit.com", "Dana Whitfield", "owner", null, "Denovo!2026");
  addUser(denovo, "marcus@denovocredit.com", "Marcus Lee", "specialist", null, "Specialist!2026");
  addUser(denovo, "amara@example.com", "Amara Okafor", "client", amara, "Client!2026");
  addUser(denovo, "priya@example.com", "Priya Raman", "client", priya, "Client!2026");
  addUser(northstar, "owner@northstar.test", "Jordan Lee", "owner", null, "Northstar!2026");
  addUser(northstar, "rosa@example.com", "Rosa Diaz", "client", northClient, "Client!2026");

  const insertTradeline = db.prepare(
    `INSERT INTO tradelines (tenant_id, client_id, bureau, creditor, mask, type, balance, opened, reason, strength, evidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const addTradeline = (tenantId, clientId, bureau, creditor, mask, type, balance, opened, reason, strength, evidence) =>
    Number(
      insertTradeline.run(
        tenantId, clientId, bureau, creditor, mask, type, balance, opened, reason, strength,
        JSON.stringify(evidence)
      ).lastInsertRowid
    );

  const amara1 = addTradeline(denovo, amara, "tu", "Jefferson Capital", "4821", "Collection", 1284, "Mar 2024", "Account does not belong to this consumer (identity mismatch)", 94, ["Identity theft affidavit", "Police report"]);
  const amara2 = addTradeline(denovo, amara, "eq", "Portfolio Recovery", "7742", "Collection", 892, "Nov 2023", "Same debt reported twice by two collectors", 91, ["Credit report excerpt"]);
  const amara3 = addTradeline(denovo, amara, "tu", "Kroll", "0000", "Hard inquiry", 0, "Jan 2026", "No permissible purpose for this inquiry", 76, []);
  addTradeline(denovo, devon, "tu", "Santander", "6620", "Repossession", 0, "Jun 2022", "Vehicle sold — balance after sale misreported", 78, ["Sale receipt"]);
  addTradeline(denovo, devon, "eq", "Chase", "1150", "Late payment", 0, "Oct 2024", "Late marker applied after payment reversal", 86, ["Statement"]);
  addTradeline(denovo, priya, "ex", "Northside Medical", "0412", "Collection", 412, "Dec 2024", "Paid by insurance — should not be reported", 92, ["Insurance EOB"]);
  addTradeline(denovo, priya, "eq", "Verizon", "5521", "Collection", 268, "Feb 2025", "Equipment returned — account closed in good standing", 73, ["Return receipt"]);
  addTradeline(denovo, sofia, "ex", "Portfolio Recovery", "3391", "Collection", 1104, "Apr 2024", "Account does not belong to this consumer", 89, ["Identity theft affidavit"]);
  addTradeline(denovo, sofia, "tu", "Capital One", "2277", "Late payment", 0, "Nov 2025", "Goodwill adjustment requested", 67, []);
  addTradeline(denovo, hannah, "eq", "Toyota Financial", "8820", "Late payment", 0, "Mar 2025", "30-day late reported twice for the same month", 87, ["Payment history"]);
  const northTradeline = addTradeline(northstar, northClient, "ex", "Synchrony", "4410", "Charge-off", 0, "Feb 2023", "Paid in full — balance and status not updated", 90, ["Payoff letter"]);

  const insertDispute = db.prepare(
    `INSERT INTO disputes (tenant_id, client_id, tradeline_id, ref, bureau, account, issue, round, status, confidence, mailed, due, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const addDispute = (tenantId, clientId, tradelineId, ref, bureau, account, issue, round, status, confidence, mailed, due) =>
    insertDispute.run(
      tenantId, clientId, tradelineId, ref, bureau, account, issue, round, status, confidence,
      mailed, due, new Date().toISOString()
    );

  addDispute(denovo, amara, amara1, "DSP-1054", "tu", "Jefferson Capital ••4821", "Not my account", 2, "Awaiting response", 94, "Oct 14", "Nov 12");
  addDispute(denovo, amara, amara2, "DSP-1050", "eq", "Portfolio Recovery ••7742", "Duplicate collection", 1, "Queued", 91, null, null);
  addDispute(denovo, amara, amara3, "DSP-1048", "tu", "Kroll ••0000", "No permissible purpose", 1, "Escalated", 76, "Oct 2", "Nov 1");
  addDispute(denovo, devon, null, "DSP-1051", "tu", "Santander ••6620", "Balance after sale misreported", 1, "Needs review", 78, null, null);
  addDispute(denovo, devon, null, "DSP-1053", "ex", "Chase ••1150", "Late payment reported in error", 1, "Awaiting response", 88, "Oct 12", "Nov 10");
  addDispute(denovo, priya, null, "DSP-1052", "ex", "Northside Medical ••0412", "Paid by insurance", 2, "Needs review", 92, null, null);
  addDispute(denovo, sofia, null, "DSP-1049", "ex", "Portfolio Recovery ••3391", "Not my account", 1, "Needs review", 89, null, null);
  addDispute(denovo, sofia, null, "DSP-1042", "tu", "Capital One ••2277", "Goodwill adjustment", 1, "Needs review", 67, null, null);
  addDispute(denovo, hannah, null, "DSP-1047", "eq", "Toyota Financial ••8820", "Duplicate late mark", 1, "Awaiting response", 87, "Oct 8", "Nov 6");
  addDispute(northstar, northClient, northTradeline, "DSP-2001", "ex", "Synchrony ••4410", "Paid in full, not updated", 1, "Awaiting response", 90, "Oct 10", "Nov 8");

  const insertPackage = db.prepare(
    `INSERT INTO packages (tenant_id, client_id, ref, bureau, letters, method, status, tracking, eta, cost, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  [
    [denovo, amara, "PKG-2091", "tu", 2, "Certified + return receipt", "In transit", "9405 5118 9956 0000 0000 42", "Oct 24", 9.85, "Oct 18"],
    [denovo, devon, "PKG-2089", "eq", 1, "Certified", "Delivered", "9405 5118 9956 0000 0000 37", "Delivered Oct 20", 8.2, "Oct 15"],
    [denovo, hannah, "PKG-2087", "eq", 1, "Certified", "Ready", null, null, 8.2, "Oct 21"],
    [northstar, northClient, "PKG-3001", "ex", 1, "Certified", "In transit", "9405 5118 9956 0000 0000 88", "Oct 26", 9.85, "Oct 18"]
  ].forEach((row) => insertPackage.run(...row));

  const insertDocument = db.prepare(
    `INSERT INTO documents (tenant_id, client_id, ref, name, type, status, size, sha256, uploaded_by, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  [
    [denovo, amara, "DOC-3310", "Government ID — front.jpg", "Identity", "Verified", "1.2 MB", "a91f2c…3c2b", "agency", "Oct 18, 2026"],
    [denovo, amara, "DOC-3309", "Proof of address — utility bill.pdf", "Identity", "Verified", "480 KB", "77c09e…9ed1", "client", "Oct 18, 2026"],
    [denovo, priya, "DOC-3301", "Lease agreement.pdf", "Identity", "Pending review", "2.1 MB", "aa025b…5b71", "client", "Oct 21, 2026"],
    [denovo, devon, "DOC-3304", "Police report — identity theft.pdf", "Evidence", "Verified", "1.8 MB", "33ab8e…8e2f", "agency", "Oct 9, 2026"],
    [denovo, hannah, "DOC-3306", "Toyota payment history.pdf", "Evidence", "Verified", "890 KB", "e1a744…44b0", "agency", "Oct 16, 2026"],
    [northstar, northClient, "DOC-4001", "Synchrony payoff letter.pdf", "Evidence", "Verified", "310 KB", "9910aa…e210", "client", "Oct 12, 2026"]
  ].forEach((row) => insertDocument.run(...row));

  const insertRequest = db.prepare(
    "INSERT INTO doc_requests (tenant_id, client_id, label, type, due, done, note) VALUES (?, ?, ?, ?, ?, 0, ?)"
  );
  insertRequest.run(denovo, priya, "Signed client agreement", "Agreement", "Oct 30", "Your service agreement is the last onboarding step.");
  insertRequest.run(denovo, priya, "Proof of current address", "Identity", "Oct 30", "A utility bill or lease from the last 60 days.");
  insertRequest.run(denovo, sofia, "Identity theft affidavit", "Evidence", "Nov 4", "Notarized copy for the Portfolio Recovery item.");

  const insertMessage = db.prepare(
    "INSERT INTO messages (tenant_id, client_id, author_role, author_name, body, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  );
  insertMessage.run(denovo, amara, "agency", "Dana Whitfield", "Round 2 went out certified on Oct 14. TransUnion has 30 days from delivery — I will post their response here the day it lands.", "2026-10-15T09:12:00.000Z");
  insertMessage.run(denovo, amara, "client", "Amara Okafor", "Thanks. I uploaded the police report you asked for. Let me know if you need the case number page too.", "2026-10-18T16:40:00.000Z");
  insertMessage.run(denovo, amara, "agency", "Dana Whitfield", "Got it — that is exactly what we needed. Nothing else for now.", "2026-10-18T17:02:00.000Z");
  insertMessage.run(denovo, priya, "agency", "Dana Whitfield", "Welcome aboard. To finish onboarding we need a signed agreement and proof of address — both can be uploaded in the portal.", "2026-10-20T10:22:00.000Z");

  const seedEvents = [
    [denovo, "Clearpath AI", "Generated dispute packet for", "Amara Okafor · TransUnion", "2026-10-22T07:42:00.000Z"],
    [denovo, "Dana Whitfield", "Approved and queued", "DSP-1054 · PKG-2091", "2026-10-22T07:12:00.000Z"],
    [denovo, "Client portal", "Uploaded proof of address for", "Amara Okafor", "2026-10-22T06:57:00.000Z"],
    [denovo, "USPS", "Certified package delivered to", "Devon Clarke · PKG-2089", "2026-10-21T17:20:00.000Z"],
    [denovo, "Dana Whitfield", "Invited client to the portal:", "Hannah Kim", "2026-10-20T10:15:00.000Z"],
    [northstar, "Jordan Lee", "Approved and queued", "Rosa Diaz · Experian", "2026-10-20T15:10:00.000Z"]
  ];
  seedEvents
    .sort((a, b) => String(a[4]).localeCompare(String(b[4])))
    .forEach(([tenantId, actor, action, target, when]) => audit(tenantId, actor, action, target, when));

  return true;
}

/* ---------------- platform console ---------------- */

/**
 * Bootstrap the platform operator account.
 *
 * PLATFORM_ADMIN_EMAIL + PLATFORM_ADMIN_PASSWORD create the account on boot.
 * With SEED_DEMO enabled a demo operator is seeded instead so the console is
 * usable out of the box. Nothing is created when a real operator already exists.
 */
export function ensurePlatformAdmin() {
  const email = String(process.env.PLATFORM_ADMIN_EMAIL || "").trim().toLowerCase();
  const password = String(process.env.PLATFORM_ADMIN_PASSWORD || "");
  const name = String(process.env.PLATFORM_ADMIN_NAME || "Platform admin").trim().slice(0, 80);
  const total = db.prepare("SELECT COUNT(*) AS n FROM platform_admins").get().n;

  if (email && password) {
    if (db.prepare("SELECT id FROM platform_admins WHERE email = ?").get(email)) {
      return { created: false, email };
    }
    const { hash, salt } = hashPassword(password);
    db.prepare(
      "INSERT INTO platform_admins (email, name, password_hash, password_salt) VALUES (?, ?, ?, ?)"
    ).run(email, name, hash, salt);
    return { created: true, email, demo: false };
  }

  if (process.env.SEED_DEMO !== "0" && total === 0) {
    const { hash, salt } = hashPassword("Platform!2026");
    db.prepare(
      "INSERT INTO platform_admins (email, name, password_hash, password_salt) VALUES (?, ?, ?, ?)"
    ).run("platform@clearpath.test", "Platform admin", hash, salt);
    return { created: true, email: "platform@clearpath.test", demo: true };
  }
  return { created: false, email: null };
}

export function listTenants() {
  return db.prepare("SELECT * FROM tenants ORDER BY status = 'active' DESC, name").all();
}

/** Counts shown in the platform tenant list and drill-down. */
export function tenantUsage(tenantId) {
  const one = (sql) => db.prepare(sql).get(tenantId)?.n || 0;
  return {
    clients: one("SELECT COUNT(*) AS n FROM clients WHERE tenant_id = ?"),
    seats: one("SELECT COUNT(*) AS n FROM users WHERE tenant_id = ? AND role IN ('owner','specialist')"),
    portalAccounts: one("SELECT COUNT(*) AS n FROM users WHERE tenant_id = ? AND role = 'client'"),
    openDisputes: one(
      "SELECT COUNT(*) AS n FROM disputes WHERE tenant_id = ? AND status NOT IN ('Deleted','Closed')"
    ),
    mailed: one(
      "SELECT COUNT(*) AS n FROM disputes WHERE tenant_id = ? AND status IN ('Mailed','Awaiting response','Escalated')"
    ),
    documents: one("SELECT COUNT(*) AS n FROM documents WHERE tenant_id = ?"),
    packages: one("SELECT COUNT(*) AS n FROM packages WHERE tenant_id = ?"),
    lastActivity: db.prepare("SELECT MAX(created_at) AS at FROM audit_log WHERE tenant_id = ?").get(tenantId)?.at || null
  };
}

export function tenantTeam(tenantId) {
  return db
    .prepare(
      "SELECT id, name, email, role, last_login_at, must_change_password FROM users WHERE tenant_id = ? ORDER BY role, name"
    )
    .all(tenantId);
}

/** Client roster for the platform drill-down, with dispute counts per file. */
export function tenantClients(tenantId) {
  return db
    .prepare(
      `SELECT c.*,
              (SELECT COUNT(*) FROM disputes d WHERE d.client_id = c.id AND d.status NOT IN ('Deleted','Closed')) AS open_disputes,
              (SELECT COUNT(*) FROM documents doc WHERE doc.client_id = c.id) AS documents
       FROM clients c WHERE c.tenant_id = ? ORDER BY c.name`
    )
    .all(tenantId);
}

export function latestInsight(tenantId, clientId) {
  return db
    .prepare("SELECT * FROM case_insights WHERE tenant_id = ? AND client_id = ? ORDER BY id DESC LIMIT 1")
    .get(tenantId, clientId);
}

export { DATA_DIR, DB_PATH };
