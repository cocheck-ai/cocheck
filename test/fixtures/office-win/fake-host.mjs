// A fake of src/office/connector/office-win.ps1 for the office-win tests: the same JSON-lines protocol (request {id, op, args}, reply
// {id, ok:true, ...} or {id, ok:false, why}), run by node so it works on every OS. argv[2] is the mode: "full" (FullLanguage),
// "constrained" (hello answers ConstrainedLanguage), "stubborn" (FullLanguage, but stays up after `exit` and after stdin ends), "bootstrap-restricted" (prints the loader's restricted line and exits, as the
// real loader does before it reads the .ps1). argv[3], when given, is a file that gets "eof" written when stdin ends.
// "office": argv[3] is a JSON state file, re-read before and written after every op, so a test can change the world between calls.
// It answers the lifecycle ops (isRunning, launch, ready, documentCount, quit, procInfo) by the same rules as office-win.ps1, on a simulated
// process table: {procs:[{pid,image,startedAtMs,visible}], spawnOnLaunch:{<app>:[{pid,startOffsetMs}]}, docs:{<app>:n},
// userControl:{<app>:bool}, unreadable:[pid], apps:{<app>:{pid,startedAtMs,props}}, log:[...]}. Every op and every COM touch is logged.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

const mode = process.argv[2] ?? "full";
const marker = process.argv[3];
const send = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
if (mode === "bootstrap-restricted") {
  send({ id: null, ok: false, why: "restricted", mode: "ConstrainedLanguage" });
  process.exit(0);
}
// The export ops: `stub` sets $script:Apps (apps launched by "this host", each {active, readBack?, docs?, hang?}) and the HKCU
// Devices values; `log` answers every request received and every COM call the stand-in Office got, each argument with the type
// the .ps1 casts it to ({t, v}). exportPdf mirrors the .ps1's per-app sequence (office-win.ps1, "export ops" section).
let stub = { apps: {}, devices: {} };
const reqs = [];
const com = [];
const s = (v) => ({ t: "string", v });
const n = (v) => ({ t: "int", v });
const b = (v) => ({ t: "bool", v });
const NO_PRINTER = { ok: false, why: "no local PDF printer", caveat: "no-local-pdf-printer" };
const NO_SETUP = { ok: false, why: "PDF printer setup did not take", caveat: "pdf-printer-setup-failed" };
let wordPrinter = null;
const readBack = (app, set) => (app.readBack !== undefined ? app.readBack : set);
const readBackOk = (got, p, bareOk) => p != null && (got === p.full || (bareOk && got === p.name));
const mk = (a) => { com.push({ call: "MkDir", args: [s(path.dirname(a.pdf))] }); mkdirSync(path.dirname(a.pdf), { recursive: true }); };
function exportPdf(a) {
  const app = stub.apps[a.app];
  if (!app) return { ok: false, why: "not launched" };
  const p = a.printer;
  if (a.app === "powerpoint") {
    com.push({ call: "Presentations.Open", args: [s(a.input), n(-1), n(0), n(0)] });
    mk(a);
    com.push({ call: "SaveCopyAs", args: [s(a.pdf), n(32)] });
    com.push({ call: "Close", args: [] });
    return { ok: true };
  }
  if (p == null) return NO_PRINTER;
  if (a.app === "word") {
    if (wordPrinter !== p.full) {
      com.push({ call: "FilePrintSetup", args: [s(p.full), n(1)] });
      const got = readBack(app, p.name); // Word reads back the bare name
      com.push({ call: "ActivePrinter?", args: [] });
      if (!readBackOk(got, p, true)) return NO_SETUP;
      wordPrinter = p.full;
    }
    com.push({ call: "Documents.Open", args: [s(a.input), b(false), b(true), b(false), s("cocheck-no-password")] });
    mk(a);
    com.push({ call: "ExportAsFixedFormat", args: [s(a.pdf), n(17)] });
    com.push({ call: "Close", args: [n(0)] });
    return { ok: true };
  }
  com.push({ call: "Workbooks.Open", args: [s(a.input), n(0), b(true), { t: "missing", v: null }, s("cocheck-no-password")] });
  com.push({ call: "ActivePrinter=", args: [s(p.full)] });
  const got = readBack(app, p.full);
  com.push({ call: "ActivePrinter?", args: [] });
  if (!readBackOk(got, p, false)) { com.push({ call: "Close", args: [b(false)] }); return NO_SETUP; }
  mk(a);
  com.push({ call: "ExportAsFixedFormat", args: [n(0), s(a.pdf)] });
  com.push({ call: "Close", args: [b(false)] });
  return { ok: true };
}
const IMAGE = { excel: "EXCEL", word: "WINWORD", powerpoint: "POWERPNT" };
function officeOp(id, op, args) {
  const st = JSON.parse(readFileSync(marker, "utf8"));
  st.procs ??= []; st.apps ??= {}; st.log ??= [];
  // A proc with goneAtMs leaves the table once that time passes (a terminated process still dying), decided here so no second writer races the file.
  st.procs = st.procs.filter((q) => q.goneAtMs === undefined || q.goneAtMs > Date.now());
  st.log.push({ op, args });
  const key = args?.app;
  const image = IMAGE[key];
  const fail = (why) => ({ id, ok: false, why });
  const launched = () => st.apps[key];
  let r;
  if (op === "procInfo") {
    const p = st.procs.find((q) => q.pid === args.pid);
    if ((st.unreadable ?? []).includes(args.pid)) r = fail("Access is denied");
    else r = p === undefined ? { id, ok: true, gone: true } : { id, ok: true, image: p.image, startedAtMs: p.startedAtMs, visibleWindow: p.visible === true };
  } else if (image === undefined) r = fail(`unknown app: ${key}`);
  else if (op === "isRunning") r = { id, ok: true, running: st.procs.some((p) => p.image === image) };
  else if (op === "launch") {
    if (launched()) r = fail("already launched");
    else {
      const began = Date.now();
      const before = st.procs.filter((p) => p.image === image).map((p) => p.pid);
      for (const n of st.spawnOnLaunch?.[key] ?? []) st.procs.push({ pid: n.pid, image, startedAtMs: began + (n.startOffsetMs ?? 1), visible: n.visible === true });
      const fresh = st.procs.filter((p) => p.image === image && !before.includes(p.pid));
      if (fresh.length === 0) { st.log.push({ com: "released", app: key }); r = { id, ok: true, pid: null }; }
      else if (fresh.length !== 1 || fresh[0].startedAtMs < began) { st.log.push({ com: "released", app: key }); r = { id, ok: true, notOurs: true }; }
      else { st.apps[key] = { pid: fresh[0].pid, startedAtMs: fresh[0].startedAtMs, props: {} }; r = { id, ok: true, pid: fresh[0].pid, startedAtMs: fresh[0].startedAtMs }; }
    }
  } else if (!launched()) r = fail("not launched");
  else if (op === "ready") {
    const props = launched().props;
    if (key !== "powerpoint") props.Visible = false;
    props.DisplayAlerts = key === "excel" ? false : key === "word" ? 0 : 1;
    props.AutomationSecurity = 3;
    st.log.push({ com: "set", app: key, props: { ...props } });
    r = { id, ok: true, ready: true, version: "16.0" };
  } else if (op === "documentCount") r = { id, ok: true, count: st.docs?.[key] ?? 0 };
  else if (op === "quit") {
    const n = st.docs?.[key] ?? 0;
    const uc = st.userControl?.[key] === true;
    const pid = launched().pid;
    delete st.apps[key];
    if (n !== 0 || uc) { st.log.push({ com: "released", app: key }); r = { id, ok: true, refused: true, documents: n, userControl: uc }; }
    else { st.log.push({ com: "quit", app: key }); st.procs = st.procs.filter((p) => p.pid !== pid); r = { id, ok: true, quit: true }; }
  } else r = fail(`unknown op: ${op}`);
  writeFileSync(marker, JSON.stringify(st));
  return r;
}

let winReads = 0;
// exportTargets mirrors the "export targets" section of office-win.ps1. Per-app stub: `failAt: {<sheet>: "<step>"}` throws at that
// step of that sheet's setup or read-backs (PageSetup.PrintArea=, Zoom=, Draft?, Orientation=, ExportAsFixedFormat); `areaBack` is what PrintArea reads back.
const FLAGS = ["BlackAndWhite", "CenterHorizontally", "CenterVertically", "Draft"];
function exportTargets(a) {
  const app = stub.apps[a.app];
  if (!app) return { ok: false, why: "not launched" };
  if (a.app !== "excel") return { ok: false, why: "cannot print sheets one by one" };
  const p = a.printer;
  if (p == null) return NO_PRINTER;
  com.push({ call: "Workbooks.Open", args: [s(a.input), n(0), b(true), { t: "missing", v: null }, s("cocheck-no-password")] });
  let pc = true;
  const results = [];
  try {
    com.push({ call: "ActivePrinter=", args: [s(p.full)] });
    const got = readBack(app, p.full);
    com.push({ call: "ActivePrinter?", args: [] });
    if (!readBackOk(got, p, false)) return NO_SETUP;
    a.targets.forEach((t, i) => {
      const sheet = s(t.sheet);
      const step = (call, args) => { com.push({ call, sheet: t.sheet, args }); if (app.failAt?.[t.sheet] === call) throw new Error(`${call} failed`); };
      try {
        com.push({ call: "Sheets.Item", args: [sheet] });
        try {
          pc = false; com.push({ call: "PrintCommunication=", args: [b(false)] });
          if (t.kind !== "chartsheet") {
            step("PageSetup.PrintTitleRows=", [s("")]); step("PageSetup.PrintTitleColumns=", [s("")]);
            step("PageSetup.PrintArea=", [s(t.area)]);
            step("PageSetup.PrintHeadings=", [b(true)]); step("PageSetup.PrintGridlines=", [b(true)]);
            for (const f of FLAGS) step(`PageSetup.${f}=`, [b(false)]);
            step("PageSetup.Zoom=", [n(Math.max(10, Math.min(400, Math.round(t.zoom))))]);
          }
          step("PageSetup.Orientation=", [n(t.kind === "chartsheet" || t.landscape ? 2 : 1)]);
        } finally {
          pc = true; com.push({ call: "PrintCommunication=", args: [b(true)] });
          com.push({ call: "PrintCommunication?", args: [] });
        }
        let back = "";
        if (t.kind !== "chartsheet") {
          step("PageSetup.Zoom?", []);
          for (const f of FLAGS) step(`PageSetup.${f}?`, []);
          back = app.areaBack ?? t.area; com.push({ call: "PageSetup.PrintArea?", sheet: t.sheet, args: [] });
        }
        mk({ pdf: a.pdfs[i] });
        step("ExportAsFixedFormat", [n(0), s(a.pdfs[i])]);
        results.push(back !== "" ? { ok: true, readBack: back } : { ok: true });
      } catch (e) {
        results.push({ ok: false, why: e.message });
      }
    });
  } finally {
    com.push({ call: "PrintCommunication=", args: [b(true)] });
    com.push({ call: "Close", args: [b(false)] });
  }
  return { ok: true, results };
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const req = JSON.parse(line);
  const { id, op, args } = req;
  if (mode === "office" && op !== "hello" && op !== "exit") send(officeOp(id, op, args));
  else if (op !== "log" && op !== "exit" && (reqs.push({ op, args }), false)) { /* recorded for the log op */ }
  else if (op === "stub") { stub = args; send({ id, ok: true }); }
  else if (op === "log") send({ id, ok: true, reqs, com });
  else if (op === "pdfPrinter") {
    const app = stub.apps[args.app];
    send(app ? { id, ok: true, devices: stub.devices, active: app.active ?? "" } : { id, ok: false, why: "not launched" });
  } else if (op === "exportPdf") { if (!stub.apps[args.app]?.hang) send({ id, ...exportPdf(args) }); }
  else if (op === "exportTargets") send({ id, ...exportTargets(args) });
  else if (op === "openDocuments") {
    const app = stub.apps[args.app];
    send(app ? { id, ok: true, names: app.docs ?? [] } : { id, ok: false, why: "not launched" });
  }
  else if (op === "hello") send({ id, ok: true, version: "5.1.19041.4648", mode: mode === "constrained" ? "ConstrainedLanguage" : "FullLanguage" });
  else if (op === "selftest") send({ id, ok: true, retried: 1, text: "Größe 東京" });
  else if (op === "echo") send({ id, ok: true, back: args?.text });
  else if (op === "windows") {
    // Mode "windows-appear" lists one window, then a second one from the next read on (a dialog appearing); "windows-hang" never answers.
    if (mode === "windows-hang") return;
    winReads++;
    const base = { id: 5, layer: 0, title: "Deck", bounds: { x: 0, y: 0, w: 1600, h: 900 }, onscreen: true };
    const extra = { id: 91, layer: 0, title: "", bounds: { x: 400, y: 300, w: 500, h: 200 }, onscreen: true };
    // mode "windows-nested-appear": the dialog is only a nested row (UIA child of the owner window), with a duplicate handle the real op would have deduped away;
    // mode "windows-nested-before": the nested pane is there from the first read on (must not read as a prompt).
    const nested = { id: 77, layer: 0, title: "Save As", bounds: { x: 300, y: 200, w: 600, h: 400 }, onscreen: true };
    const rows = mode === "windows-appear" && winReads > 1 ? [base, extra]
      : mode === "windows-nested-appear" && winReads > 1 ? [base, nested]
      : mode === "windows-nested-before" ? [base, nested] : [base];
    send({ id, ok: true, windows: rows, pid: args?.pid });
  }
  else if (op === "hang") { /* never answers */ }
  else if (op === "late") setTimeout(() => send({ id, ok: true, late: true }), args?.ms ?? 300);
  else if (op === "exit") { send({ id, ok: true }); if (mode !== "stubborn") process.exit(0); }
  else send({ id, ok: false, why: `unknown op: ${op}` });
});
rl.on("close", () => {
  if (marker && mode !== "office") writeFileSync(marker, "eof");
  // "stubborn": a host that would outlive its client if nothing stopped it (the process-exit path must end it by pid)
  if (mode === "stubborn") setInterval(() => undefined, 1_000);
  else process.exit(0);
});
