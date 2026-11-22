#!/bin/sh
# The command Claude Code runs for every CoCheck hook event: `sh hook-launch.sh <hook.js> [hook args]`, payload on stdin.
# It finds Node when the hook fires, not when CoCheck was installed, so a Node upgrade (a new Homebrew Cellar path) cannot leave the
# hook pointing at a binary that is gone. When the hook cannot record (no Node, or the hook exits non-zero) it writes the reason to
# <COCHECK_HOME>/not-recording.txt, which `cocheck status` and `cocheck open` print; the next hook that does record deletes the file.
# Node is taken from, in order: COCHECK_NODE (the Homebrew wrapper's stable opt/node path, recorded in the hook command), PATH, then
# COCHECK_NODE_SEARCH (space separated), default Homebrew's stable opt/node paths and the plain Homebrew and nodejs.org locations.
# Last of all, the Node the installer resolved, recorded in <COCHECK_HOME>/installed-node.txt, so a Node from nvm, volta or fnm still runs
# under a host started with a minimal PATH. PATH and the locations above win; a recorded Node that is gone falls through to "not found".
# It adds no Node start on the success path. Exit status, stdout and stderr of the hook pass through unchanged.
hook="$1"
shift
home="${COCHECK_HOME:-}"
note="$home/not-recording.txt"

record() {
  [ -n "$home" ] || return 0
  mkdir -p "$home" 2>/dev/null || return 0
  { printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"; printf '%s\n' "$1"; } >"$note" 2>/dev/null || true
}

node=
if [ -n "${COCHECK_NODE:-}" ] && [ -x "$COCHECK_NODE" ]; then node=$COCHECK_NODE; fi
[ -n "$node" ] || node=$(command -v node 2>/dev/null)
if [ -z "$node" ] || [ ! -x "$node" ]; then
  node=
  for candidate in ${COCHECK_NODE_SEARCH:-/opt/homebrew/opt/node/bin/node /usr/local/opt/node/bin/node /opt/homebrew/bin/node /usr/local/bin/node}; do
    if [ -x "$candidate" ]; then node=$candidate; break; fi
  done
fi
if [ -z "$node" ] && [ -n "$home" ] && [ -r "$home/installed-node.txt" ]; then
  IFS= read -r candidate <"$home/installed-node.txt" 2>/dev/null
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then node=$candidate; fi
fi
if [ -z "$node" ]; then
  record "Node was not found. CoCheck needs Node 22.18 or newer (install it from nodejs.org), then restart your coding agent."
  echo "CoCheck: Node was not found, so this tool call was not recorded." >&2
  exit 1
fi

# The hook's stdout passes straight through (fd 3): it is empty except for the UserPromptSubmit context text. Its stderr is captured.
{ err=$("$node" "$hook" "$@" 2>&1 1>&3 3>&-); status=$?; } 3>&1
if [ "$status" -ne 0 ]; then
  version=$("$node" --version 2>/dev/null)
  tail=$(printf '%s' "$err" | tail -c 400)
  record "The hook exited $status under Node ${version:-unknown} (CoCheck needs 22.18 or newer): $tail"
  [ -n "$err" ] && printf '%s\n' "$err" >&2
  exit "$status"
fi
[ -n "$home" ] && [ -e "$note" ] && rm -f "$note"
[ -n "$err" ] && printf '%s\n' "$err" >&2
exit 0
