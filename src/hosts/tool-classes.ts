// What each tool a host reports is, to CoCheck: a class, not a name. Every host declares its own table (`HostProfile.toolClasses`), so one
// host's `edit` and another's `Edit` never share a meaning. The core asks the registry (`toolEntryOf`, src/hosts/index.ts) and reads the class.

/** What a tool does, in the terms the credit rules and the timeline read. */
export type ToolClass =
  /** Writes a whole file from content (Claude Write, Copilot create). */
  | "write"
  /** Changes a file by replacing text in it (Claude Edit, MultiEdit, Copilot edit). */
  | "edit"
  /** Changes a notebook's cells (Claude NotebookEdit). */
  | "notebook-edit"
  /** Carries a patch whose headers name the files it changes (apply_patch). */
  | "patch"
  /** Runs a shell command. */
  | "shell"
  /** Starts a helper agent: its own calls carry the helper's work. */
  | "launcher"
  /** Waits on helpers and writes nothing. */
  | "wait"
  /** Reads a file by path (Claude Read). */
  | "read"
  /** Looks at files or the folder and writes nothing (glob, grep, view). */
  | "read-only"
  /** Never writes a file in the folder: the host's bookkeeping, web and messaging tools. */
  | "never-credited";

export interface ToolEntry {
  class: ToolClass;
  /** shell: how the command is read. Absent: a POSIX-style shell with no further claim. */
  dialect?: "bash" | "powershell";
  /** wait: the input flag that makes the call a wait (`wait: true`); absent: the call always waits. */
  waitFlag?: string;
  /** The host's own name for the tool varies in letter case, so the name is matched in any case (only where a rule matched that way before). */
  anyCase?: true;
  /** write, edit, notebook-edit: the input fields that name the file, in order. */
  pathFields?: readonly string[];
  /** write, edit: a call whose input names an absolute file may be credited only with that file. */
  pathChecked?: true;
  /** The call's input has the file-tool shape the timeline's signals read: `file_path` plus `content`, `old_string` or `new_string`. */
  fileInput?: true;
  /** launcher: the call runs its helper in the background when its input says `run_in_background: true`, and the host keeps the helper's own transcript file. */
  backgroundFlag?: true;
  /** A call that wakes a helper agent that already ran (a message to it): the timeline draws the resumed work as a line forked from this call. Its class says nothing about files. */
  resumesHelper?: true;
  /** shell: its command can leave a process running past the call's result, so the credit rules read the command for detach forms. */
  backgroundable?: true;
}

/** A host's tools by the name it reports (after `HostProfile.toolName`). */
export type ToolTable = Readonly<Record<string, ToolEntry>>;

/** One class and the same extras for several names. */
export function toolGroup(cls: ToolClass, names: readonly string[], extra: Omit<ToolEntry, "class"> = {}): ToolTable {
  return Object.fromEntries(names.map((n) => [n, { class: cls, ...extra }]));
}
