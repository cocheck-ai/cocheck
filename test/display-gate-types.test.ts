import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { esc, detailsHtml, fileBase, userText, words, type Shown } from "../src/display.ts";
import type { HookRoundView } from "./helpers/legacy-review-model.ts";
import { checkNoticesHtml, hookRoundsHtml, noCellCallsHtml, roundNotesHtml } from "./helpers/legacy-review-page.ts";
import { opReason } from "../src/reason.ts";

// every render function takes the display module's branded type, so raw ledger text is a compile error.
// `npx tsc --noEmit` is the proof: an unused @ts-expect-error is itself an error, so each line below fails tsc the day
// a render function starts accepting a plain string again. The function is never called; the runtime checks follow it.
export function rawTextDoesNotCompile(raw: string, round: HookRoundView): void {
  // @ts-expect-error a plain string is not Shown
  esc(raw);
  // @ts-expect-error a plain string is not Shown
  esc("a literal is still a plain string");
  // @ts-expect-error notices are Shown, not strings
  checkNoticesHtml([raw]);
  // @ts-expect-error notes are Shown, not strings
  roundNotesHtml([raw]);
  // @ts-expect-error a reason is Shown; an outside call's reason cannot be a raw command
  hookRoundsHtml([{ ...round, outside: [{ name: raw, reason: raw, path: raw, command: raw }] }]);
  // @ts-expect-error a path-unknown call's reason cannot be a raw command
  hookRoundsHtml([{ ...round, unknown: [{ reason: raw, command: raw }] }]);
  // @ts-expect-error the worked-in line takes a name and a reason in Shown
  hookRoundsHtml([{ ...round, workedIn: [{ name: raw, reason: raw, path: raw }] }]);
  // @ts-expect-error a summary is Shown
  detailsHtml(raw, []);
  // @ts-expect-error a words template takes Shown or numbers, not strings
  words`reason: ${raw}`;
  const reason: string = opReason({ tool: "Bash", intent: "x" }, "").reason;
  // @ts-expect-error a string read back out of a Shown cannot be shown again
  const bad: Shown = reason;
  void bad;
  noCellCallsHtml([]); // raw ids are fine here: they only ever land in a details body
}

describe("the display module", () => {
  it("escapes visible text and puts raw text only in a closed details control", () => {
    assert.equal(esc(userText("a<b & \"c\"")), "a&lt;b &amp; &quot;c&quot;");
    const html = detailsHtml(words`show command`, ["python3 x.py && echo $HOME"], { pre: true });
    assert.match(html, /^<details class="raw"><summary[^>]*>show command<\/summary><pre class="small">python3 x\.py &amp;&amp; echo \$HOME<\/pre><\/details>$/);
  });

  it("a file base name never carries a folder, and a code fragment is not a name", () => {
    assert.equal(fileBase("/Users/x/My Files/casebook copy.xlsx"), "casebook copy.xlsx");
    assert.equal(fileBase(String.raw`C:\Users\x\casebook.xlsx`), "casebook.xlsx");
    assert.equal(fileBase("/tmp/inplace_hashes.json').write_text(json.dumps({name:hashlib.sha256(b)"), "a file");
  });
});
