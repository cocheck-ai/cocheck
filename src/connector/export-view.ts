// Export mode. A connector with entry "export" answers `export({subject})` with { text }; CoCheck keeps the text of each side and draws the difference
// itself with its built-in text renderer, so the picture is CoCheck's (source by "cocheck", name the connector id) and the connector never sees a diff.
// The document is the same cocheck.changes/1 shape every other row reaches the page as.
import type { ChangeInfo } from "../timeline/render/types.ts";
import { createRegistry } from "./registry.ts";
import { viewToV1, type V1Doc } from "../timeline/render/view-v1.ts";

/** The document for one export row: `before` or `after` is null when that side did not exist. */
export function exportDocOf(connector: string, subject: string, before: string | null, after: string | null): V1Doc {
  const kind = before === null ? "created" : after === null ? "deleted" : "modified";
  // The text renderer is found through the registry (a text-tier file), not imported: format knowledge stays in the registries.
  const renderer = createRegistry().rendererFor("export.txt", { tier: "text" } as ChangeInfo["generic"]);
  const view = renderer.view(before === null ? null : Buffer.from(before, "utf8"), after === null ? null : Buffer.from(after, "utf8"), { id: "export", file: subject.split(/[\\/]/).pop() || subject, kind });
  if (view instanceof Promise) throw new Error("the text renderer is synchronous");
  const doc = viewToV1(view, { cards: [], rowNotes: [] });
  return { ...doc, source: { by: "cocheck", name: connector, level: doc.source?.level ?? 3 } };
}
