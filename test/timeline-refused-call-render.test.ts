import { test } from "node:test";
import assert from "node:assert/strict";
import { readRecord } from "../src/timeline/runs.ts";
import { lineOf } from "../src/timeline/describe.ts";
import { call } from "./fixtures/timeline.ts";

// A call the host refused ran nothing. Its line says so, with or without the agent's words, and never reads as done work.
const SCRIPT = "Rename-Item t05\\a.txt b.txt; Remove-Item t05\\delete-me.txt";
const one = (o: Record<string, unknown>) => readRecord([call("x", { at: 1, cmd: SCRIPT, by: "refused", ...o } as never)], []).calls.get("x")!;

test("a refused shell call reads as refused, nothing ran, not as its command", () => {
  const l = lineOf(one({}));
  assert.match(l.text, /host refused this call; nothing ran/i);
  assert.doesNotMatch(l.text, /rename|remov|ran a command/i);
});

test("a refused call with the agent's own words and a description still reads as refused", () => {
  const l = lineOf(one({ desc: "Rename and delete the files", said: "I will rename and delete the files now." }));
  assert.match(l.text, /host refused this call; nothing ran/i);
});
