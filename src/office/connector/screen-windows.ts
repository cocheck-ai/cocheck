// The Windows half of the Office print route's window list: the same contract as the Mac's ScreenHelper (screen-macos.ts) for
// `windows(pid)` and `close()`, served by its own WinHost through the read-only `windows {pid}` op of office-win.ps1. The op only
// reads properties (UI Automation); nothing here focuses, presses, closes or moves a window. Windows-specific by name: platform-specific code lives in a module whose name says so.
import { hostPlatform } from "../../platform/index.ts";
import { WinHost, type WinHostOptions } from "./office-win.ts";
import type { ScreenWindow } from "./screen-macos.ts";

export type WindowsAnswer = { ok: true; windows: ScreenWindow[] } | { ok: false; why: string };

export class WinScreen {
  private readonly host: WinHost;
  private readonly timeoutMs: number;
  constructor(o: WinHostOptions = {}, timeoutMs = 5_000) {
    this.host = new WinHost(o);
    this.timeoutMs = timeoutMs;
  }
  async windows(pid: number): Promise<WindowsAnswer> {
    const r = await this.host.call("windows", { pid }, this.timeoutMs).catch((e: unknown) => ({ ok: false as const, why: e instanceof Error ? e.message : "the PowerShell host could not start" }));
    if (!r.ok) return { ok: false, why: r.why };
    return Array.isArray(r.windows) ? { ok: true, windows: r.windows as ScreenWindow[] } : { ok: false, why: "the PowerShell host gave no window list" };
  }
  close(): Promise<void> {
    return this.host.close();
  }
  closeSync(): void {
    this.host.closeSync();
  }
}

/** The print route's prompt watch on Windows: one WinHost used only for `windows {pid}`. Undefined off Windows. */
export function winPromptWindows(os: string | undefined = hostPlatform()?.name, o: WinHostOptions = {}): (() => Promise<{ helper: WinScreen; close(): Promise<void> } | null>) | undefined {
  if (os !== "win32") return undefined;
  return async () => {
    const helper = new WinScreen(o);
    return { helper, close: () => helper.close() };
  };
}
