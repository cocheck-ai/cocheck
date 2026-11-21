#!/bin/sh
# Cuts a release locally: `scripts/release.sh X.Y.Z`. It publishes nothing: nothing is pushed, no npm publish, no gh and no brew command runs.
#
# The route is the npm package: the tag goes on HEAD (the commit the suite ran on, no release commit, no dist/ in git), `npm pack` makes the
# tarball, and the Homebrew formula installs that same tarball from the npm registry. So the script first needs a clean tree whose package.json
# already says X.Y.Z (bump and commit before releasing). Then: typecheck and the suite (skipped when HEAD has a pass record, see below), npm ci, build,
# the native-helper check, npm pack into $COCHECK_RELEASE_OUT (default: $TMPDIR/cocheck-release-vX.Y.Z), the package checks, one install of the tarball under a
# scratch HOME, and scripts/public-gate.ts over the unpacked tarball. Only then is the tag made and the formula written to $out/cocheck.rb.
# It prints the commands for you to run yourself: the tag push, `npm publish <that exact tarball>` (so the formula's sha256 matches the published
# file), and the formula copy into a tap checkout.
#
# Before anything else runs (only `npm ci`, which the gate needs for its zip reader), the whole history reachable from HEAD goes through the gate
# (`public-gate.ts --git-history`); a hit refuses the release, and a gate that cannot run stops it with its own message.
#
# The suite record: a full, clean, green `npm test` writes `<git dir>/cocheck-test-pass/<HEAD sha>` (scripts/lib/test-pass-record.ts). A HEAD with a record
# skips the suite here ("release: suite already passed on <sha>"); typecheck always runs. COCHECK_RELEASE_CHECKS replaces the checks entirely
# (default: "npm run typecheck", then the suite unless it has a record). COCHECK_RELEASE_REMOTE names the git remote printed in the tag-push command (default: `public` when that remote exists, else `origin`).
set -eu

# The gate reads its allow file from this variable when it is set (the gate tests use that). A release must judge the tarball by the committed allow
# file alone, so a value left in the caller's environment is dropped here.
unset COCHECK_GATE_ALLOW

version="${1:-}"
case "$version" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "usage: scripts/release.sh X.Y.Z" >&2; exit 2 ;;
esac
case "$version" in *[!0-9.]*) echo "version must be plain X.Y.Z, got $version" >&2; exit 2 ;; esac
tag="v$version"
remote="${COCHECK_RELEASE_REMOTE:-}"

cd "$(dirname "$0")/.."
root=$(pwd)
[ -z "$(git status --porcelain)" ] || { echo "release: the working tree is not clean; commit or remove your changes first" >&2; exit 1; }
current=$(node -p "require('./package.json').version")
[ "$current" = "$version" ] || { echo "release: package.json says $current, not $version; bump the version and commit it first" >&2; exit 1; }
if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then echo "release: tag $tag already exists" >&2; exit 1; fi
if [ -z "$remote" ]; then
  # A maintainer checkout names the public repository `public`; a fresh clone of the public repository has only `origin`.
  if git remote get-url public >/dev/null 2>&1; then remote=public; else remote=origin; fi
fi
head=$(git rev-parse HEAD)
gitdir=$(git rev-parse --absolute-git-dir)

fail() { echo "release: $*" >&2; exit 1; }

# On macOS a release must carry both native helpers, each as a universal binary. `npm run build` only warns when a helper or one architecture fails
# (build-helpers.mjs, by design for local builds), so a release would otherwise ship without it and Mac users lose PDF or Office pictures with no error.
# It exits non-zero and the release stops. Off macOS the helpers are not built, so nothing is checked.
check_helpers() {
  [ "$(uname -s)" = Darwin ] || return 0
  problems=""
  # pdfpages in dist/helpers (the Mac's page drawer: it only draws; text comes from pdf.js, which `npm run build` refuses to ship without);
  # cocheck-screen is Office connector code, built where src/office/connector/screen-macos.ts looks.
  for file in dist/helpers/pdfpages dist/office/connector/helpers/cocheck-screen; do
    helper=$(basename "$file")
    if [ ! -f "$file" ]; then problems="$problems $helper (missing),"; continue; fi
    if [ ! -x "$file" ]; then problems="$problems $helper (not executable),"; continue; fi
    archs=$(lipo -archs "$file" 2>/dev/null || true)
    for arch in arm64 x86_64; do
      case " $archs " in *" $arch "*) ;; *) problems="$problems $helper (no $arch),"; esac
    done
  done
  [ -z "$problems" ] || { echo "release: native helpers incomplete in dist:${problems%,}; fix the build and release again" >&2; exit 1; }
}

check_unchanged() {
  [ -z "$(git status --porcelain)" ] || fail "the working tree changed during the release (the build or the checks dirtied it); nothing was tagged"
  [ "$(git rev-parse HEAD)" = "$head" ] || fail "HEAD moved during the release; nothing was tagged"
}

# The gate's file scan reads zip files with fflate, and node resolves that import as the gate loads, even for --git-history. Without the
# dependencies installed a fresh clone would fail here (reported as a gate that could not run), so npm ci comes first.
npm ci

# The first real check, before the build and the suite: a tag push publishes every commit reachable from HEAD, and that cannot be undone. The private
# repository's history names its owner and its internal work, so the gate's denylist judges every commit's author, committer and message here.
[ -f "$root/scripts/public-gate.ts" ] || fail "scripts/public-gate.ts is missing; the release cannot be checked for public safety"
# Exit 1 with hit lines is a verdict on the commits. Anything else is the gate failing to run: its own exit 2, or node's exit 1 on an uncaught
# error (a missing import), which prints no hit line. Only the first is reported as refused commits.
history_rc=0
history=$(node "$root/scripts/public-gate.ts" --git-history "$root") || history_rc=$?
if [ "$history_rc" -ne 0 ]; then
  hit_re='^[0-9a-f]{8} (author-name|author-email|committer-name|committer-email|message): '
  if [ "$history_rc" -eq 1 ] && printf '%s\n' "$history" | grep -E "$hit_re" >/dev/null; then
    printf '%s\n' "$history" | head -n 10 >&2
    fail "the history holds commits the public gate refuses (first hits above: <sha> <field>: <rule id>); run the release from the public checkout, not the private repo. Nothing was tagged."
  fi
  [ -z "$history" ] || printf '%s\n' "$history" | head -n 10 >&2
  fail "the public gate could not run on the history (exit $history_rc; its error is above); this is not a verdict on the commits. Fix the gate and release again. Nothing was tagged."
fi

npm run build
if [ -n "${COCHECK_RELEASE_CHECKS:-}" ]; then
  sh -c "$COCHECK_RELEASE_CHECKS"
else
  npm run typecheck
  if [ -f "$gitdir/cocheck-test-pass/$head" ]; then
    echo "release: suite already passed on $head"
  else
    npm test
  fi
fi
check_helpers
test -f dist/hook.js && test -f dist/cli-main.js && test -f dist/build-info.json
check_unchanged

out="${COCHECK_RELEASE_OUT:-${TMPDIR:-/tmp}/cocheck-release-$tag}"
mkdir -p "$out"
# --ignore-scripts skips prepack: the build above is the one under test, and a second build would only change what is packed.
npm pack --ignore-scripts --silent --pack-destination "$out" >/dev/null
tarball="$out/cocheck-$version.tgz"
[ -f "$tarball" ] || fail "npm pack did not make $tarball"
sha=$(shasum -a 256 "$tarball" | cut -d" " -f1)
[ -n "$sha" ] || fail "could not hash $tarball"

# Package checks. The tarball is unpacked into a fresh folder under $out; every path below is inside it.
unpacked=$(mktemp -d "$out/unpacked.XXXXXX")
tar -xzf "$tarball" -C "$unpacked"
pkg="$unpacked/package"
listing=$(tar -tzf "$tarball")
for entry in bin/cocheck.mjs dist/hook.js dist/cli-main.js dist/build-info.json scripts/hook-launch.sh; do
  echo "$listing" | grep -qx "package/$entry" || fail "the tarball lacks $entry"
done
[ -x "$pkg/scripts/hook-launch.sh" ] || fail "scripts/hook-launch.sh in the tarball is not executable"
if [ "$(uname -s)" = Darwin ]; then
  for file in dist/helpers/pdfpages dist/office/connector/helpers/cocheck-screen; do
    [ -x "$pkg/$file" ] || fail "$file in the tarball is missing or not executable"
  done
fi
for dir in src test platforms; do
  if echo "$listing" | grep -q "^package/$dir/"; then fail "the tarball holds $dir/ entries (it must ship none)"; fi
done
# One install of the tarball into a scratch prefix under a scratch HOME (never global, never the real ~/.claude or ~/CoCheckData).
scratch=$(mktemp -d "$out/install.XXXXXX")
mkdir -p "$scratch/home" "$scratch/prefix"
HOME="$scratch/home" USERPROFILE="$scratch/home" npm install --prefix "$scratch/prefix" --no-audit --no-fund "$tarball" >/dev/null \
  || fail "installing the tarball into a scratch prefix failed"
installed=$(HOME="$scratch/home" "$scratch/prefix/node_modules/.bin/cocheck" --version) || fail "the installed cocheck failed to run --version"
case "$installed" in *"$version"*) ;; *) fail "the installed cocheck prints '$installed', not $version" ;; esac

# The public gate runs over the unpacked package; a missing script is a failure, never a skip.
[ -f "$root/scripts/public-gate.ts" ] || fail "scripts/public-gate.ts is missing; the release cannot be checked for public safety"
node "$root/scripts/public-gate.ts" "$pkg" || fail "public-gate failed (exit 1 or an error); fix the hits above and release again"
check_unchanged

git tag "$tag" "$head"
sed -e "s|^\(  url \).*|\1\"https://registry.npmjs.org/cocheck/-/cocheck-$version.tgz\"|" \
    -e "s|^  sha256 .*|  sha256 \"$sha\"|" \
    "$root/packaging/homebrew/cocheck.rb" >"$out/cocheck.rb"

cat <<DONE

Release $tag is cut locally on $head. Nothing was pushed or published.
  tag:      $tag (on $head)
  tarball:  $tarball
  formula:  $out/cocheck.rb

Run these yourself, in this order (docs/release.md has the one-time setup first):
  git -C "$root" push $remote $tag
  npm publish $tarball
  tap=~/code/cocheck-ai/homebrew-tap   # the existing checkout; its remote uses the github-cocheck SSH alias
  git -C "\$tap" switch main && git -C "\$tap" pull --ff-only && git -C "\$tap" switch -c cocheck-$version
  mkdir -p "\$tap/Formula" && cp "$out/cocheck.rb" "\$tap/Formula/cocheck.rb"
  git -C "\$tap" add Formula/cocheck.rb && TZ=UTC git -C "\$tap" commit -m "cocheck $version"
  git -C "\$tap" push -u origin cocheck-$version
  GH_TOKEN=\$(gh auth token --user cocheckai) gh pr create --repo cocheck-ai/homebrew-tap --head cocheck-$version --base main --title "cocheck $version" --body "Formula for cocheck $version."
  GH_TOKEN=\$(gh auth token --user cocheckai) gh release create $tag --repo cocheck-ai/cocheck --verify-tag --prerelease --title "CoCheck $version Preview" --notes-file <this version's release notes>
DONE
