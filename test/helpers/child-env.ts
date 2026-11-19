/**
 * The variables a test child process needs when its env is built by hand (a clean env, a temp HOME) instead of spread from
 * `process.env`. They carry the bootstrap's stand-in for `security` and the no-Office marker, so the child can never reach the
 * real Keychain or Office. Spread this into every such `env`.
 */
export function guardEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ["COCHECK_SECURITY_BIN", "COCHECK_TEST_NO_OFFICE", "NODE_TEST_CONTEXT"]) {
    const v = process.env[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}
