#!/usr/bin/env bash
# Builds the public sync commit. Usage: scripts/export-public.sh <public checkout>
# Reads the private repo (git archive HEAD), gates the archive (scripts/public-gate.ts), then commits it on branch sync/<UTC date> in the
# public checkout. Never pushes, never runs gh, never writes to the private repo. Any refusal or gate hit leaves the public checkout as it was.
# Needs COCHECK_BOT_NAME and COCHECK_BOT_EMAIL: the only identity the commit carries.
set -euo pipefail

# Same reason as scripts/release.sh: only the committed allow file may excuse a hit, never one named in the caller's environment.
unset COCHECK_GATE_ALLOW

die() { echo "export-public: $*" >&2; exit 1; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The repo to export. Tests point this at a temp repo; in real use it is this repo.
SRC="$(cd "${COCHECK_EXPORT_SOURCE:-$ROOT}" && pwd -P)"
PUB_ARG="${1:-}"
[ -n "$PUB_ARG" ] || die "usage: scripts/export-public.sh <public checkout>"
[ -d "$PUB_ARG" ] || die "not a directory: $PUB_ARG"
PUB="$(cd "$PUB_ARG" && pwd -P)"
[ "$(git -C "$PUB" rev-parse --show-toplevel 2>/dev/null || true)" = "$PUB" ] || die "not the top of a git checkout: $PUB"
[ "$PUB" != "$SRC" ] || die "the public checkout is the private repo"

[ -n "${COCHECK_BOT_NAME:-}" ] || die "COCHECK_BOT_NAME is not set"
[ -n "${COCHECK_BOT_EMAIL:-}" ] || die "COCHECK_BOT_EMAIL is not set"
if ! printf '%s\n%s\n' "$COCHECK_BOT_NAME" "$COCHECK_BOT_EMAIL" | node "$ROOT/scripts/public-gate.ts" --text-stdin >/dev/null; then
  die "the bot name or email is refused by the denylist (or the gate cannot run)"
fi

[ -z "$(git -C "$SRC" status --porcelain --untracked-files=all)" ] || die "the private tree is dirty"
[ -z "$(git -C "$PUB" status --porcelain --untracked-files=all)" ] || die "the public checkout is dirty"

DAY="$(date -u +%Y-%m-%d)"
BRANCH="sync/$DAY"
if git -C "$PUB" show-ref --verify --quiet "refs/heads/$BRANCH"; then die "branch $BRANCH already exists in the public checkout"; fi
HAS_COMMITS=0
if git -C "$PUB" rev-parse --verify --quiet HEAD >/dev/null; then
  HAS_COMMITS=1
  git -C "$PUB" show-ref --verify --quiet refs/heads/main || die "the public checkout has commits but no main branch"
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/cocheck-export.XXXXXX")"
mkdir "$WORK/archive"
git -C "$SRC" archive HEAD | tar -x -C "$WORK/archive"
if ! node "$ROOT/scripts/public-gate.ts" "$WORK/archive"; then
  die "the gate found leaks (or could not run); the public checkout is untouched"
fi

ORIG_HEAD_REF="$(git -C "$PUB" symbolic-ref -q HEAD || true)"
ORIG_SHA="$(git -C "$PUB" rev-parse --verify --quiet HEAD || true)"
MUTATED=0
rollback() {
  [ "$MUTATED" = 1 ] || return 0
  echo "export-public: failed after changing the public checkout; restoring it" >&2
  if [ -n "$ORIG_HEAD_REF" ]; then git -C "$PUB" symbolic-ref HEAD "$ORIG_HEAD_REF"; else git -C "$PUB" update-ref --no-deref HEAD "$ORIG_SHA"; fi
  if [ -n "$ORIG_SHA" ]; then git -C "$PUB" reset -q --hard "$ORIG_SHA"; else git -C "$PUB" rm -rfq --cached . 2>/dev/null || true; fi
  git -C "$PUB" clean -fdq
  git -C "$PUB" branch -D "$BRANCH" >/dev/null 2>&1 || true
}
trap 'rc=$?; [ $rc -eq 0 ] || rollback' EXIT

MUTATED=1
if [ "$HAS_COMMITS" = 1 ]; then
  git -C "$PUB" checkout -q -b "$BRANCH" main
  git -C "$PUB" rm -rfq --ignore-unmatch .
else
  git -C "$PUB" checkout -q --orphan "$BRANCH"
fi
cp -R "$WORK/archive/." "$PUB/"
(cd "$WORK/archive" && find . \( -type f -o -type l \) -print0) | git -C "$PUB" add -f --pathspec-from-file=- --pathspec-file-nul

STAMP="$(date -u +%Y-%m-%dT%H:%M:%S+0000)"
GIT_AUTHOR_NAME="$COCHECK_BOT_NAME" GIT_AUTHOR_EMAIL="$COCHECK_BOT_EMAIL" GIT_AUTHOR_DATE="$STAMP" \
GIT_COMMITTER_NAME="$COCHECK_BOT_NAME" GIT_COMMITTER_EMAIL="$COCHECK_BOT_EMAIL" GIT_COMMITTER_DATE="$STAMP" \
  git -C "$PUB" -c commit.gpgsign=false -c core.hooksPath=/dev/null commit -q --allow-empty --no-verify -m "Sync public export $DAY"

MUTATED=0
echo "export-public: committed on $BRANCH in $PUB"
echo "next, by hand:"
echo "  git -C \"$PUB\" push -u origin $BRANCH"
echo "  gh pr create --repo <org>/<repo> --base main --head $BRANCH --title \"Sync public export $DAY\" --body \"Automated export.\""
