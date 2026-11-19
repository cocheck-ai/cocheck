/**
 * Chrome flags every test or probe launch must pass. `--use-mock-keychain` and `--password-store=basic` keep Chrome off the real
 * macOS Keychain, so no "Keychain Not Found" dialog appears when HOME points at a temp folder. Spread into the args of
 * every Chrome or Chromium spawn; `test/chrome-launch-flags.test.ts` fails on a launch without them.
 */
export const CHROME_KEYCHAIN_FLAGS = ["--use-mock-keychain", "--password-store=basic"] as const;

/** The usual headless launch args for a DevTools-driven page test. */
export function chromeHeadlessArgs(profileDir: string, url = "about:blank"): string[] {
  return ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profileDir}`, "--no-first-run", "--disable-gpu", ...CHROME_KEYCHAIN_FLAGS, url];
}
