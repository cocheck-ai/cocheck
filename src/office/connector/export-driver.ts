import { hostPlatform } from "../../platform/index.ts";
import type { OfficeExportDriver } from "./office-job.ts";
import { macOfficeDriver } from "./office-macos.ts";
import { winOfficeDriver, type WinHostOptions } from "./office-win.ts";

/**
 * Office connectors: the driver for the built-in Office connectors' PDF export, or undefined where none is built (Linux and every other OS). Moved here from
 * src/platform/index.ts. Each call makes a fresh driver, so a fresh PowerShell host per job on Windows (C6), as the Mac's driver is per call.
 * `win` is a test seam for the Windows host (a fake JSON-lines host); production passes none.
 */
export const officeExportDriver = (os: string | undefined = hostPlatform()?.name, win: WinHostOptions = {}): OfficeExportDriver | undefined => (os === "darwin" ? macOfficeDriver() : os === "win32" ? winOfficeDriver(win) : undefined);
