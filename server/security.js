import crypto from "node:crypto";

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex");
}

export function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 64 * 1024 * 1024
  });
  return { hash: hash.toString("hex"), salt };
}

export function verifyPassword(password, salt, expectedHex) {
  try {
    const { hash } = hashPassword(password, salt);
    const a = Buffer.from(hash, "hex");
    const b = Buffer.from(String(expectedHex), "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function strongEnough(password) {
  return typeof password === "string" && password.length >= 10 && /[A-Za-z]/.test(password) && /\d/.test(password);
}

export function temporaryPassword() {
  const words = ["Harbor", "Cedar", "Summit", "Ridge", "Atlas", "Orbit"];
  const word = words[crypto.randomInt(words.length)];
  return `${word}-${crypto.randomInt(1000, 9999)}-${crypto.randomInt(10, 99)}`;
}
