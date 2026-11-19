// The kit's file-backed toys name a file as a file URL under their own scheme (toy-level-1:///home/me/notes.json, toy-level-1:///C:/Users/me/notes.json).
// Outside authors copy these examples, so they must turn the subject into a path the way that works on Windows too: swap the scheme back to file: and
// call fileURLToPath. A URL's .pathname is not a path there (/C:/Users/..., still percent-encoded), and no kit file may show that pattern.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const KIT = fileURLToPath(new URL("../public-kit/", import.meta.url));
const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(path.join(dir, e.name)) : /\.(mjs|js|md)$/.test(e.name) ? [path.join(dir, e.name)] : []));

// toy-tracker and toy-vendor name an item, not a file (toy-vendor://note/<id>): the URL's path there is an id, and .pathname is the right read.
const ID_SUBJECTS = new Set(["examples/toy-tracker/connector.mjs", "examples/toy-vendor/connector.mjs"]);

test("no kit example, template or page reads a file subject's path from new URL(...).pathname", () => {
  const offenders = filesUnder(KIT)
    .map((f) => path.relative(KIT, f).split(path.sep).join("/"))
    .filter((f) => !ID_SUBJECTS.has(f) && /new URL\([^)]*\)\.pathname/.test(readFileSync(path.join(KIT, f), "utf8")));
  assert.deepEqual(offenders, []);
});

test("the file-backed toys turn their subject into a path with fileURLToPath, which gives a Windows path from a Windows file URL", () => {
  for (const toy of ["toy-helpers", "toy-level-1", "toy-level-3", "toy-export"]) {
    assert.match(readFileSync(path.join(KIT, "examples", toy, "connector.mjs"), "utf8"), /fileURLToPath\(\w+\.replace\(/, toy);
  }
  // The same conversion with Windows rules, on any OS: a folder with a space and a non-ASCII letter comes back as the path it was.
  const file = "C:\\Users\\me\\My notes été\\notes.json";
  const subject = pathToFileURL(file, { windows: true }).href.replace(/^file:/, "toy-level-1:");
  assert.equal(subject, "toy-level-1:///C:/Users/me/My%20notes%20%C3%A9t%C3%A9/notes.json");
  assert.equal(fileURLToPath(subject.replace(/^[a-z][a-z0-9+.-]*:/i, "file:"), { windows: true }), file);
  assert.notEqual(decodeURIComponent(new URL(subject).pathname), file); // the old way: /C:/Users/me/My notes été/notes.json
});
