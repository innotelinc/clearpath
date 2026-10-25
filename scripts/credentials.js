/**
 * Print every account this database holds, with the password that opens it.
 *
 *   npm run credentials            print the sign-ins
 *   npm run credentials -- --site  print only the workspace URLs
 *
 * The seed writes its passwords into the database as scrypt hashes with a
 * per-user salt, so a password cannot be read back out of a row. What this
 * script does instead is hold the demonstration passwords the seed uses, try
 * each one against each stored hash, and print the one that verifies. A user
 * whose password has been changed since the seed therefore shows as
 * `(changed)` rather than as a password that no longer works.
 *
 * Read-only: it opens the database the server is using and prints a report.
 * The same report is on the platform console at `/platform/credentials` while
 * `SEED_DEMO` is on (see server/credentials.js).
 */
import "../server/env.js";
import { DB_PATH } from "../server/db.js";
import { credentialReport } from "../server/credentials.js";

const siteOnly = process.argv.includes("--site");
const report = credentialReport();

if (report.workspaces.length === 0) {
  console.log(`Database: ${DB_PATH}`);
  console.log("No workspace in this database — run `npm run seed` or create one in the platform console.");
  process.exit(0);
}

if (!siteOnly) {
  console.log(`Database: ${DB_PATH}`);
  console.log("Demo passwords are published in the README; run `npm run seed` to restore them.\n");
}

for (const workspace of report.workspaces) {
  console.log(`${workspace.name}${workspace.status !== "active" ? ` (${workspace.status})` : ""}`);
  if (workspace.site) {
    console.log(`  site    ${workspace.site}`);
    console.log(`  agency  ${workspace.agencyUrl}`);
    console.log(`  portal  ${workspace.portalUrl}`);
    if (workspace.defaultOrigin) {
      console.log(`  default ${workspace.defaultOrigin}  (served when the host matches no domain)`);
    }
  } else {
    console.log("  site    no domain set — not reachable by URL until one is added in Settings");
  }
  if (!siteOnly) {
    if (workspace.seats.length === 0) console.log("  no seats in this workspace");
    else {
      console.table(
        workspace.seats.map((seat) => ({
          Role: seat.role,
          Name: seat.name,
          Email: seat.email,
          Password: seat.password || "(changed — no demo password)"
        }))
      );
    }
  }
  console.log("");
}

if (!siteOnly && report.operators.length > 0) {
  console.log(`Platform console — ${report.platformUrl}`);
  console.table(
    report.operators.map((operator) => ({
      Name: operator.name,
      Email: operator.email,
      Password: operator.password || "(changed — no demo password)"
    }))
  );
  console.log("");
}

if (!siteOnly && report.changed > 0) {
  console.log(
    `${report.changed} account(s) no longer use a demo password. Reset one from Settings → Team,\n` +
      "or rebuild the demonstration install with `npm run reseed -- --confirm RESEED`."
  );
}
