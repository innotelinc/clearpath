import multer from "multer";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./db.js";
import { randomToken } from "./security.js";

const ALLOWED_MIME = ["application/pdf", "image/png", "image/jpeg", "image/heic", "image/heif"];

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME.includes(file.mimetype)) {
      const err = new Error("Unsupported file type");
      err.status = 400;
      return cb(err);
    }
    cb(null, true);
  }
});

/** Sniff the real file signature so a renamed executable cannot pass the MIME check. */
export function signature(file) {
  const b = file.buffer;
  if (b.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b.length > 12 && b.subarray(4, 8).toString("latin1") === "ftyp") return "heic";
  return null;
}

export function storeUpload(file, tenantId, clientId) {
  const kind = signature(file);
  if (!kind) {
    const err = new Error("File content does not match a PDF or image");
    err.status = 400;
    throw err;
  }
  const name = `${tenantId}-${clientId}-${Date.now()}-${randomToken(6)}.${kind}`;
  fs.mkdirSync(path.join(DATA_DIR, "uploads"), { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, "uploads", name), file.buffer);
  return name;
}

export function sizeLabel(bytes) {
  return bytes > 1048576
    ? `${(bytes / 1048576).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}
