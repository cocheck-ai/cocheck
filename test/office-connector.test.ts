// The three built-in Office connectors (microsoft-excel, microsoft-word, microsoft-powerpoint): the shared program over a fake driver.
// No test here launches, scripts or signals an Office app: every Office call goes to test/helpers/office-fake.ts, which records it.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { checkChanges } from "../src/connector/changes-v1.ts";
import { runConnectorTest } from "../src/connector-test-cli.ts";
import { OFFICE_APPS, type OfficeApp } from "../src/office/connector/apps.ts";
import { OwnerLock } from "../src/office/connector/shared/lock.ts";
import { answerDiff, ConnectorError, levelFor, PENDING_RETRY, type OfficeDoc, type ProgramDeps } from "../src/office/connector/program.ts";
import { helperPager, pdfPictures } from "../src/office/connector/pictures.ts";
import { pdfHelperForTest } from "../scripts/lib/pdf-helper-cache.ts";
import { fakeCropper, fakeDriver, fakePageReader, fakePager, FIXTURES, statePairs, tinyPng, type FakeOptions } from "./helpers/office-fake.ts";
import { tempDirRemovedAtExit } from "./helpers/temp-dirs.ts";

const ROOT = path.join(import.meta.dirname, "..");
const apps = Object.values(OFFICE_APPS);

function setup(o: FakeOptions = {}) {
  const f = fakeDriver(o);
  const lockPath = path.join(tempDirRemovedAtExit("office-lock-"), "lock");
  const deps: ProgramDeps = { driver: f.driver, pager: fakePager, crop: fakeCropper, pages: fakePageReader, lockPath, pollMs: 5, goneWaitMs: 100, lockWaitMs: 200 };
  return { ...f, deps, lockPath };
}
const fx = (app: OfficeApp, v: 1 | 2): string => path.join(FIXTURES, `v${v}${app.exts[0]}`);
function empty(): string {
  const f = path.join(mkdtempSync(path.join(tmpdir(), "office-empty-")), "gone.json");
  writeFileSync(f, "");
  return f;
}
function truncated(app: OfficeApp): string {
  const f = path.join(mkdtempSync(path.join(tmpdir(), "office-bad-")), `bad${app.exts[0]}`);
  const b = readFileSync(fx(app, 2));
  writeFileSync(f, b.subarray(0, Math.floor(b.length / 2)));
  return f;
}
/** Valid at the level the app declares in hello (Excel 3, Word and PowerPoint 2); no app: level 2. */
const valid = (doc: OfficeDoc, app?: OfficeApp): void => { const level = app === undefined ? 2 : levelFor(app); assert.deepEqual(checkChanges(doc, level), [], JSON.stringify(checkChanges(doc, level))); };
const methods = (calls: Array<{ method: string }>): string[] => calls.map((c) => c.method);
/** The export call each app makes: Excel prints sheet by sheet (its region pictures), Word and PowerPoint export the whole file. */
const exportOf = (app: OfficeApp): string => (app.key === "excel" ? "exportTargets" : "exportPdf");

for (const app of apps) {
  describe(`${app.id}: the shared program over the fake driver`, () => {
    it("edit: the reader's change list plus both sides' pages, flagged changed, valid at the app's declared level; Office quit after", async () => {
      const s = setup();
      const doc = await answerDiff(app, fx(app, 1), fx(app, 2), s.deps);
      valid(doc, app);
      assert.ok(doc.changes.some((c) => c.mark === "changed" && typeof c.before === "string" && typeof c.after === "string" && c.before !== c.after), JSON.stringify(doc.changes));
      if (app.key === "excel") {
        // one picture per change area and side, paired by group, at the same scale
        const pics = (doc.pictures ?? []) as unknown as Array<{ side: string; group: string; src: string; label: string }>;
        assert.deepEqual(pics.map((p) => p.side), ["before", "after"], JSON.stringify(pics.map((p) => p.label)));
        assert.equal(pics[0]!.group, pics[1]!.group);
        assert.ok(pics.every((p) => p.src.startsWith("data:image/png;base64,") && /^(Before|After) - .+![A-Z]+\d+:[A-Z]+\d+$/.test(p.label)), JSON.stringify(pics.map((p) => p.label)));
      } else assert.deepEqual(doc.pictures?.map((p) => [p.id, p.side, p.changed === true, p.src.startsWith("data:image/png;base64,")]), [["before:page1", "before", true, true], ["after:page1", "after", true, true]]);
      assert.equal(doc.pendingRetry, undefined);
      assert.deepEqual(methods(s.calls), ["isRunning", "launch", "ready", exportOf(app), exportOf(app), "documentCount", "quit", "isRunning"]);
      // each side staged under its own new folder, the PDF as ~$<name>.pdf beside the input
      const [b, a] = s.calls.filter((c) => c.method === exportOf(app));
      assert.notEqual(path.dirname(String(b!.args[1])), path.dirname(String(a!.args[1])));
      if (app.key !== "excel") assert.match(path.basename(String(b!.args[2])), /^~\$.+\.pdf$/);
      assert.deepEqual(readdirSync(s.stageRoot), [], "staging is empty after success");
    });

    it("create and delete: added and removed changes, pictures for the one side that exists", async () => {
      for (const [b, a, mark, side] of [[empty(), fx(app, 2), "added", "after"], [fx(app, 1), empty(), "removed", "before"]] as const) {
        const s = setup();
        const doc = await answerDiff(app, b, a, s.deps);
        valid(doc, app);
        assert.ok(doc.changes.some((c) => c.mark === mark), JSON.stringify(doc.changes));
        assert.deepEqual([...new Set(doc.pictures?.map((p) => p.side))], [side]);
        assert.equal(s.calls.filter((c) => c.method === exportOf(app)).length, 1);
      }
    });

    it("no change: an empty list, and Office is never asked", async () => {
      const s = setup();
      const doc = await answerDiff(app, fx(app, 1), fx(app, 1), s.deps);
      valid(doc, app);
      assert.deepEqual(doc.changes, []);
      assert.deepEqual(s.calls, []);
    });

    it("malformed: an error before Office is touched", async () => {
      const s = setup();
      await assert.rejects(answerDiff(app, fx(app, 1), truncated(app), s.deps), (e: unknown) => e instanceof ConnectorError && e.code === "unreadable-file" && /can open/.test(e.message));
      assert.deepEqual(s.calls, [], "the driver is never called for a broken file");
    });

    it("the app already open: pendingRetry with the change list, and no open, launch, quit or kill", async () => {
      const s = setup({ running: true });
      const doc = await answerDiff(app, fx(app, 1), fx(app, 2), s.deps);
      valid(doc, app);
      assert.equal(doc.pendingRetry, PENDING_RETRY);
      assert.ok(doc.changes.length > 0);
      assert.equal(doc.pictures, undefined);
      assert.deepEqual(methods(s.calls), ["isRunning"], "only the gate; nothing is sent to the person's app");
    });

    it("a thrown export: the change list plus the reason, staging empty, the launched app still quit", async () => {
      const s = setup({ exportAs: "throw" });
      const doc = await answerDiff(app, fx(app, 1), fx(app, 2), s.deps);
      valid(doc, app);
      assert.ok(doc.changes.length > 0);
      assert.equal(doc.pictures, undefined);
      assert.equal(doc.status?.kind, "unavailable");
      assert.ok(doc.caveats.some((c) => /fake export blew up/.test(c)), JSON.stringify(doc.caveats));
      assert.deepEqual(readdirSync(s.stageRoot), [], "staging is empty after a thrown error");
      assert.ok(methods(s.calls).includes("quit"));
      // the input was staged before the export (the fake saw it), and nothing is left
      assert.ok(s.calls.filter((c) => c.method === exportOf(app)).every((c) => c.staged?.length === 1));
    });

    it("an app this job launched that still holds a document is never quit", async () => {
      const s = setup({ docsLeft: 1 });
      await answerDiff(app, fx(app, 1), fx(app, 2), s.deps);
      assert.ok(!methods(s.calls).includes("quit"));
      assert.ok(!methods(s.calls).includes("kill"));
    });

    it("a hang: only the launched pid is killed, the other side is not tried, no quit after the kill", async () => {
      const s = setup({ exportAs: "timeout", pid: 777 });
      const doc = await answerDiff(app, fx(app, 1), fx(app, 2), s.deps);
      valid(doc, app);
      assert.deepEqual(s.calls.filter((c) => c.method === "kill").map((c) => c.args), [[777]]);
      assert.equal(s.calls.filter((c) => c.method === exportOf(app)).length, 1);
      assert.ok(!methods(s.calls).includes("quit"));
      assert.equal(doc.status?.kind, "hang");
      assert.equal(doc.status?.evidence, app.hangWhy);
      assert.ok(doc.caveats.some((c) => c.includes(app.hangWhy)));
      assert.deepEqual(readdirSync(s.stageRoot), []);
    });

    it("another job holding Office: pendingRetry, and the driver is not called", async () => {
      const s = setup();
      const held = OwnerLock.tryAcquire({ path: s.lockPath });
      assert.ok(held);
      try {
        const doc = await answerDiff(app, fx(app, 1), fx(app, 2), s.deps);
        assert.equal(doc.pendingRetry, PENDING_RETRY);
        assert.deepEqual(s.calls, []);
      } finally {
        held.release();
      }
    });
  });
}

it("PowerPoint's hang is worded in the reviewer's terms", () => assert.equal(OFFICE_APPS.powerpoint.hangWhy, "PowerPoint would ask to repair this file"));

it("no driver on this OS: the change list with a caveat, never an empty picture", async () => {
  const s = setup();
  const app = OFFICE_APPS.excel;
  const doc = await answerDiff(app, fx(app, 1), fx(app, 2), { ...s.deps, driver: undefined });
  valid(doc);
  assert.equal(doc.pictures, undefined);
  // the no-driver words name no OS (Windows and Linux land here)
  assert.equal(doc.caveats[0], "CoCheck does not draw Microsoft Excel's pages on this computer, so this is the change list.");
});

describe("pdfPictures", () => {
  it("unchanged only when text and PNG bytes match; a page only one side has is changed", async () => {
    const pager = { pages: async (pdf: Buffer) => pdf.toString().split("|"), png: async (pdf: Buffer, n: number) => tinyPng(pdf.toString().split("|")[n - 1]!) };
    const r = await pdfPictures({ before: Buffer.from("a|b"), after: Buffer.from("a|c|d") }, pager, 1e9, "Microsoft Word");
    assert.deepEqual(r.pictures.map((p) => [p.id, p.unchanged === true, p.changed === true, p.pageCount]), [
      ["before:page1", true, false, 2], ["before:page2", false, true, 2], ["after:page1", true, false, 3], ["after:page2", false, true, 3], ["after:page3", false, true, 3],
    ]);
    assert.deepEqual(r.caveats, []);
  });
  it("the size budget leaves pages out with a caveat naming them, and a cut page is never called unchanged", async () => {
    const big = tinyPng("x", 300, 300);
    const pager = { pages: async () => ["p", "p", "p"], png: async () => big };
    const cost = 22 + Math.ceil(big.length / 3) * 4;
    const r = await pdfPictures({ before: Buffer.from("b"), after: Buffer.from("a") }, pager, cost * 3, "Microsoft Excel");
    assert.deepEqual(r.pictures.map((p) => p.id), ["before:page1", "before:page2", "after:page1"]);
    assert.equal(r.pictures.find((p) => p.id === "before:page2")?.changed, true);
    assert.deepEqual(r.caveats, ["Before: page 3 of 3 not shown (over the page or size limit of one answer, or not drawn).", "After: pages 2-3 of 3 not shown (over the page or size limit of one answer, or not drawn)."]);
  });
});

/** A one-page PDF saying `text`, with a correct xref table. */
function tinyPdf(text: string): Buffer {
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>"];
  const stream = `BT /F1 18 Tf 20 40 Td (${text}) Tj ET`;
  objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let out = "%PDF-1.4\n";
  const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

describe("the shipped pdfpages helper on a tiny PDF (macOS only)", () => {
  const helper = pdfHelperForTest();
  it("rasterizes Office-style PDF pages into PNG pictures with sizes and flags", { skip: helper === null ? "no pdfpages helper on this machine (macOS with swiftc only)" : false }, async () => {
    process.env.COCHECK_PDF_HELPER = helper!;
    const r = await pdfPictures({ before: tinyPdf("Widget"), after: tinyPdf("Gizmo") }, helperPager, 1e9, "Microsoft Word");
    assert.deepEqual(r.caveats, []);
    assert.equal(r.pictures.length, 2);
    for (const p of r.pictures) {
      assert.ok(p.src.startsWith("data:image/png;base64,iVBOR"));
      assert.ok((p.width ?? 0) > 0 && (p.height ?? 0) > 0);
      assert.equal(p.changed, true);
    }
    const same = await pdfPictures({ before: tinyPdf("Widget"), after: tinyPdf("Widget") }, helperPager, 1e9, "Microsoft Word");
    assert.deepEqual(same.pictures.map((p) => p.unchanged), [true, true]);
  });
});

describe("cocheck connector test over the shared program with the fake driver", () => {
  for (const app of apps) {
    it(`${app.id}: passes at its declared level on fresh pairs`, { timeout: 120_000 }, async () => {
      const real = JSON.parse(readFileSync(path.join(ROOT, "connectors", app.id, "cocheck-connector.json"), "utf8")) as Record<string, unknown>;
      assert.equal(real.diffMs, 60_000);
      // The real manifest, run through a test-only program (no production seam): the fake driver replaces the platform's Office only.
      const dir = path.join(mkdtempSync(path.join(tmpdir(), "office-conn-")), app.id);
      mkdirSync(dir);
      const { requires: _r, ...manifest } = real;
      writeFileSync(path.join(dir, "cocheck-connector.json"), JSON.stringify({ ...manifest, run: ["node", "connector.mjs"] }));
      writeFileSync(path.join(dir, "connector.mjs"), `process.argv[2] = ${JSON.stringify(app.key)};\nawait import(${JSON.stringify(new URL("./helpers/office-fake-connector.ts", import.meta.url).href)});\n`);
      const r = await runConnectorTest([dir, "--states", statePairs(app.exts[0]!), "--timeout", "30000"]);
      // All three hellos declare level 3 (levelFor): Excel, Word, PowerPoint.
      if (app.key === "powerpoint") {
        // PowerPoint declares level 3. The fake driver's pages are 1x1 pixels, so no box can be placed or checked here and the documents hold level 2; the boxes
        // are proven by test/pptx-boxes.test.ts and, on real pages, by a live run.
        assert.equal(r.exitCode, 1, r.stdout + r.stderr);
        assert.match(r.stdout, /level passed: 2 \(declared 3\)/);
        return;
      }
      assert.equal(r.exitCode, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /level 3 passed/); // Excel and Word reach level 3 on the fake pages
    });
  }
  it("the shipped folders hold a manifest and a launcher for each app", () => {
    for (const app of apps) {
      assert.ok(existsSync(path.join(ROOT, "connectors", app.id, "connector.mjs")));
      const m = JSON.parse(readFileSync(path.join(ROOT, "connectors", app.id, "cocheck-connector.json"), "utf8"));
      assert.deepEqual(m.matches, { extensions: [...app.exts] });
      assert.match(readFileSync(path.join(ROOT, "connectors", app.id, "connector.mjs"), "utf8"), new RegExp(`runOfficeConnector\\("${app.key}"\\)`));
    }
  });
});

// Review fixes (office-fix2office). New exports are imported inside each test so one missing export fails only its own test.
const program = (): Promise<Record<string, any>> => import("../src/office/connector/program.ts");
const macos = (): Promise<Record<string, any>> => import("../src/office/connector/office-macos.ts");
const quick = { diffMs: 4_000, reserves: { marginMs: 300, cleanupMs: 900, drawMs: 600 } };

describe("the job fits inside diffMs, cleanup and drawing included", () => {
  it("a side that would overrun is stopped and cleaned up within diffMs (only the launched pid killed, staging empty)", { timeout: 60_000 }, async () => {
    const s = setup({ delayMs: 120_000, pid: 515 });
    const t0 = Date.now();
    const doc = await (await program()).answerDiff(OFFICE_APPS.word, fx(OFFICE_APPS.word, 1), fx(OFFICE_APPS.word, 2), { ...s.deps, ...quick } as ProgramDeps);
    const took = Date.now() - t0;
    assert.ok(took < quick.diffMs, `took ${took} ms`);
    assert.deepEqual(s.calls.filter((c) => c.method === "kill").map((c) => c.args), [[515]]);
    assert.deepEqual(readdirSync(s.stageRoot), []);
    valid(doc);
  });
  it("an app this job launched that does not go after quit is stopped by its pid before diffMs", { timeout: 60_000 }, async () => {
    const s = setup({ quitIgnored: true, pid: 616 });
    const t0 = Date.now();
    const { goneWaitMs: _g, ...deps } = s.deps;
    await (await program()).answerDiff(OFFICE_APPS.excel, fx(OFFICE_APPS.excel, 1), fx(OFFICE_APPS.excel, 2), { ...deps, ...quick } as ProgramDeps);
    const took = Date.now() - t0;
    assert.ok(took < quick.diffMs, `took ${took} ms`);
    assert.deepEqual(s.calls.filter((c) => c.method === "kill").map((c) => c.args), [[616]]);
  });
  it("drawing stops at its time limit; pages left out are named in the caveat", async () => {
    const pager = { pages: async () => ["a", "b", "c", "d"], png: async (_p: Buffer, n: number) => { await new Promise((r) => setTimeout(r, 60)); return tinyPng(`p${n}`); } };
    const r = await pdfPictures({ after: Buffer.from("x") }, pager, 1e9, "Microsoft Word", { drawBy: Date.now() + 100 } as never);
    assert.ok(r.pictures.length >= 1 && r.pictures.length < 4, `${r.pictures.length} pictures`);
    assert.ok(r.caveats.some((c) => /After: pages? .* of 4 not shown/.test(c)), JSON.stringify(r.caveats));
  });
});

describe("leftover staging from dead jobs", () => {
  it("only `CoCheck <uuid>` folders are swept, only their plain files unlinked, never recursive", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "office-sweep-"));
    const dead = path.join(root, "CoCheck 0b7e4c1a-2f3d-4e5f-8a9b-0c1d2e3f4a5b");
    const nested = path.join(root, "CoCheck 1b7e4c1a-2f3d-4e5f-8a9b-0c1d2e3f4a5b");
    const other = path.join(root, "CoCheck holiday");
    const mine = path.join(root, "Holiday");
    for (const d of [dead, nested, other, mine]) mkdirSync(d);
    writeFileSync(path.join(dead, "Budget.xlsx"), "x");
    writeFileSync(path.join(dead, "~$Budget.pdf"), "x");
    mkdirSync(path.join(nested, "keep"));
    writeFileSync(path.join(other, "a.jpg"), "x");
    writeFileSync(path.join(mine, "b.jpg"), "x");
    const s = setup({ stageRoot: root });
    await answerDiff(OFFICE_APPS.excel, fx(OFFICE_APPS.excel, 1), fx(OFFICE_APPS.excel, 2), s.deps);
    assert.equal(existsSync(dead), false, "a dead job's folder is swept");
    assert.deepEqual(readdirSync(nested), ["keep"], "a subfolder is never removed");
    assert.deepEqual(readdirSync(other), ["a.jpg"]);
    assert.deepEqual(readdirSync(mine), ["b.jpg"]);
  });
});

describe("SIGTERM mid-export", () => {
  // Windows has no SIGTERM to catch (child.kill ends the process outright, no handler runs) and no `sleep`: this is the POSIX signal path.
  it("kills only the pid this job launched and leaves staging empty", { timeout: 60_000, skip: process.platform === "win32" ? "POSIX SIGTERM handling; Windows ends a process without running a handler" : false }, async () => {
    const { spawn } = await import("node:child_process");
    const root = mkdtempSync(path.join(tmpdir(), "office-term-stage-"));
    const report = path.join(mkdtempSync(path.join(tmpdir(), "office-term-report-")), "report");
    writeFileSync(report, "");
    const decoy = spawn("sleep", ["300"], { stdio: "ignore" });
    let launched = 0;
    const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
    try {
      const child = spawn(process.execPath, [path.join(import.meta.dirname, "helpers", "office-fake-connector.ts"), "word"], {
        env: { ...process.env, OFFICE_FAKE_OPTS: JSON.stringify({ spawnApp: true, reportFile: report, stageRoot: root, delayMs: 120_000 }) },
        stdio: ["pipe", "pipe", "inherit"],
      });
      const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
      child.stdin.write(`${JSON.stringify({ id: 1, method: "diff", params: { before: fx(OFFICE_APPS.word, 1), after: fx(OFFICE_APPS.word, 2) } })}\n`);
      const until = Date.now() + 20_000;
      while (!readFileSync(report, "utf8").includes("exporting") && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
      launched = Number(/launched (\d+)/.exec(readFileSync(report, "utf8"))?.[1] ?? 0);
      assert.ok(launched > 0 && alive(launched), "the fake app was launched");
      assert.equal(readdirSync(root).length, 1, "a staging folder exists mid-export");
      child.kill("SIGTERM");
      await exited;
      await new Promise((r) => setTimeout(r, 200));
      assert.deepEqual(readdirSync(root), [], "staging is empty after SIGTERM");
      assert.equal(alive(launched), false, "the launched pid is gone");
      assert.equal(alive(decoy.pid!), true, "a process the job did not launch is untouched");
    } finally {
      if (launched > 0 && alive(launched)) process.kill(launched, "SIGKILL");
      decoy.kill("SIGKILL");
    }
  });
});

describe("an app that cannot be verified as this launch's own", () => {
  it("is treated as the person's: pendingRetry, no tell, no quit, no kill", async () => {
    const s = setup({ launchAs: "not-ours" });
    const doc = await answerDiff(OFFICE_APPS.powerpoint, fx(OFFICE_APPS.powerpoint, 1), fx(OFFICE_APPS.powerpoint, 2), s.deps);
    valid(doc);
    assert.equal(doc.pendingRetry, PENDING_RETRY);
    assert.deepEqual(methods(s.calls), ["isRunning", "launch"]);
  });
});

describe("the Mac driver's AppleScript", () => {
  it("Word and PowerPoint find their document by the staged path, export and close through that reference only", async () => {
    const { exportScript } = await macos();
    for (const [key, active] of [["word", "active document"], ["powerpoint", "active presentation"]] as const) {
      const sc: string = exportScript(key, "/Users/x/Pictures/CoCheck 1/a b.docx", "/Users/x/Pictures/CoCheck 1/~$a b.pdf");
      assert.ok(!sc.includes(active), `${key}: no ${active}`);
      assert.match(sc, /whose full name is /);
      assert.ok(sc.includes('"/Users/x/Pictures/CoCheck 1/a b.docx"'));
      const closes = sc.split("\n").filter((l) => /\bclose\b/.test(l));
      const cls = key === "word" ? "document" : "presentation";
      // the name is read from the document whose full name is the staged path, then save and close go by that name (a whose reference handed
      // to PowerPoint's save fails with -1750)
      assert.match(sc, new RegExp(`set dn to name of \\(first ${cls} whose full name is `));
      assert.ok(closes.length > 0 && closes.every((l) => l.includes(`close ${cls} dn saving no`)), `${key}: ${closes.join(" | ")}`);
      // not found: the side fails before any close
      assert.ok(sc.indexOf('"find"') > 0 && sc.indexOf('"find"') < sc.indexOf(`close ${cls} dn`), `${key}: find fails before close`);
    }
  });
  it("Word and PowerPoint close only untitled, unmodified documents by name before counting (asked only in an app this job launched)", async () => {
    const { countScript } = await macos();
    for (const [key, cls] of [["word", "document"], ["powerpoint", "presentation"]] as const) {
      const sc: string = countScript(key);
      assert.match(sc, new RegExp(`every ${cls} whose path is "" and saved is true`));
      assert.match(sc, new RegExp(`close ${cls} \\(nm as text\\) saving no`));
    }
  });
  it("a blank document from the hidden launch does not keep the app open; a modified one does", async () => {
    const blank = setup({ blankDocs: [{ name: "Document1", untitled: true, saved: true }] });
    await answerDiff(OFFICE_APPS.word, fx(OFFICE_APPS.word, 1), fx(OFFICE_APPS.word, 2), blank.deps);
    assert.ok(methods(blank.calls).includes("quit"));
    const edited = setup({ blankDocs: [{ name: "Document1", untitled: true, saved: false }] });
    await answerDiff(OFFICE_APPS.word, fx(OFFICE_APPS.word, 1), fx(OFFICE_APPS.word, 2), edited.deps);
    assert.ok(!methods(edited.calls).includes("quit"));
  });
  it("once the launched process is gone, nothing more is sent to the app: no count, no quit (a late tell would start a copy)", async () => {
    const gone = setup({});
    // alive through both exports, gone by cleanup
    let exports = 0;
    const drv = gone.deps.driver as { alive?: (pid: number) => boolean; exportPdf: (...a: unknown[]) => Promise<unknown> };
    const orig = drv.exportPdf.bind(drv);
    drv.exportPdf = async (...a: unknown[]) => { exports++; return orig(...a); };
    drv.alive = () => exports < 2;
    await answerDiff(OFFICE_APPS.powerpoint, fx(OFFICE_APPS.powerpoint, 1), fx(OFFICE_APPS.powerpoint, 2), gone.deps);
    const m = methods(gone.calls);
    assert.ok(m.includes("exportPdf"), m.join(","));
    assert.ok(!m.includes("documentCount") && !m.includes("quit"), m.join(","));
  });
  it("a side is not exported once the launched process is gone (a copy the person started since never gets the staged file)", async () => {
    const t = setup({});
    let exports = 0;
    const drv = t.deps.driver as { alive?: (pid: number) => boolean; exportTargets: (...a: unknown[]) => Promise<unknown> };
    const orig = drv.exportTargets.bind(drv);
    drv.exportTargets = async (...a: unknown[]) => { exports++; return orig(...a); };
    drv.alive = () => exports === 0;
    const doc = await answerDiff(OFFICE_APPS.excel, fx(OFFICE_APPS.excel, 1), fx(OFFICE_APPS.excel, 2), t.deps);
    assert.equal(exports, 1);
    assert.ok(doc.caveats.some((c: string) => /closed before this side/.test(c)), doc.caveats.join(" | "));
  });
  it("every script the Mac driver sends is gated on the app already running, so no script can start the app", async () => {
    const { gated, GONE } = await macos();
    const g: string = gated("Microsoft PowerPoint", "tell application \"Microsoft PowerPoint\" to quit");
    assert.equal(g.split("\n")[0], `if application "Microsoft PowerPoint" is not running then return "${GONE}"`);
    const src = readFileSync(path.join(ROOT, "src", "office", "connector", "office-macos.ts"), "utf8");
    // osascript is started in exactly one place, and that place sends the gated script
    assert.equal((src.match(/execFile\("osascript"/g) ?? []).length, 1);
    assert.match(src, /execFile\("osascript", \["-e", gated\(/);
  });
});

describe("under tests (COCHECK_TEST_NO_OFFICE)", () => {
  it("the shipped wiring uses no driver at all and says Office is not used under tests", async () => {
    const { officeDeps } = await import("../src/office/connector/main.ts") as Record<string, any>;
    assert.equal(typeof officeDeps, "function");
    const deps = officeDeps({ COCHECK_TEST_NO_OFFICE: "1" });
    assert.equal(deps.driver, undefined);
    const doc = await answerDiff(OFFICE_APPS.excel, fx(OFFICE_APPS.excel, 1), fx(OFFICE_APPS.excel, 2), deps);
    valid(doc);
    assert.ok(doc.changes.length > 0);
    assert.equal(doc.pictures, undefined);
    assert.ok(doc.caveats.some((c) => /not used under tests/.test(c)), JSON.stringify(doc.caveats));
  });
});

it("a process start time is read locale- and zone-free (ps lstart under LC_ALL=C TZ=UTC) as epoch ms", async () => {
  const { parseLstartUtc } = await import("../src/office/connector/mac-guard.ts");
  assert.equal(parseLstartUtc("Wed Nov 11 01:06:35 2026    \n"), Date.UTC(2026, 10, 11, 1, 6, 35));
  assert.equal(parseLstartUtc("Mon Feb  2 09:00:00 2026"), Date.UTC(2026, 1, 2, 9, 0, 0));
  assert.equal(parseLstartUtc("mié 11 nov 01:06:35 2026"), null);
});
