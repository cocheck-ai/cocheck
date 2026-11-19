// Removes CoCheck's attribution recorder from an env, so test processes never record into a real write log or pay for the
// hooks. Both hooks are inert without COCHECK_WRITE_LOG and COCHECK_TAG_SESSION; the guard loader in NODE_OPTIONS and the hooks folder in
// PYTHONPATH are dropped too, leaving any other option or path in place.
import path from "node:path";

const NODE_REQUIRE = /(?:^|\s)(?:--require|-r)(?:=|\s+)(?:"[^"]*cocheck-(?:preload|guard)[^"]*\.cjs"|'[^']*cocheck-(?:preload|guard)[^']*\.cjs'|\S*cocheck-(?:preload|guard)\S*\.cjs)/g;
const HOOKS_DIR = /[\\/]attribution[\\/]hooks[\\/]?$/;

export function scrubRecorderEnv(env: NodeJS.ProcessEnv): void {
  delete env.COCHECK_WRITE_LOG;
  delete env.COCHECK_TAG_SESSION;
  if (env.NODE_OPTIONS) {
    const rest = env.NODE_OPTIONS.replace(NODE_REQUIRE, "").trim();
    if (rest) env.NODE_OPTIONS = rest;
    else delete env.NODE_OPTIONS;
  }
  if (env.PYTHONPATH) {
    const rest = env.PYTHONPATH.split(path.delimiter).filter((p) => p !== "" && !HOOKS_DIR.test(p));
    if (rest.length > 0) env.PYTHONPATH = rest.join(path.delimiter);
    else delete env.PYTHONPATH;
  }
}
