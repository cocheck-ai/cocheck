import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { openLedger } from "../src/ledger.ts";
import { reviewModel, type PageRow } from "./helpers/legacy-review-model.ts";
import { renderReviewPage } from "./helpers/legacy-review-page.ts";
import { handleHook, parseOutsideWatching, type HookPayload } from "../src/hook-adapter.ts";
import { workbookClaims } from "./helpers/claims.ts";

const fwd = (p: string): string => p.replaceAll("\\", "/"); // a Bash command line names paths with forward slashes on every OS

// writes outside the watched folder never leave a clean-looking page. In the live run Codex Work
// mode wrote its edited copy to its own workspace; the hooks fired and the page showed nothing changed.
const FIXTURES = path.join(import.meta.dirname, "fixtures");
const probe = (n: number) => path.join(FIXTURES, "probe", `S${n}.xlsx`);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function setup(outsideWatching: boolean | undefined) {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-home-"));
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-folder-")));
  const ws = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-ws-")));
  await mkdir(path.join(ws, "outputs"));
  await copyFile(probe(0), path.join(folder, "casebook.xlsx"));
  await copyFile(probe(0), path.join(ws, "outputs", "casebook.xlsx"));
  cleanups.push(async () => {
    for (const d of [home, folder, ws]) await rm(d, { recursive: true, force: true });
  });
  const opts = { perSession: false, host: "codex" as const, home, claimed: workbookClaims, folder, ...(outsideWatching === undefined ? {} : { outsideWatching }) };
  const send = (event: string, over: Record<string, unknown>) =>
    handleHook({ session_id: "s1", cwd: folder, hook_event_name: event, tool_name: "Bash", ...over } as HookPayload, opts);
  const pre = (id: string, command: string, cwd = folder) => send("PreToolUse", { tool_use_id: id, tool_input: { command }, cwd });
  const post = (id: string, command: string, cwd = folder) => send("PostToolUse", { tool_use_id: id, tool_input: { command }, cwd });
  const stop = async () => {
    const r = await send("Stop", { tool_name: undefined });
    assert.ok(r.summary, "Stop returned a round summary");
    return r.summary.taskId;
  };
  const page = (taskId: number) => {
    const ledger = openLedger(home);
    try {
      const model = reviewModel(ledger, taskId);
      return { model, html: renderReviewPage(model) };
    } finally {
      ledger.close();
    }
  };
  /** the round writes no row, so the page shows no outside rows; what the ledger holds is the file states (credit) and the ops (intents). */
  const view = (taskId: number) => {
    const ledger = openLedger(home);
    try {
      const states = ledger.fileStatesForTask(taskId).filter((x) => x.prevSha256 !== null).map((x) => ({ file: x.filePath, credited: [...x.credited].sort() }));
      const ops = JSON.stringify(ledger.okOpsForTask(taskId, 0, ledger.maxOpId()));
      return { states, ops };
    } finally {
      ledger.close();
    }
  };
  return { home, folder, ws, pre, post, stop, page, view };
}

const rowsOf = (model: ReturnType<typeof reviewModel>): PageRow[] =>
  model.files.flatMap((f) => f.sheets.flatMap((s) => [...s.rows, ...s.derived, ...s.flagged.flatMap((g) => [...g.rows, ...g.derived])]));

describe("outside watching", () => {
  it("parseOutsideWatching: on by default, off by flag or env", () => {
    assert.equal(parseOutsideWatching([], {}), true);
    assert.equal(parseOutsideWatching(["--outside-watching", "off"], {}), false);
    assert.equal(parseOutsideWatching([], { COCHECK_OUTSIDE_WATCHING: "off" }), false);
    assert.equal(parseOutsideWatching(["--outside-watching", "on"], { COCHECK_OUTSIDE_WATCHING: "off" }), true);
  });

  it("on: a workbook a call names outside the folder is a state credited to that call", async () => {
    const t = await setup(true);
    const book = path.join(t.ws, "outputs", "casebook.xlsx");
    const cmd = `python3 ${fwd(path.join(t.ws, "edit.py"))} ${fwd(book)}`;
    await t.pre("c1", cmd);
    await copyFile(probe(1), book);
    await t.post("c1", cmd);
    const { states } = t.view(await t.stop());
    assert.deepEqual(states, [{ file: book, credited: ["c1"] }], "the outside edit is a state credited to the call");
  });

  it("on: replay of the Codex Work leg (cwd in its workspace) records the outside edit, credited", async () => {
    const t = await setup(true);
    const leg = JSON.parse(await readFile(path.join(FIXTURES, "hooks", "codex-work-leg.json"), "utf8")) as { calls: Array<{ id: string; command: string }> };
    const book = path.join(t.ws, "outputs", "casebook.xlsx");
    for (const [i, c] of leg.calls.entries()) {
      const command = c.command.replaceAll("{FOLDER}", t.folder);
      await t.pre(c.id, command, t.ws);
      if (i === 8) await copyFile(probe(1), book);
      await t.post(c.id, command, t.ws);
    }
    const { states } = t.view(await t.stop());
    assert.ok(states.length > 0, "the workspace edit is a state");
    assert.ok(states.every((x) => x.file.startsWith(t.ws) && x.credited.length > 0), "every outside state is credited to a call");
  });

  it("off: replay copies nothing, names nothing, and says how many calls touched outside paths", async () => {
    const t = await setup(false);
    const leg = JSON.parse(await readFile(path.join(FIXTURES, "hooks", "codex-work-leg.json"), "utf8")) as { calls: Array<{ id: string; command: string }> };
    const book = path.join(t.ws, "outputs", "casebook.xlsx");
    for (const [i, c] of leg.calls.entries()) {
      const command = c.command.replaceAll("{FOLDER}", t.folder);
      await t.pre(c.id, command, t.ws);
      if (i === 8) await copyFile(probe(1), book);
      await t.post(c.id, command, t.ws);
    }
    const { model, html } = t.page(await t.stop());
    assert.equal(rowsOf(model).length, 0);
    assert.match(html, /outside watching is off/);
    assert.match(html, /\d+ calls? touched paths outside the watched folder/);
    assert.doesNotMatch(html, /work\/change\.py/);
    assert.ok(!html.includes(t.ws));
    assert.match(html, /no workbook change/);
    assert.doesNotMatch(html, /no changes/i);
    // the copies live in the task's store; only the watched workbook's state is in it, never the outside one.
    const copies = (await readdir(path.join(t.home, "tasks", "1", "states"))).filter((n) => !n.startsWith("."));
    assert.equal(copies.length, 1, "only the watched workbook has a copy");
  });

  it("a bare script call that names no path is listed as path unknown, and the round says no workbook changed", async () => {
    const t = await setup(true);
    await t.pre("b1", "python3 bump_prices.py");
    await t.post("b1", "python3 bump_prices.py");
    const { html } = t.page(await t.stop());
    assert.match(html, /path unknown/);
    assert.match(html, /bump_prices\.py/);
    assert.match(html, /no workbook change/);
    assert.doesNotMatch(html, /no changes/i);
  });

  it("a round whose only write is a non-workbook outside file is not clean, on or off", async () => {
    for (const on of [true, false]) {
      const t = await setup(on);
      const cmd = `echo hi > ${fwd(path.join(t.ws, "out.txt"))}`;
      await t.pre("w1", cmd);
      await t.post("w1", cmd);
      const { html } = t.page(await t.stop());
      assert.match(html, /no workbook change/);
      if (on) {
        assert.match(html, /Work outside the watched folder/);
        assert.ok(html.includes(path.join(t.ws, "out.txt")));
      } else {
        assert.match(html, /1 call touched paths outside the watched folder \(outside watching is off\)/);
        assert.ok(!html.includes(t.ws));
      }
    }
  });

  // every path-like token, resolved against the call's cwd.
  const uniq = () => `uniq-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

  for (const on of [true, false]) {
    it(`${on ? "on" : "off"}: cp a.xlsx ../b.xlsx (relative escape) is ${on ? "a state credited to the call" : "counted, not named"}`, async () => {
      const t = await setup(on);
      const dest = path.join(path.dirname(t.folder), `${uniq()}.xlsx`);
      cleanups.push(async () => void (await rm(dest, { force: true })));
      await copyFile(probe(0), dest);
      const cmd = `cp casebook.xlsx ../${path.basename(dest)}`;
      await t.pre("r1", cmd);
      await copyFile(probe(1), dest);
      if (!on) await copyFile(probe(1), path.join(t.folder, "casebook.xlsx")); // an inside row, so the page quotes the command
      await t.post("r1", cmd);
      const { states, ops } = t.view(await t.stop());
      if (on) {
        assert.ok(states.some((x) => x.file === dest && x.credited.join() === "r1"), "the outside copy's change is credited to the call");
      } else {
        assert.ok(states.every((x) => x.file === path.join(t.folder, "casebook.xlsx")), "no outside state");
        assert.ok(!ops.includes(path.basename(dest)), "off: the outside file name is in no op");
        assert.match(ops, /\[outside path\]/);
      }
    });
  }

  it("on: cp a.xlsx .. and cp a.xlsx ~ list the source basename inside the destination directory as outside", async () => {
    const t = await setup(true);
    const name = `${uniq()}.xlsx`;
    await copyFile(probe(0), path.join(t.folder, name));
    await t.pre("d1", `cp ${name} ..`);
    await t.post("d1", `cp ${name} ..`);
    await t.pre("d2", `cp ${name} ~`);
    await t.post("d2", `cp ${name} ~`);
    const { html } = t.page(await t.stop());
    assert.ok(html.includes(path.join(path.dirname(t.folder), name)), "the .. destination file is listed");
    assert.ok(html.includes(path.join(homedir(), name)), "the ~ destination file is listed");
    assert.doesNotMatch(html, /path unknown/);
  });

  it("on: touch ../x is listed as outside, not path unknown", async () => {
    const t = await setup(true);
    const n = uniq();
    await t.pre("t1", `touch ../${n}`);
    await t.post("t1", `touch ../${n}`);
    const { html } = t.page(await t.stop());
    assert.ok(html.includes(path.join(path.dirname(t.folder), n)));
    assert.doesNotMatch(html, /path unknown/);
  });

  it("on: variable-built paths ($WS/x, ${WS}/b.xlsx) are path unknown", async () => {
    const t = await setup(true);
    await t.pre("v1", "echo > $WS/x");
    await t.post("v1", "echo > $WS/x");
    await t.pre("v2", "cp casebook.xlsx ${WS}/b.xlsx");
    await t.post("v2", "cp casebook.xlsx ${WS}/b.xlsx");
    const { html } = t.page(await t.stop());
    assert.equal((html.match(/path unknown/g) ?? []).length, 2);
    assert.ok(!html.includes("<code>/b.xlsx</code>") && !html.includes("<code>/x</code>"), "${WS}/b.xlsx is not parsed as /b.xlsx");
  });

  it("a round with calls and no row carries the fixed computed-path sentence", async () => {
    const t = await setup(true);
    await t.pre("s1", "ls");
    await t.post("s1", "ls");
    const { html } = t.page(await t.stop());
    assert.match(html, /no workbook change was found\. Writes to paths a script computes itself would also show no change here\./);
  });

  it("off: an outside path inside a quoted command is replaced, and no op names an outside path", async () => {
    const t = await setup(false);
    const cmd = `echo hi > ${fwd(path.join(t.ws, "out.txt"))} && cat ${fwd(path.join(t.ws, "outputs", "casebook.xlsx"))}`;
    await t.pre("o1", cmd);
    await copyFile(probe(1), path.join(t.folder, "casebook.xlsx")); // an inside row, so the page quotes the command
    await t.post("o1", cmd);
    const { ops } = t.view(await t.stop());
    assert.ok(!ops.includes(t.ws), "no op holds the outside path");
    assert.match(ops, /\[outside path\]/);
  });

  it("an outside cwd is shown once per round, not on every call (on) and never named (off)", async () => {
    for (const on of [true, false]) {
      const t = await setup(on);
      for (const id of ["k1", "k2", "k3"]) {
        await t.pre(id, "ls", t.ws);
        await t.post(id, "ls", t.ws);
      }
      const { html } = t.page(await t.stop());
      if (on) {
        assert.equal(html.split(t.ws).length - 1, 1, "the workspace path appears once");
        assert.doesNotMatch(html, /touched paths outside/);
      } else {
        assert.ok(!html.includes(t.ws));
        assert.match(html, /3 calls touched paths outside the watched folder \(outside watching is off\)/);
      }
    }
  });

  // one definition of "touched outside" per call, with the working directory tracked through the command.
  it("off: an outside cwd with a call naming no path (touch zz, python3 edit.py, ls) is counted, each", async () => {
    const t = await setup(false);
    for (const [id, cmd] of [["z1", "touch zz"], ["z2", "python3 edit.py"], ["z3", "ls"]] as const) {
      await t.pre(id, cmd, t.ws);
      await t.post(id, cmd, t.ws);
    }
    const { html } = t.page(await t.stop());
    assert.match(html, /3 calls touched paths outside the watched folder \(outside watching is off\)/);
    assert.ok(!html.includes(t.ws));
    assert.ok(!html.includes("edit.py"));
  });

  for (const on of [true, false]) {
    it(`${on ? "on" : "off"}: cd .. && cp folder/casebook.xlsx b.xlsx resolves b.xlsx against the new directory (${on ? "credited" : "counted"})`, async () => {
      const t = await setup(on);
      const name = `${uniq()}.xlsx`;
      const dest = path.join(path.dirname(t.folder), name);
      cleanups.push(async () => void (await rm(dest, { force: true })));
      await copyFile(probe(0), dest);
      const cmd = `cd .. && cp ${path.basename(t.folder)}/casebook.xlsx ${name}`;
      await t.pre("e1", cmd);
      await copyFile(probe(1), dest);
      await t.post("e1", cmd);
      const { states, ops } = t.view(await t.stop());
      if (on) {
        assert.ok(states.some((x) => x.file === dest && x.credited.join() === "e1"), "the outside copy's change is credited to the call");
      } else {
        assert.equal(states.length, 0, "no outside state");
        assert.ok(!ops.includes(name), "off: the outside file name is in no op");
      }
    });
  }

  it("off: cd .. && touch SECRET1 leaves SECRET1 nowhere (page, ledger, state)", async () => {
    const t = await setup(false);
    const cmd = "cd .. && touch SECRET1";
    await t.pre("x1", cmd);
    await copyFile(probe(1), path.join(t.folder, "casebook.xlsx")); // an inside row, so the page quotes the command
    await t.post("x1", cmd);
    const { html } = t.page(await t.stop());
    assert.ok(!html.includes("SECRET1"));
    assert.match(html, /1 call touched paths outside the watched folder/);
    const all: string[] = [];
    const walk = async (d: string) => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) await walk(f);
        else all.push((await readFile(f)).toString("latin1"));
      }
    };
    await walk(t.home);
    assert.ok(all.length > 0 && all.every((c) => !c.includes("SECRET1")), "no stored file holds SECRET1");
  });

  it("a subshell cd does not leak: (cd .. && ls); touch inside.txt counts, then stays inside", async () => {
    const t = await setup(false);
    await t.pre("p1", "(cd .. && ls); touch inside.txt");
    await t.post("p1", "(cd .. && ls); touch inside.txt");
    await t.pre("p2", "(cd sub); touch inside.txt");
    await t.post("p2", "(cd sub); touch inside.txt");
    const { html } = t.page(await t.stop());
    assert.match(html, /1 call touched paths outside the watched folder/);
  });
});
