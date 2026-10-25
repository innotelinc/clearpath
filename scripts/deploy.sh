#!/usr/bin/env bash
#
# Deploy the checkout at $DIR to a ref, and prove the deployment came up.
#
#   scripts/deploy.sh                     deploy origin/main
#   scripts/deploy.sh --dry-run           say what it would do, change nothing
#   scripts/deploy.sh --ref origin/main   deploy a particular ref
#   scripts/deploy.sh --force             proceed past uncommitted changes
#
# Run on the host that serves the site, as root:
#
#   incus exec i2move:clearpath -- bash /opt/clearpath/scripts/deploy.sh
#
# The manual sequence in DEPLOY.md is this script: take a snapshot of the
# database, move the checkout, reinstall, restart the unit, wait for /healthz.
# The two steps the manual sequence did not have are the ones that matter when
# the deploy is wrong — a rollback to the commit that was serving, and a check
# that the bytes now being served are the bytes in the checkout.
#
# The snapshot is `VACUUM INTO`, not `cp`: the app runs SQLite in WAL mode, so a
# copy of `clearpath.db` alone can be missing everything committed since the last
# checkpoint. Nothing here removes the snapshot; they accumulate in
# $DATA_DIR/backups and are the only way back from a migration that misbehaves.
set -euo pipefail

DIR=/opt/clearpath
REF=origin/main
UNIT=clearpath
URL=http://127.0.0.1:3000
DATA_DIR_ARG=""
DRY_RUN=0
FORCE=0

usage() {
  sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-1}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="${2:?--ref needs a value}"; shift 2 ;;
    --dir) DIR="${2:?--dir needs a value}"; shift 2 ;;
    --unit) UNIT="${2:?--unit needs a value}"; shift 2 ;;
    --url) URL="${2:?--url needs a value}"; shift 2 ;;
    --data-dir) DATA_DIR_ARG="${2:?--data-dir needs a value}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) usage 0 ;;
    *) echo "deploy: unknown argument $1" >&2; usage 1 ;;
  esac
done

say() { printf '\n== %s\n' "$*"; }
run() {
  printf '   %s\n' "$*"
  [ "$DRY_RUN" = 1 ] || "$@"
}

cd "$DIR" || { echo "deploy: no checkout at $DIR" >&2; exit 1; }
[ -d .git ] || { echo "deploy: $DIR is not a git checkout" >&2; exit 1; }

# The checkout belongs to the service user; as root, git rejects it otherwise.
OWNER=$(stat -c %U "$DIR")
git_as() {
  if [ "$(id -un)" = "$OWNER" ]; then git "$@"; else runuser -u "$OWNER" -- git "$@"; fi
}
owner_do() {
  if [ "$(id -un)" = "$OWNER" ]; then "$@"; else runuser -u "$OWNER" -- "$@"; fi
}

if ! git_as rev-parse --verify --quiet "$REF" >/dev/null; then
  echo "deploy: fetching $REF"
  git_as fetch --prune origin
fi
TARGET=$(git_as rev-parse --short "$REF")
PREVIOUS=$(git_as rev-parse --short HEAD)

DIRTY=$(git_as status --porcelain)
if [ -n "$DIRTY" ] && [ "$FORCE" != 1 ]; then
  echo "deploy: $DIR has uncommitted changes; they would be discarded by the reset." >&2
  printf '%s\n' "$DIRTY" | sed 's/^/   /' >&2
  echo "deploy: commit them, or pass --force to throw them away." >&2
  exit 1
fi

# DATA_DIR comes from the app's own .env, which is how the service is configured.
DATA_DIR="${DATA_DIR_ARG:-${DATA_DIR:-}}"
if [ -z "$DATA_DIR" ] && [ -f "$DIR/.env" ]; then
  DATA_DIR=$(sed -n 's/^DATA_DIR=//p' "$DIR/.env" | tail -1 | tr -d '"'"'"'[:space:]')
fi
DATA_DIR="${DATA_DIR:-$DIR/data}"
DB="${DB_PATH:-$DATA_DIR/clearpath.db}"

say "deploying $REF ($TARGET) over $PREVIOUS"
echo "   checkout $DIR (owner $OWNER)"
echo "   database $DB"
echo "   unit     $UNIT"
[ "$DRY_RUN" = 1 ] && echo "   (dry run — nothing below is executed)"
[ -n "$DIRTY" ] && echo "   uncommitted changes are being discarded (--force)"

say "snapshot the database"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
SNAPSHOT="$DATA_DIR/backups/clearpath-$STAMP-deploy.db"
if [ -f "$DB" ]; then
  run owner_do mkdir -p "$DATA_DIR/backups"
  # node is the one runtime guaranteed to be here, and `VACUUM INTO` is the only
  # way to read a live WAL database without stopping the service.
  run owner_do node --input-type=module -e '
    import { DatabaseSync } from "node:sqlite";
    const [from, to] = process.argv.slice(2);
    const db = new DatabaseSync(from);
    db.exec(`VACUUM INTO \x27${to.replace(/\x27/g, "\x27\x27")}\x27`);
    db.close();
  ' "$DB" "$SNAPSHOT"
  echo "   $SNAPSHOT"
else
  echo "   no database yet at $DB — first boot will create it"
  SNAPSHOT=""
fi

say "move the checkout to $TARGET"
run git_as reset --hard "$REF"

say "install dependencies"
run owner_do env HOME="$DIR" npm ci --omit=dev --no-audit --fund=false

say "restart $UNIT"
run systemctl restart "$UNIT"

healthy() {
  for _ in $(seq 1 30); do
    if [ "$(curl -fsS -o /dev/null -w '%{http_code}' "$URL/healthz" 2>/dev/null)" = 200 ]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

rollback() {
  say "rolling back to $PREVIOUS"
  systemctl restart "$UNIT" >/dev/null 2>&1 || true
  git_as reset --hard "$PREVIOUS" || return 1
  owner_do env HOME="$DIR" npm ci --omit=dev --no-audit --fund=false || return 1
  systemctl restart "$UNIT" || return 1
  healthy && echo "   back on $PREVIOUS and serving" || echo "   $PREVIOUS is not healthy either — check journalctl -u $UNIT"
}

if [ "$DRY_RUN" = 1 ]; then
  say "would wait for $URL/healthz, then compare the served stylesheet with the checkout"
  exit 0
fi

say "wait for the health check"
if ! healthy; then
  echo "deploy: $UNIT did not answer $URL/healthz after 30s" >&2
  journalctl -u "$UNIT" -n 20 --no-pager >&2 || true
  rollback
  exit 1
fi
echo "   $URL/healthz 200"

# The point of the deploy is the bytes the browser will get, not the git log.
# `/assets/css/app.css?v=<hash>` is computed from the file at request time, so a
# mismatch means the unit is still running the previous checkout.
say "check that the served stylesheet is the one in the checkout"
WANT=$(sha256sum "$DIR/public/css/app.css" | cut -c1-10)
SERVED=$(curl -fsS "$URL/" | grep -o 'css/app\.css?v=[0-9a-f]\{10\}' | head -1 | sed 's/.*v=//')
if [ "$SERVED" = "$WANT" ]; then
  echo "   app.css?v=$SERVED"
else
  echo "deploy: the site serves app.css?v=${SERVED:-none}, the checkout has $WANT" >&2
  echo "deploy: the unit is probably still on $PREVIOUS; see journalctl -u $UNIT" >&2
  rollback
  exit 1
fi

say "deployed $TARGET"
[ -n "$SNAPSHOT" ] && echo "   undo: git reset --hard $PREVIOUS, restore $SNAPSHOT over $DB, systemctl restart $UNIT"
