import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Minimal .env loader.
 *
 * ESM imports run in order, so `import "./env.js"` must come first in an entry
 * point: everything that reads process.env at module scope (db.js resolves
 * DB_PATH on import) then sees the file's values. Real environment variables
 * always win, so a container, systemd unit or `VAR=x node server/index.js`
 * can override anything in the file.
 *
 * Supports `KEY=value`, `export KEY=value`, comments and single/double quotes.
 * Deliberately simple: no interpolation, no multiline values.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

function parse(content) {
  const pairs = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ") ? line.slice(7).trim() : line;
    const at = withoutExport.indexOf("=");
    if (at < 1) continue;
    const key = withoutExport.slice(0, at).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = withoutExport.slice(at + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"") && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    if (value === "") continue;
    pairs.push([key, value]);
  }
  return pairs;
}

export function loadEnv(file = process.env.ENV_FILE || path.resolve(here, "..", ".env")) {
  const target = path.resolve(file);
  let content;
  try {
    content = fs.readFileSync(target, "utf8");
  } catch {
    return { loaded: false, file: target, applied: 0 };
  }

  let applied = 0;
  for (const [key, value] of parse(content)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
      applied += 1;
    }
  }
  return { loaded: true, file: target, applied };
}

loadEnv();
