#!/usr/bin/env node
// Stranger-test grader: judges mechanically whether a connector built from the public spec shows correctly on the review rail.
// Usage: node scripts/anchor-grade.ts <connector-dir> <sealed-dir>     (exit 0 only when every criterion passes)
// Grades cocheck.changes/1 answers: an entity is a change's `id`, and its kind is the change's mark (added: create, changed: edit, removed: delete).
// Sealed dir holds sealed.json: { steps: [{call, input, before, after, expectChanges:[{kind, entity}], golden:{before?, after?}}  (exact expected text per side)], untouched: [entity] }
// plus the before/after state files the steps name. `call` is the scripted host call id each change must be credited to.
// Criteria: conformance, recall, precision, credit, panes, tokens. Status "pending" means a stage that cannot run yet; any
// pending or failed criterion makes the overall grade fail. The rail stages run through ingestToRail: the real hook
// capture path, the production connectorDiff and buildRailModel, in a temp CoCheck home.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { requireRun } from "../src/connector/run-argv.ts";

export const AWAITING_CONFORMANCE = "awaiting cocheck connector test";

export type Kind = "create" | "edit" | "delete";
export interface Expected { kind: Kind; entity: string }
export interface Step { call: string; input: string; before: string; after: string; expectChanges: Expected[]; golden: { before?: string; after?: string } }
export interface Sealed { steps: Step[]; untouched: string[] }
export interface Emitted { id: string; mark: string; label?: string; before?: string; after?: string }
/** One card on the review rail: the change's id, its kind, the call CoCheck credits, and the text sides. */
export interface Card { entity: string; kind: Kind; creditedCall: string; panes: { before?: string; after?: string } }
export type Status = "pass" | "fail" | "pending";
export interface Criterion { status: Status; reasons: string[] }
export const CRITERIA = ["conformance", "recall", "precision", "credit", "panes", "tokens"] as const;
export type Report = { pass: boolean; criteria: Record<(typeof CRITERIA)[number], Criterion> };

const entityOf = (c: Emitted) => c.id ?? "";
const KIND_OF_MARK: Record<string, Kind | undefined> = { added: "create", changed: "edit", removed: "delete" };
/** The kind a change's mark stands for; a mark with no kind (moved, described) is never one of the sealed changes. */
export const kindOf = (c: Emitted): string => KIND_OF_MARK[c.mark] ?? c.mark;
const key = (kind: string, entity: string) => `${kind}:${entity}`;
/** Only whitespace is normalised; case and every other character count. Values are compared exactly against the sealed golden text. */
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const goldenSides = (st: Step) => (["before", "after"] as const).filter((s) => st.golden[s] !== undefined);

/** Recall and precision of emitted changes against the sealed expectation, kind and entity, order-free. */
export function matchChanges(expected: Expected[], emitted: Emitted[]) {
  const want = new Map<string, number>();
  for (const e of expected) want.set(key(e.kind, e.entity), (want.get(key(e.kind, e.entity)) ?? 0) + 1);
  const got = new Map<string, number>();
  for (const c of emitted) got.set(key(kindOf(c), entityOf(c)), (got.get(key(kindOf(c), entityOf(c))) ?? 0) + 1);
  const missed: string[] = [];
  const extra: string[] = [];
  let hit = 0;
  for (const [k, n] of want) {
    const g = got.get(k) ?? 0;
    hit += Math.min(n, g);
    if (g < n) missed.push(k);
  }
  for (const [k, g] of got) if (g > (want.get(k) ?? 0)) extra.push(k);
  return { missed, extra, recall: expected.length ? hit / expected.length : 1, precision: emitted.length ? hit / emitted.length : 1 };
}

/** Emitted payloads must be non-empty on the sides the kind uses, and carry the exact sealed golden value on each side the golden names. */
export function checkPayloads(step: Step, emitted: Emitted[]): { panes: string[]; tokens: string[] } {
  const panes: string[] = [];
  const tokens: string[] = [];
  for (const c of emitted) {
    const id = `${step.call} ${key(kindOf(c), entityOf(c))}`;
    const sides: ("before" | "after")[] = kindOf(c) === "create" ? ["after"] : kindOf(c) === "delete" ? ["before"] : ["before", "after"];
    for (const s of sides) if (!norm(c[s] ?? "")) panes.push(`${id}: ${s} pane empty`);
    for (const s of goldenSides(step)) if (norm(c[s] ?? "") !== norm(step.golden[s]!)) tokens.push(`${id}: ${s} value "${c[s] ?? ""}" is not the sealed "${step.golden[s]}"`);
  }
  return { panes, tokens };
}

/** Rail checks over cards (from ingestion): exactly one card per sealed change, none for untouched entities, each credited to its scripted call, panes present with the exact sealed value. */
export function checkCards(sealed: Sealed, cards: Card[]) {
  const r = { recall: [] as string[], precision: [] as string[], credit: [] as string[], panes: [] as string[], tokens: [] as string[] };
  const used = new Set<Card>();
  for (const st of sealed.steps) {
    for (const e of st.expectChanges) {
      const m = cards.filter((c) => c.entity === e.entity && c.kind === e.kind);
      if (m.length === 0) { r.recall.push(`${st.call}: no card for ${key(e.kind, e.entity)}`); continue; }
      if (m.length > 1) r.precision.push(`${st.call}: ${m.length} cards for ${key(e.kind, e.entity)}, want exactly one`);
      m.forEach((c) => used.add(c));
      const card = m[0]!;
      if (card.creditedCall !== st.call) r.credit.push(`${key(e.kind, e.entity)} credited to ${card.creditedCall}, want ${st.call}`);
      const sides: ("before" | "after")[] = e.kind === "create" ? ["after"] : e.kind === "delete" ? ["before"] : ["before", "after"];
      for (const s of sides) if (!norm(card.panes[s] ?? "")) r.panes.push(`${key(e.kind, e.entity)}: ${s} pane missing or empty`);
      for (const s of goldenSides(st)) if (norm(card.panes[s] ?? "") !== norm(st.golden[s]!)) r.tokens.push(`${key(e.kind, e.entity)}: ${s} pane "${card.panes[s] ?? ""}" is not the sealed "${st.golden[s]}"`);
    }
  }
  for (const c of cards) if (!used.has(c)) r.precision.push(`card ${key(c.kind, c.entity)} matches no sealed change${sealed.untouched.includes(c.entity) ? " (untouched entity)" : ""}`);
  return r;
}

interface Manifest { run: unknown }
/** Run the connector's manifest command over stdio: hello, then one diff per call. Returns the emitted changes. */
export function runConnector(dir: string, before: string, after: string): Emitted[] {
  const manifest = JSON.parse(readFileSync(path.join(dir, "cocheck-connector.json"), "utf8")) as Manifest;
  const [cmd, ...args] = requireRun(manifest.run);
  const input = [{ id: 1, method: "hello", params: {} }, { id: 2, method: "diff", params: { before, after } }].map((m) => JSON.stringify(m)).join("\n") + "\n";
  const res = spawnSync(cmd === "node" ? process.execPath : cmd!, args, { cwd: dir, input, encoding: "utf8", timeout: 20000 });
  if (res.status !== 0) throw new Error(`connector exited ${res.status}: ${res.stderr}`);
  const replies = res.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l) as { id: number; result?: { spec?: string; changes: Emitted[] }; error?: { code: string } });
  const d = replies.find((r) => r.id === 2);
  if (!d?.result) throw new Error(`diff failed: ${d?.error?.code ?? "no reply"}`);
  return d.result.changes;
}

/**
 * Plays the sealed steps as a scripted fake-host session through the real hook capture path (handleHook) in a temp CoCheck home with the connector
 * installed, loads the task with the production connectorDiff, builds the rail model and returns one card per connector change. Credit is CoCheck's
 * own record of which call wrote the file (the rail stop's calls); nothing the connector says is read for it.
 * State files, the ledger and the store live only under temp folders made here.
 */
export async function ingestToRail(connectorDir: string, sealedDir: string, sealed: Sealed, _emittedByCall: Map<string, Emitted[]>): Promise<Card[]> {
  const { mkdtemp, mkdir, writeFile, rm, cp, realpath } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const root = pathToFileURL(path.join(import.meta.dirname, "..", "src") + path.sep).href;
  const load = (rel: string) => import(new URL(rel, root).href);
  const { handleHook } = await load("hook-adapter.ts");
  const { openLedger } = await load("ledger.ts");
  const { loadTimeline, defaultLayers } = await load("timeline/load.ts");
  const { buildRailModel } = await load("timeline/rail/model.ts");
  const { createConnectorDiff, stopWarmConnectors } = await load("connector/diff.ts");
  const { readFrozen } = await load("connector/frozen.ts");
  const { settlePendingCaptures } = await load("connector/file-capture.ts");
  const { memoryKeyProvider, setKeyProvider } = await load("seal.ts");
  const manifest = JSON.parse(readFileSync(path.join(connectorDir, "cocheck-connector.json"), "utf8")) as { id: string };
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-anchor-home-"));
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-anchor-folder-")));
  setKeyProvider(memoryKeyProvider());
  try {
    await mkdir(path.join(home, "connectors"), { recursive: true });
    await cp(connectorDir, path.join(home, "connectors", manifest.id), { recursive: true });
    const fileOf = (st: Step) => path.join(folder, `${st.input}.notes.json`);
    for (const st of sealed.steps) await writeFile(fileOf(st), readFileSync(path.join(sealedDir, st.before)));
    let clock = 1_700_000_000_000;
    const opts = { host: "claude", home, folder, now: () => (clock += 1000) };
    const base = { session_id: "anchor-grade-session", cwd: folder, transcript_path: "/x/anchor.jsonl", permission_mode: "default" };
    const call = (event: string, st: Step, extra: Record<string, unknown> = {}) => ({ ...base, hook_event_name: event, tool_name: "Bash", tool_use_id: st.call, tool_input: { command: `edit ${st.input}.notes.json`, description: "update the notes" }, ...extra });
    await handleHook({ ...base, hook_event_name: "UserPromptSubmit", prompt: "update my notes" }, opts);
    for (const st of sealed.steps) {
      await handleHook(call("PreToolUse", st), opts);
      await writeFile(fileOf(st), readFileSync(path.join(sealedDir, st.after)));
      await handleHook(call("PostToolUse", st, { tool_response: { stdout: "ok" } }), opts);
    }
    await handleHook({ ...base, hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "Done." }, opts);

    const ledger = openLedger(home);
    try {
      const taskId = ledger.allTaskIds().at(-1);
      if (taskId === undefined) throw new Error("the scripted session recorded no task");
      // The hook leaves each claimed file row pending; the review process reads and freezes it. No review process runs here, so the grader does that step itself.
      await settlePendingCaptures(ledger, home, taskId);
      const connectorDiff = createConnectorDiff({ home, taskId });
      const { timeline } = await loadTimeline(ledger, home, taskId, { layers: defaultLayers(), build: "anchor-grade", quickLook: false, connectorDiff });
      const rail = buildRailModel(timeline);
      const changes = [...timeline.unplaced, ...timeline.requests.flatMap((r: any) => r.runs.flatMap((u: any) => u.calls.flatMap((c: any) => c.changes)))].filter((c: any) => c.diff !== undefined);
      const cards: Card[] = [];
      for (const change of changes as any[]) {
        const stop = rail.stops.find((x: any) => x.change?.key === change.id);
        const credited = ((stop?.calls ?? []) as Array<{ id: string }>).map((c) => c.id).join(",");
        // The cards come from the document CoCheck froze at capture (the one the page is served), by each change's own id.
        if (change.diff.served?.kind !== "frozen") continue;
        const doc = (await readFrozen(home, taskId, change.diff.served.ref)) as { changes: Emitted[] };
        for (const c of doc.changes) {
          const panes: Card["panes"] = {};
          if (typeof c.before === "string") panes.before = c.before;
          if (typeof c.after === "string") panes.after = c.after;
          cards.push({ entity: entityOf(c), kind: kindOf(c) as Kind, creditedCall: credited, panes });
        }
      }
      return cards;
    } finally {
      ledger.close();
    }
  } finally {
    setKeyProvider(null);
    // The warm connector process runs in its folder inside this home; it is ended (and its exit awaited) first, or Windows refuses to remove the folder.
    await stopWarmConnectors();
    for (const d of [home, folder]) await rm(d, { recursive: true, force: true });
  }
}

async function conformance(dir: string, casesDir: string): Promise<Criterion> {
  let mod: { runCases?: (a: { dir: string; casesDir: string }) => Promise<{ id: string; pass: boolean; reason?: string }[]> | { id: string; pass: boolean; reason?: string }[] };
  try { mod = await import(pathToFileURL(path.join(import.meta.dirname, "..", "src", "connector", "conformance.ts")).href); } catch { return { status: "pending", reasons: [AWAITING_CONFORMANCE] }; }
  if (!mod.runCases) return { status: "pending", reasons: [AWAITING_CONFORMANCE] };
  const res = await mod.runCases({ dir, casesDir });
  const bad = res.filter((r) => !r.pass);
  return bad.length ? { status: "fail", reasons: bad.map((r) => `${r.id}: ${r.reason ?? "failed"}`) } : { status: "pass", reasons: [] };
}

const crit = (reasons: string[]): Criterion => ({ status: reasons.length ? "fail" : "pass", reasons });

export interface GradeOpts { connectorDir: string; sealedDir: string; casesDir?: string }

export async function grade(o: GradeOpts): Promise<Report> {
  const sealed = JSON.parse(readFileSync(path.join(o.sealedDir, "sealed.json"), "utf8")) as Sealed;
  const casesDir = o.casesDir ?? path.join(import.meta.dirname, "..", "public-kit", "conformance", "cases");
  const c: Report["criteria"] = {} as Report["criteria"];
  c.conformance = await conformance(o.connectorDir, casesDir);

  const byCall = new Map<string, Emitted[]>();
  const recall: string[] = [], precision: string[] = [], panes: string[] = [], tokens: string[] = [];
  for (const st of sealed.steps) {
    let emitted: Emitted[];
    try { emitted = runConnector(o.connectorDir, path.join(o.sealedDir, st.before), path.join(o.sealedDir, st.after)); } catch (e) { recall.push(`${st.call}: ${(e as Error).message}`); continue; }
    byCall.set(st.call, emitted);
    const m = matchChanges(st.expectChanges, emitted);
    m.missed.forEach((k) => recall.push(`${st.call}: missed ${k}`));
    m.extra.forEach((k) => precision.push(`${st.call}: unexpected ${k}`));
    const p = checkPayloads(st, emitted);
    panes.push(...p.panes);
    tokens.push(...p.tokens);
  }
  c.recall = crit(recall);
  c.precision = crit(precision);
  c.panes = crit(panes);
  c.tokens = crit(tokens);
  try {
    const r = checkCards(sealed, await ingestToRail(o.connectorDir, o.sealedDir, sealed, byCall));
    c.recall = crit([...recall, ...r.recall]);
    c.precision = crit([...precision, ...r.precision]);
    c.credit = crit(r.credit);
    c.panes = crit([...panes, ...r.panes]);
    c.tokens = crit([...tokens, ...r.tokens]);
  } catch (e) {
    // Ingestion itself failed (the connector could not be run through the rail): the rail criteria fail, never pass by default.
    const why = `rail ingestion failed: ${(e as Error).message}`;
    c.recall = crit([...recall, why]);
    c.credit = crit([why]);
  }
  return { pass: CRITERIA.every((k) => c[k].status === "pass"), criteria: c };
}

if (import.meta.main) {
  const [dir, sealedDir] = process.argv.slice(2);
  if (!dir || !sealedDir) throw new Error("usage: anchor-grade.ts <connector-dir> <sealed-dir>");
  const rep = await grade({ connectorDir: path.resolve(dir), sealedDir: path.resolve(sealedDir) });
  for (const k of CRITERIA) console.log(`${rep.criteria[k].status.toUpperCase().padEnd(8)}${k}${rep.criteria[k].reasons.map((r) => `\n          ${r}`).join("")}`);
  console.log(rep.pass ? "GRADE: pass" : "GRADE: fail");
  process.exit(rep.pass ? 0 : 1);
}
