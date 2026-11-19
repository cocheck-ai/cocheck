// The entry of the built-in Office connectors: `connectors/<id>/connector.mjs` imports this (built: dist/office/connector/main.js) and
// calls `runOfficeConnector` with its app key. Production wiring only: the real platform driver, the shipped pdfpages helper.
import { hostPlatform } from "../../platform/index.ts";
import { officeExportDriver } from "./export-driver.ts";
import { officeApp } from "./apps.ts";
import { macPromptWindows } from "./screen-macos.ts";
import { winPromptWindows } from "./screen-windows.ts";
import { defaultDeps, serve, type ProgramDeps } from "./program.ts";

/**
 * The production deps. Under the test bootstrap (COCHECK_TEST_NO_OFFICE=1, passed through the manifests' `permissions.env`) no driver is
 * made at all, so no `pgrep` and no Office call happens and results never depend on what is open on the machine running the tests.
 */
export function officeDeps(env: NodeJS.ProcessEnv = process.env, os: string | undefined = hostPlatform()?.name): ProgramDeps {
  if (env.COCHECK_TEST_NO_OFFICE === "1" && env.COCHECK_ALLOW_REAL_OFFICE !== "1") return { ...defaultDeps(undefined), noDriverWhy: "Office is not used under tests, so this is the change list." };
  // Where no driver is built (Windows, Linux) the deps hold none and no window helper, so the program answers the change list
  // alone and never needs a desktop session (headless-safe). The Mac's wiring is unchanged.
  const windows = macPromptWindows(os) ?? winPromptWindows(os);
  return { ...defaultDeps(officeExportDriver(os)), ...(windows !== undefined ? { windows } : {}) };
}

export async function runOfficeConnector(key: string): Promise<void> {
  await serve(officeApp(key), officeDeps());
}
