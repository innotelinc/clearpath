import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Sealing for secrets the database has to hold to be useful — currently the
 * workspace's SMTP password, which the mailer must hand back to the server in
 * clear text at send time. Values are AES-256-GCM encrypted with a key that
 * lives outside the database: `MAIL_SECRET` when set, otherwise a 32-byte key
 * file beside the database (mode 0600). Restoring a backup therefore needs the
 * data directory, not just the SQLite file.
 */

const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data");
const KEY_FILE = path.join(DATA_DIR, "mail.secret");
let cached = null;

function key() {
  if (cached) return cached;
  const fromEnv = String(process.env.MAIL_SECRET || process.env.SECRET_KEY || "").trim();
  if (fromEnv) {
    cached = crypto.createHash("sha256").update(fromEnv).digest();
    return cached;
  }
  try {
    const stored = Buffer.from(fs.readFileSync(KEY_FILE, "utf8").trim(), "hex");
    if (stored.length === 32) {
      cached = stored;
      return cached;
    }
  } catch { /* first run */ }
  cached = crypto.randomBytes(32);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(KEY_FILE, cached.toString("hex"), { mode: 0o600 });
  return cached;
}

export function sealSecret(value) {
  const text = String(value ?? "");
  if (!text) return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const sealed = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), sealed.toString("base64")].join(":");
}

export function openSecret(payload) {
  const parts = String(payload || "").split(":");
  if (parts.length !== 4 || parts[0] !== "v1") return "";
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(parts[1], "base64"));
    decipher.setAuthTag(Buffer.from(parts[2], "base64"));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], "base64")), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}
