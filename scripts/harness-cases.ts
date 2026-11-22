// Dev script, never run by a test: builds the conformance cases of the built-in harnesses under public-kit/harness/cases/<key>/ from the real
// recordings under platforms/, and the worked example under public-kit/harness/examples/toyagent/. The recording lines and the files come from the
// recordings (trimmed to what a case needs); the expected sections are what today's code makes of them, written once and then committed. A change
// to those sections is a behaviour change: read the diff before committing it.
//   node --import ./scripts/test-bootstrap.ts scripts/harness-cases.ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RECORDINGS, rewritePaths, type Recording } from "../test/hook-real-recordings.ts";
import { CASE_SCHEMA, checkCaseShape, normalizedProjection, replayCase, type HarnessCase } from "../src/harness-cmd/test.ts";

const ROOT = path.join(import.meta.dirname, "..");
const KIT = path.join(ROOT, "public-kit", "harness");

interface Spec {
  recording: string;
  /** The key of the harness the case is for (the host the hook ran as). */
  harness: string;
  name: string;
  level: HarnessCase["level"];
  /** Zero-based lines of the recording kept, in order. */
  keep: number[];
  description: string;
}

const SPECS: Spec[] = [
  { recording: "claude-2.1.302", harness: "claude", name: "shell-writes-file", level: "L2", keep: [0, 1, 2, 3, 4, 5, 6, 7], description: "Claude Code 2.1.302: a prompt, a shell call that reads data.csv, a shell call whose awk writes totals.csv, then the stop. The whole recording; the session transcript is left out, so no call words are read." },
  { recording: "codex-0.164.0-alpha.11.1", harness: "codex", name: "shell-writes-and-fails", level: "L2", keep: [0, 1, 4, 5, 6, 7, 26], description: "Codex 0.164 (run 2): a prompt, a shell call that writes a.txt, a shell call that fails, then the stop. The model-request events, the helper's lines and the rollout files are left out." },
  { recording: "codex-0.164.0-alpha.11.1", harness: "codex", name: "helper-writes-file", level: "L2", keep: [0, 1, 10, 11, 13, 16, 18, 19, 22, 23, 26], description: "Codex 0.164 (run 2): the main thread starts a helper, the helper's shell call writes b.txt, the helper stops. The model-request events, the main thread's own calls and the rollout files are left out." },
  { recording: "codex-0.169.0-apply-patch", harness: "codex", name: "apply-patch-writes-files", level: "L2", keep: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], description: "Codex 0.169: apply_patch adds notes.txt and updates data.csv between two shell reads. The whole recording; the rollout is left out." },
  { recording: "copilot-cli-1.0.103", harness: "copilot", name: "helper-writes-file", level: "L2", keep: [1, 5, 8, 30, 31, 32, 37, 41, 43, 55, 56, 57], description: "Copilot CLI 1.0.103: one task call starts a helper, the helper's apply_patch creates memo.md, the helper stops, then a shell call fails. Two of the three parallel helpers and their calls are left out." },
  { recording: "copilot-cli-1.0.98-camel", harness: "copilot", name: "camel-case-patch-and-failure", level: "L2", keep: [0, 1, 3, 5, 6, 8, 29], description: "Copilot CLI 1.0.98 (camelCase event names): apply_patch creates a.txt, a shell call fails, the agent stops. The permission and prompt-transform events are left out." },
  { recording: "copilot-vscode-1.140.0-control", harness: "copilot", name: "vscode-helper-writes-file", level: "L2", keep: [0, 1, 9, 10, 11, 12, 13, 14, 35, 40, 50, 52, 56, 57], description: "Copilot in VS Code 1.140: three task calls start three helpers; the memo helper's apply_patch creates memo.md and it stops. The other helpers' calls and the notification events are left out." },
];

const rec = (name: string): Recording => RECORDINGS.find((r) => r.name === name) ?? (() => { throw new Error(`no recording ${name}`); })();

async function build(s: Spec): Promise<HarnessCase> {
  const r = rec(s.recording);
  const lines = readFileSync(path.join(ROOT, "platforms", r.file), "utf8").split("\n").filter((l) => l !== "");
  const recording: HarnessCase["recording"] = [];
  const writes: Array<{ afterEvent: number; path: string; content: string }> = [];
  for (const [n, i] of s.keep.entries()) {
    const text = rewritePaths(lines[i]!, "<folder>", "<root>");
    const wire = r.wire(JSON.parse(text));
    delete wire.stdin.transcript_path;
    delete wire.stdin.transcriptPath;
    const stdin = JSON.stringify(wire.stdin);
    if (/\/var\/folders|\/Users\/|\/private\//.test(stdin)) throw new Error(`${s.recording} line ${i}: a recorded path is left in the case`);
    recording.push({ event: wire.event ?? String(wire.stdin.hook_event_name ?? wire.stdin.hookEventName), stdin, argv: wire.event === undefined ? [] : ["--event", wire.event] });
    for (const w of r.writes(wire, i)) {
      if (typeof w.data !== "string") throw new Error("binary stand-in");
      writes.push({ afterEvent: n + 1, path: w.file, content: w.data });
    }
  }
  const before = Object.fromEntries(Object.entries(r.setup ?? {}).map(([f, d]) => [f, String(d)]));
  const c: HarnessCase = { schema: CASE_SCHEMA, harness: s.harness, description: s.description, level: s.level, recording, files: { ...(Object.keys(before).length > 0 ? { before } : {}), ...(writes.length > 0 ? { writes } : {}) }, expect: { normalized: recording.map(() => ({})), credit: {} } };
  return fill(c);
}

/** Writes the expected sections from what the code does today. */
async function fill(c: HarnessCase, manifest?: string): Promise<HarnessCase> {
  const seen = await replayCase(c, manifest);
  if (seen.fatal !== undefined) throw new Error(`${c.description}: ${seen.fatal}`);
  c.expect.normalized = seen.normalized.map(normalizedProjection);
  c.expect.credit = Object.fromEntries(Object.entries(seen.credit).filter(([, v]) => v.creditedTo.startsWith("call:")));
  const shape = checkCaseShape(c);
  if (typeof shape === "string") throw new Error(`${c.description}: ${shape}`);
  return c;
}

const put = (file: string, c: HarnessCase): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(c, null, 2)}\n`);
  console.log(`${path.relative(ROOT, file)}: ${c.level}, credit ${JSON.stringify(c.expect.credit)}`);
};

for (const s of SPECS) put(path.join(KIT, "cases", s.harness, `${s.name}.json`), await build(s));

// The worked example: the toy harness, as an outsider would ship it.
const TOY = path.join(ROOT, "test", "fixtures", "harnesses", "toyagent");
const toyDir = path.join(KIT, "examples", "toyagent");
mkdirSync(path.join(toyDir, "recordings"), { recursive: true });
writeFileSync(path.join(toyDir, "cocheck-harness.json"), readFileSync(path.join(TOY, "cocheck-harness.json")));
const toyLines = readFileSync(path.join(TOY, "payloads.jsonl"), "utf8").split("\n").filter((l) => l !== "");
writeFileSync(path.join(toyDir, "recordings", "payloads.jsonl"), `${toyLines.join("\n")}\n`);
const toyRecording = toyLines.map((l) => {
  const w = JSON.parse(l) as { event: string; stdin: unknown };
  return { event: w.event, stdin: JSON.stringify(w.stdin), argv: ["--event", w.event] };
});
const toyWrite = toyLines.map((l) => JSON.parse(l) as { event: string; stdin: { tool?: { name?: string; args?: string } } }).flatMap((w, i) => (w.event === "beforeTool" && w.stdin.tool?.name === "write_file" ? [{ afterEvent: i + 1, path: "notes.txt", content: String((JSON.parse(w.stdin.tool.args!) as { content: string }).content) }] : []));
const toyCase: HarnessCase = { schema: CASE_SCHEMA, harness: "toyagent", description: "Toy Agent: a prompt, a read, a write that creates notes.txt, a shell call, then the closing message. Its payloads carry no call id, so the ids in the credit are the ones CoCheck makes up (one per call, in order).", level: "L2", recording: toyRecording, files: { before: { "data.txt": "a,b,c\n" }, writes: toyWrite }, expect: { normalized: toyRecording.map(() => ({})), credit: {} } };
put(path.join(toyDir, "cases", "write-notes.json"), await fill(toyCase, path.join(toyDir, "cocheck-harness.json")));
