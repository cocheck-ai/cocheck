// The OS seam: everything the core needs from the operating system, behind one interface. The core never names an OS,
// an OS path or an OS tool; it asks `platform()`. One implementation per OS: `darwin` and `win32` are built; any other OS (Linux included)
// throws `PlatformNotBuiltError`, so a run on an OS without an implementation fails loudly instead of using Mac paths.

/** The values a hook command is built from, and what parsing one gives back. */
export interface HookCommandSpec {
  /** The CoCheck data folder (`COCHECK_HOME`). */
  dataHome: string;
  /** The launcher script the host runs. */
  launcher: string;
  /** The built hook entry the launcher starts. */
  hookPath: string;
  /** The host flag (`--host <flag>`). */
  host: string;
  /** A pinned Node path (`COCHECK_NODE`), when the install carries one. */
  node?: string;
}

export type ParsedHookCommand = HookCommandSpec;

export type PdfPageSize = { index: number; width: number; height: number };
/** Reading PDFs, for an OS that has no macOS-style Swift helper (Windows). Absent where the Swift helper in src/timeline/render is used directly (macOS). */
export interface DocRender {
  pdf: {
    /** Whether the OS can draw PDFs at all. */
    available(): boolean;
    /** Whether `pages` gives text runs (no OS drawer does: text comes from the pdf.js reader on every OS, public-kit/helpers/pdf-text.mjs). */
    textRuns: boolean;
    /** Kept for the published backend shape (pdf.mjs): text comes from the pdf.js reader on every OS. Its pages must agree with `pages` (count and sizes), or the view stays pictures only. */
    pdfjs: boolean;
    /** Names the OS reader in a sentence ("Windows PDF"). */
    engine: string;
    /** Page count and sizes (pixels at two per point) of `file`, a temp copy. */
    pages(file: string, timeoutMs: number): Promise<{ pages: PdfPageSize[] } | "timeout" | "failed">;
    /** Page `n` (1-based) of `file` as a PNG at the size `pages` gave, written to `out`. */
    png(file: string, n: number, out: string, timeoutMs: number): Promise<"ok" | "timeout" | "failed">;
  };
}

export interface Platform {
  /** The `process.platform` value this implementation serves. */
  readonly name: NodeJS.Platform;
  readonly paths: {
    /** The account's home folder, never read from `HOME`. */
    userHome(): string;
    /** The folder for short-lived files. */
    tmpDir(): string;
    isAbs(p: string): boolean;
    /** The path with `/` separators. */
    toPosix(p: string): string;
    /** Whether two names that differ only in case are different files. */
    caseSensitive: boolean;
    /** Whether the core folds case when it tests whether a path is inside a folder. Windows does; a Mac volume may be case-sensitive, so the Mac compares exactly. */
    foldsCase: boolean;
  };
  /** Opens a URL in the person's browser. Throws when the opener fails. */
  openUrl(url: string): void;
  /** Opens a file in its app, or in `app` when named. Resolves false when the opener fails. */
  openFile(file: string, app?: string): Promise<boolean>;
  readonly process: {
    alive(pid: number): boolean;
    terminate(pid: number): void;
    /**
     * The command line of `pid`, or undefined when it cannot be read (no such pid, tool failed). `withEnvironment` asks for the process environment
     * joined to the line where the OS can give it (darwin `ps -E`); win32 never reads another process's environment and ignores it.
     */
    commandLine(pid: number, options?: { withEnvironment?: boolean }): string | undefined;
    /** How a review process's home is told apart from another's: by its environment (`COCHECK_HOME`, darwin) or by an argument its command line carries (win32). */
    readonly homeIdentity: "environment" | "argument";
    /** Starts a process that outlives the caller, with no stdio attached. */
    spawnDetached(command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }): number | undefined;
  };
  /** The OS store for the key that seals the data. `service` and `account` name one item; get gives null when none exists. */
  readonly secretStore: {
    get(service: string, account: string): Buffer | null;
    create(service: string, account: string, key: Buffer): void;
    /**
     * Stores or replaces a connector credential. Only a `CONNECTOR_SERVICE_PREFIX` service is accepted; any other throws `SecretStoreError`
     * before the OS is touched, so CoCheck's own sealing key can never be overwritten here. The value never goes in argv.
     */
    set(service: string, account: string, value: Buffer): void;
    /** Removes a connector credential; false when none existed. Same prefix rule as `set`. */
    delete(service: string, account: string): boolean;
    /** Where the key lives, as a phrase for output ("the ... item in your login Keychain"); one item per data folder. */
    location(service: string): string;
  };
  /** Builds and parses the command stored in a host's config. A byte change here is a hook migration (Codex re-trust). */
  readonly hookCommand: {
    build(spec: HookCommandSpec): string;
    /** The spec a command CoCheck wrote carries, or undefined for any other command. */
    parse(command: string): ParsedHookCommand | undefined;
    /** Whether the command is one CoCheck marked (it may carry a suffix `parse` does not accept). */
    isMarked(command: string): boolean;
  };
  readonly fsSecurity: {
    fileMode: number;
    dirMode: number;
    /** Owner-only access on `dir` and everything under it (`recursive`), best effort. Symlinks are left alone. Gives the failure text when it could not finish, else undefined; never throws. */
    ownerOnly(dir: string, recursive: boolean): string | undefined;
  };
  /** What the machine can do with Office documents. */
  readonly office: {
    liveExcel: boolean;
    render: boolean;
    thumbnails: boolean;
  };
  /** PDF drawing through the OS's own tools (Windows). Absent on macOS, where pdf-helper.ts draws with pdfpages. Text comes from pdf.js on every OS. */
  readonly docRender?: DocRender;
  /** How the core reads shell commands on this OS. Posix on macOS, cmd on Windows. */
  readonly shellDialect: {
    /** `cmd` is Windows: the core reads a command of any kind but `posix` as unknown. */
    kind: "posix" | "cmd";
    /** The shell that runs a launcher script. */
    shell: string;
  };
}

/** Raised by any OS's secret store; the caller words it for the person (seal.ts maps it to KeyMissingError). */
export class SecretStoreError extends Error {}

/** Raised on an OS CoCheck has no implementation for. */
export class PlatformNotBuiltError extends Error {
  readonly platformName: string;
  readonly member: string;
  constructor(platformName: string, member: string) {
    super(platformName === "linux" ? "Linux is not supported: CoCheck runs on macOS and Windows" : `CoCheck has no ${platformName} support yet (platform.${member} is not built)`);
    this.name = "PlatformNotBuiltError";
    this.platformName = platformName;
    this.member = member;
  }
}

/** Every connector credential lives under this service prefix ("cocheck-connector:<connector id>"); `set` and `delete` refuse any other service. */
export const CONNECTOR_SERVICE_PREFIX = "cocheck-connector:";
export const isConnectorService = (service: string): boolean => service.startsWith(CONNECTOR_SERVICE_PREFIX) && service.length > CONNECTOR_SERVICE_PREFIX.length;
