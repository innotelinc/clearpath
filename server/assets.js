import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * URLs for `public/`, with the file's own content in the query string.
 *
 * `app.css` carries the whole interface and its URL never changed, so a deploy
 * that fixed a rule was invisible to anyone who had loaded the site before: the
 * browser (and the edge) kept serving the old stylesheet until a hard refresh.
 * `asset("css/app.css")` returns `/assets/css/app.css?v=<hash>`, which is a
 * different URL whenever the bytes change — and the same one when they do not.
 *
 * The hash is cached until the file's size or mtime moves, so `npm run dev`
 * picks up an edit without a restart. A missing file is not an error here: the
 * template still renders a plain URL and the static mount answers 404, which is
 * the same outcome as before this function existed.
 */
export function assetUrl(publicDir) {
  const seen = new Map();

  return function asset(relative) {
    const url = `/assets/${relative}`;
    let stat;
    try {
      stat = fs.statSync(path.join(publicDir, relative));
    } catch {
      return url;
    }
    const stamp = `${stat.size}:${stat.mtimeMs}`;
    const cached = seen.get(relative);
    if (cached !== undefined && cached.stamp === stamp) return cached.url;

    const digest = crypto
      .createHash("sha256")
      .update(fs.readFileSync(path.join(publicDir, relative)))
      .digest("hex")
      .slice(0, 10);

    const hashed = `${url}?v=${digest}`;
    seen.set(relative, { stamp, url: hashed });
    return hashed;
  };
}
