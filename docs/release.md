# Releasing CoCheck

A release is an npm package. `npm publish` puts the tarball on the npm registry (`npm install -g cocheck`), the tag `vX.Y.Z` marks the commit it was built from in the public repository `github.com/cocheck-ai/cocheck`, and a Homebrew formula in the tap `cocheck-ai/homebrew-tap` installs that same tarball from the registry (`brew install cocheck-ai/tap/cocheck`).

`scripts/release.sh` does the local part and publishes nothing: no push, no `npm publish`, no `brew`. These steps are the ones only a maintainer runs. Releases are cut from the public checkout, never the private repo: `release.sh` refuses when any commit reachable from HEAD fails the gate's denylist.

## One time

1. Create the public repository `cocheck-ai/cocheck` on GitHub and add it as a remote of the maintainer's checkout. The script prints `git push public vX.Y.Z` when a remote named `public` exists, else `git push origin vX.Y.Z` (a fresh clone of the public repository); set `COCHECK_RELEASE_REMOTE` to use another remote name.
2. Create the repository `cocheck-ai/homebrew-tap` on GitHub.
3. Log in to npm with an account that may publish `cocheck`.

## Each release

1. Bump `version` in `package.json` (and `package-lock.json`) to X.Y.Z and commit it. The release is cut from that commit.
2. Run the full suite once on that commit: `npm test`. A full run (no tier, no file filter) that ends with nothing failed, on a clean tree, writes a record for HEAD to `<git dir>/cocheck-test-pass/<sha>`. A dirty tree, `--tier=...`, a file filter or any failure writes none.
3. Run `scripts/release.sh X.Y.Z`. It refuses a dirty tree, and refuses unless `package.json` already says X.Y.Z. Then it:
   - runs `npm ci` (the gate needs its dependencies), then judges every commit reachable from HEAD with `public-gate.ts --git-history` and refuses on any hit;
   - runs the build, then `npm run typecheck`, which always runs. The suite is skipped with `release: suite already passed on <sha>` when HEAD has a record, and run (`npm test`, about 30 minutes) when it has none. `COCHECK_RELEASE_CHECKS` replaces the checks entirely;
   - on macOS, checks that both native helpers are universal binaries;
   - packs `cocheck-X.Y.Z.tgz` with `npm pack` into `$COCHECK_RELEASE_OUT` (default `$TMPDIR/cocheck-release-vX.Y.Z`);
   - checks the tarball: it holds `bin/cocheck.mjs`, `dist/hook.js`, `dist/cli-main.js`, `dist/build-info.json` and `scripts/hook-launch.sh` (executable), both Mac helpers executable on macOS, and no `src/`, `test/` or `platforms/` entry;
   - installs the tarball once with `npm install --prefix <scratch dir> <tarball>` under a scratch `HOME` (never global, never `~/.claude` or `~/CoCheckData`, and it needs the network for the two dependencies) and checks that `cocheck --version` prints X.Y.Z;
   - runs `node scripts/public-gate.ts <unpacked tarball dir>`. Exit 1 fails the release and the hit lines (`<relpath>:<line>: <rule id>`) are shown. A missing script fails the release too;
   - tags HEAD `vX.Y.Z` (no release commit, no `dist/` in git) and writes the formula to `$out/cocheck.rb`.
4. It prints three commands. Run them in this order:
   - push the tag: `git -C <checkout> push public vX.Y.Z` (or `origin`, see above)
   - publish that exact file: `npm publish <$out>/cocheck-X.Y.Z.tgz`. The formula's `sha256` is the hash of this file, so do not repack. A different file breaks every `brew install`.
   - update the tap through a pull request: in the existing checkout `~/code/cocheck-ai/homebrew-tap` (its remote uses the `github-cocheck` SSH alias), create a branch, copy `$out/cocheck.rb` to `Formula/cocheck.rb`, commit with `TZ=UTC`, push the branch, and open a PR with `GH_TOKEN=$(gh auth token --user cocheckai) gh pr create --repo cocheck-ai/homebrew-tap`. Merge it once the tap's checks pass; do not push to `main`.
5. Create the GitHub release for the pushed tag, with the public account's token (never the maintainer's own account), and the release notes section for this version saved to a file:

   ```
   GH_TOKEN=$(gh auth token --user cocheckai) gh release create vX.Y.Z --repo cocheck-ai/cocheck --verify-tag --prerelease --title "CoCheck X.Y.Z Preview" --notes-file <notes file>
   ```

   `--verify-tag` refuses when the tag was not pushed, so it never creates a tag of its own. Drop `--prerelease` and "Preview" once a release is no longer a preview.
6. Check as a user would, on a machine with a clean PATH: `brew install cocheck-ai/tap/cocheck`, then `cocheck --version`.

If a release is wrong before anything is published, delete the tag with `git tag -d vX.Y.Z`. After `npm publish`, cut a new version instead: npm never accepts the same version twice.

## What the formula does

`packaging/homebrew/cocheck.rb` is the template. `release.sh` rewrites only its `url` (the registry tarball for X.Y.Z) and `sha256` lines. The formula depends on Homebrew's `node`, installs the tarball's `bin/`, `dist/`, `public-kit/`, `scripts/hook-launch.sh` and `package.json` into `libexec`, and runs `npm install --omit=dev` there for the production dependencies (the tarball carries no lockfile, so versions resolve from the ranges in `package.json`). It puts `cocheck` on PATH through a small wrapper that runs Homebrew's stable `opt/node`. The wrapper also exports `COCHECK_NODE` and `COCHECK_ROOT`; `cocheck install` records both in the hook command, so the hook keeps running after a `brew upgrade` of Node or CoCheck.
