// The spreadsheet tier's parse memo and label shapes: moved out of core's generic layer contract (src/formats/layer.ts),
// which does not know sheets or cells. Only the xlsx layer reads or fills them.
import type { FormatLayer, LayerDiffRow } from "../../../formats/layer.ts";

/** The text cells of one sheet by address, looked up by sheet name; built on first ask, so a sheet no row sits in is never scanned. What the review page reads row labels from. */
export type LabelCells = (sheet: string) => Map<string, unknown> | undefined;

/**
 * A small bounded memo of what a layer parsed, keyed by the sha of the stored version. The layer puts in whatever it
 * likes (a parsed file, or the error parsing it threw, so an unreadable version is not retried) and the caller never looks
 * inside. The caller says up front how many more reads each sha will get (`uses`) and calls `used` after each read: a version is
 * dropped the moment nothing later needs it, so along one file's chain only the version the next change starts from is held, plus
 * any version a later file's chain starts from. Never more than `max` entries (first in, first out past that, which only costs a
 * re-read), so memory is `max` parsed versions at the very most, whatever the number of versions.
 */
export class ParseMemo {
  readonly max: number;
  readonly #entries = new Map<string, { ok: true; value: unknown } | { ok: false; error: unknown }>();
  readonly #uses: Map<string, number>;

  constructor(max: number, uses: ReadonlyMap<string, number> = new Map()) {
    this.max = max;
    this.#uses = new Map(uses);
  }

  get(key: string): { ok: true; value: unknown } | { ok: false; error: unknown } | undefined {
    return this.#entries.get(key);
  }

  set(key: string, entry: { ok: true; value: unknown } | { ok: false; error: unknown }): void {
    // Nothing later needs it (or it was never counted): not worth holding.
    if (this.#uses.size > 0 && (this.#uses.get(key) ?? 0) <= 1) return;
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    while (this.#entries.size > this.max) this.#entries.delete(this.#entries.keys().next().value!);
  }

  /** One read of `key` is done; past the last expected read the entry goes. */
  used(key: string): void {
    const left = (this.#uses.get(key) ?? 0) - 1;
    this.#uses.set(key, left);
    if (left <= 0) this.#entries.delete(key);
  }

  get size(): number {
    return this.#entries.size;
  }
}

/** The sheets only one side of a spreadsheet has, by name; a created one has every sheet in `added`. */
export interface SheetsChanged {
  added: string[];
  removed: string[];
}

/** The xlsx layer: the generic contract plus its one-pass diff with labels. */
export interface XlsxFormatLayer extends FormatLayer {
  /**
   * `diff`, plus the text cells of the after side as that same pass parsed it, so a caller wanting row labels does not read
   * the after file a second time. `labels` is null when the after side was not parsed (rows empty, or unreadable).
   * `keep`: parsed versions are looked up in and added to `keep.memo` under the given shas (null: not memoised), so a
   * chain of states reads each version once. Optional; `diff` stays the one entry the hook drives, unchanged.
   */
  diffWithLabels(beforePath: string | null, afterPath: string | null, keep?: { memo: ParseMemo; beforeKey: string | null; afterKey: string | null }): Promise<{ rows: LayerDiffRow[]; labels: LabelCells | null; sheets?: SheetsChanged }>;
}
