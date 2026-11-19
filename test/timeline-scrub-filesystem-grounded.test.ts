// where text alone cannot tell a path from words, the filesystem decides (definition above the path shapes in
// src/timeline/timeline.ts). "<folder>, words" splits off the folder only when no entry beside the folder carries those words; a glued home
// root is a path only when that home is on disk; web URLs are never paths; home variables are the home; closing brackets stay.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildTimeline, type PathLook } from "../src/timeline/timeline.ts";
import { call, prompt, stop, fakeLook } from "./fixtures/timeline.ts";

// The text goes in as a helper's brief (the surface where paths show); the shown brief is returned. `look: "real"` reads the disk.
function brief(folder: string, text: string, look: PathLook | "real" = fakeLook(), platform?: "win32"): string {
  const real = Object.getOwnPropertyDescriptor(process, "platform")!;
  if (platform) Object.defineProperty(process, "platform", { value: platform });
  try {
    const t = buildTimeline({
      taskId: 1, build: "test-build", folder, valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: true,
      ...(look === "real" ? {} : { look }),
      ops: [call("k0", { tool: "Agent", desc: "helper", at: 10, extra: { startSeq: 2, toolLabel: { fields: { subagent_type: "general-purpose", description: "helper", prompt: text } } } }), prompt("s1", ["go"]), stop("s1", "ok")],
      fileStates: [],
    });
    return t.requests.flatMap((r) => r.runs.flatMap((u) => u.calls.map((c) => c.brief ?? "")))[0]!;
  } finally {
    Object.defineProperty(process, "platform", real);
  }
}

const C = "/Users/user/Clients/Smith";
const CLIENTS = "/Users/user/Clients";
const W = "/Users/user/Desktop/Work";
const WR = "C:\\Users\\John Smith\\proj";
const R = "/Users/user/Desktop/CoCheck Testing/copilot-run";
const COPILOT = `Working directory is ${R}. Create t09/helper-file.txt with initial content, ensuring t09 exists. Do not modify any other files.`;
const COPILOT_SHOWN = "Working directory is copilot-run. Create t09/helper-file.txt with initial content, ensuring t09 exists. Do not modify any other files.";
const SIBLINGS = [`${C}, Jane/will.pdf`, `${C}. Jane/will.pdf`, `${C}; old/notes.txt`];

describe("the folder's name running on into a sibling on disk", () => {
  const look = fakeLook({ [CLIENTS]: ["Smith", "Smith, Jane", "Smith. Jane", "Smith; old", "Smith, Jane notes"] });
  for (const p of SIBLINGS) {
    it(`sibling there: ${p}`, () => assert.equal(brief(C, `Read ${p} now.`, look), "Read [outside path] now."));
  }
  it("sibling there, the folder match ends before the sibling's words", () => {
    assert.equal(brief(C, `Open ${C}, Jane notes now.`, look), "Open [outside path] now.");
  });
  it("sibling directory unreadable: fails closed (cut whole)", () => {
    const shut = fakeLook({ [CLIENTS]: null });
    for (const p of SIBLINGS) assert.equal(brief(C, `Read ${p} now.`, shut), "Read [outside path] now.");
    assert.equal(brief(R, COPILOT, fakeLook({ "/Users/user/Desktop/CoCheck Testing": null })), "Working directory is [outside path] with initial content, ensuring t09 exists. Do not modify any other files.");
  });
  it("win32: sibling there is hidden, absent shows the folder and the words", () => {
    const there = fakeLook({ "C:/Users/John Smith": ["proj", "proj, Private"] }, "C:\\Users\\John Smith");
    assert.equal(brief(WR, `Read ${WR}, Private\\x.pdf now.`, there, "win32"), "Read [outside path] now.");
    const absent = fakeLook({ "C:/Users/John Smith": ["proj"] }, "C:\\Users\\John Smith");
    assert.equal(brief(WR, `Read ${WR}, Private\\x.pdf now.`, absent, "win32"), "Read proj, Private\\x.pdf now.");
  });
});

describe("no sibling on disk: the folder splits off and the words stay", () => {
  const look = fakeLook({ [CLIENTS]: ["Smith", "Jones"] });
  it("comma, period, semicolon", () => {
    assert.equal(brief(C, `Read ${C}, Jane/will.pdf now.`, look), "Read Smith, Jane/will.pdf now.");
    assert.equal(brief(C, `Read ${C}. Jane/will.pdf now.`, look), "Read Smith. Jane/will.pdf now.");
    assert.equal(brief(C, `Read ${C}; old/notes.txt now.`, look), "Read Smith; old/notes.txt now.");
  });
  it("the original Copilot brief", () => {
    assert.equal(brief(R, COPILOT, fakeLook({ "/Users/user/Desktop/CoCheck Testing": ["copilot-run", "older run"] })), COPILOT_SHOWN);
  });
});

describe("real directories (temp), read by the default filesystem view", () => {
  const made = (withSibling: boolean): string => {
    const root = mkdtempSync(path.join(tmpdir(), "cocheck-scrub-fs-"));
    mkdirSync(path.join(root, "Clients", "Smith"), { recursive: true });
    if (withSibling) {
      mkdirSync(path.join(root, "Clients", "Smith, Jane"));
      writeFileSync(path.join(root, "Clients", "Smith, Jane", "will.pdf"), "x");
    }
    return path.join(root, "Clients", "Smith");
  };
  it("\"Smith, Jane\" on disk is hidden", () => {
    const f = made(true);
    const out = brief(f, `Read ${f}, Jane${path.sep}will.pdf now.`, "real");
    assert.equal(out, "Read [outside path] now.");
  });
  it("\"Smith, Jane\" not on disk: the folder and the words show", () => {
    const f = made(false);
    assert.equal(brief(f, `Read ${f}, Jane${path.sep}will.pdf now.`, "real"), `Read Smith, Jane${path.sep}will.pdf now.`);
  });
});

describe("over-masking regressions return to main's output", () => {
  for (const s of [
    "Edit pages/home/components/Hero.tsx and src/app/page.tsx now.",
    "Edit pages/home/components/Hero.tsx so the title is bigger, then run the tests.",
    "See https://github.com/Users/foo/bar and http://example.com/a/b for details.",
    "The regex /usr|bin/ and the date 2026/11/02 and v1.2/v1.3.",
  ]) it(s, () => assert.equal(brief(W, s), s));
  it("a glued home that is on disk, or can't be checked, is still a path", () => {
    assert.equal(brief(W, "Then x/Users/user/Documents/My Taxes/x.pdf now."), "Then x[outside path] now.");
    assert.equal(brief(W, "Then pages/home/x/Users/user/secret.pdf now."), "Then pages/home/x[outside path] now.");
    assert.equal(brief(W, "Edit pages/home/components/Hero.tsx now.", fakeLook({ "/home": null })), "Edit pages[outside path] now.");
    assert.equal(brief(W, "Edit pages/home/components/Hero.tsx now.", fakeLook({ "/home": ["components"] })), "Edit pages[outside path] now.");
  });
  it("a path after a URL is still read", () => {
    assert.equal(brief(W, "See https://example.com/x and /Users/user/Documents/My Taxes/x.pdf now."), "See https://example.com/x and [outside path] now.");
  });
});

describe("home variables are the home", () => {
  it("posix: $HOME and ${HOME}", () => {
    assert.equal(brief(W, "Read $HOME/Documents/My Taxes/x.pdf now."), "Read [outside path] now.");
    assert.equal(brief(W, `Read ${W}/a.txt and $HOME/Documents/My Taxes/x.pdf now.`), "Read a.txt and [outside path] now.");
    assert.equal(brief(W, "Read ${HOME}/Documents/My Taxes/x.pdf now."), "Read [outside path] now.");
    assert.equal(brief(W, "Read $HOME/Desktop/Work/a.txt now."), "Read a.txt now.");
    assert.equal(brief(W, "Then echo $HOME and $HOMEBREW now."), "Then echo $HOME and $HOMEBREW now.");
  });
  it("win32: %USERPROFILE%", () => {
    const look = fakeLook({}, "C:\\Users\\John Smith");
    assert.equal(brief(WR, `Read ${WR}\\a.txt then %USERPROFILE%\\Documents\\My Taxes\\x.txt now.`, look, "win32"), "Read a.txt then [outside path] now.");
    assert.equal(brief(WR, "Read %USERPROFILE%\\proj\\a.txt now.", look, "win32"), "Read a.txt now.");
  });
});

describe("closing brackets after a masked path stay", () => {
  it("posix", () => {
    assert.equal(brief(W, `Read ${W}/a.txt and «/Users/user/Documents/My Taxes/x.pdf» now.`), "Read a.txt and «[outside path]» now.");
    assert.equal(brief(W, `Read ${W}/a.txt and [/Users/user/Documents/My Taxes/x.pdf] now.`), "Read a.txt and [[outside path]] now.");
    assert.equal(brief(W, `Read ${W}/a.txt and {/Users/user/Documents/My Taxes/x.pdf} now.`), "Read a.txt and {[outside path]} now.");
    assert.equal(brief(W, "Read «/Users/user/Documents/My Taxes/x.pdf» now."), "Read «[outside path]» now.");
  });
  it("win32", () => {
    assert.equal(brief(WR, "Read «C:\\Users\\user\\My Taxes\\x.pdf» now.", fakeLook(), "win32"), "Read «[outside path]» now.");
    assert.equal(brief(WR, "Read [C:\\Users\\user\\My Taxes\\y.pdf] now.", fakeLook(), "win32"), "Read [[outside path]] now.");
    assert.equal(brief(WR, "Read (C:\\Users\\user\\My Taxes\\y.pdf) now.", fakeLook(), "win32"), "Read ([outside path]) now.");
  });
});

describe("an outside path under an unknown root whose directory is not on disk is cut whole", () => {
  it("/srv/data/My Taxes", () => {
    assert.equal(brief(W, `Read ${W}/a.txt and /srv/data/My Taxes/x.pdf now.`), "Read a.txt and [outside path] now.");
    assert.equal(brief(W, "Read /srv/data/My Taxes/x.pdf now."), "Read [outside path] now.");
  });
  it("words under an existing root stay", () => {
    assert.equal(brief(W, "Use 1/2 cup, /2 and/or 3/4 of it."), "Use 1/2 cup, /2 and/or 3/4 of it.");
  });
});

describe("review pass 3: a local path inside a URL is still a path", () => {
  const S = "/Users/user/code/site";
  it("a query value, on any host", () => {
    assert.equal(brief(S, "Open http://127.0.0.1:8080/open?file=/Users/user/Documents/Taxes/x.pdf now."), "Open http://127.0.0.1:8080/open?file=x.pdf now.");
    assert.equal(brief(S, "Open https://x.test/?p=/Users/user/Documents/Taxes/x.pdf now."), "Open https://x.test/?p=x.pdf now.");
    assert.equal(brief(S, "Open https://x.test/?a=1&p=/Users/user/Documents/My Taxes/x.pdf now."), "Open https://x.test/?a=1&p=[outside path] now.");
    assert.equal(brief(S, "Open https://x.test/?p=C:\\Users\\user\\Taxes\\x.pdf now."), "Open https://x.test/?p=[outside path] now.");
  });
  it("the path after a host that may be this machine", () => {
    assert.equal(brief(S, "Open http://localhost:8000/Users/user/Documents/Taxes/x.pdf now."), "Open http://localhost:8000/x.pdf now.");
    assert.equal(brief(S, "Open http://mybox/Users/user/Documents/My Taxes/x.pdf now."), "Open http://mybox/[outside path] now.");
    assert.equal(brief(S, "Open http://Ana-Mac.local:3000/Users/user/code/site/a.txt now."), "Open http://Ana-Mac.local:3000/a.txt now.");
  });
  it("a remote host's own path, and a local URL's app path, stay", () => {
    for (const s of ["See https://github.com/Users/foo/bar now.", "See http://localhost:3000/api/v1/items?id=4 now.", "See https://example.com/a/b?next=page now."]) assert.equal(brief(S, s), s);
  });
});

describe("review pass 3: an unknown root reads nothing below \"/\"", () => {
  it("a deeper head is cut whole and its directory is never listed", () => {
    const seen: string[] = [];
    const base = fakeLook();
    const look: PathLook = { list: (d) => (seen.push(d), base.list(d)), home: base.home };
    assert.equal(brief(W, "Read /data/clients/acme/secret plans/x.pdf now.", look), "Read [outside path] now.");
    assert.ok(!seen.some((d) => d.startsWith("/data")), seen.join(", "));
  });
  it("a folder under an unknown root still splits off its words", () => {
    const F = "/workspace/copilot-run";
    assert.equal(brief(F, `Working directory is ${F}. Create t09/helper-file.txt with initial content.`, fakeLook({ "/workspace": ["copilot-run"] })), "Working directory is copilot-run. Create t09/helper-file.txt with initial content.");
  });
});

describe("review pass 4: a fragment holding a path", () => {
  const S = "/Users/user/code/site";
  const P = "/Users/user/Documents/Taxes/x.pdf";
  it("'#' reads like '?' for values, and a fragment starting at a root is a path", () => {
    assert.equal(brief(S, `Open http://localhost:3000/#${P} now.`), "Open http://localhost:3000/#x.pdf now.");
    assert.equal(brief(S, `Open http://localhost/open#file=${P} now.`), "Open http://localhost/open#file=x.pdf now.");
  });
  it("route fragments stay", () => {
    for (const s of ["See https://x.test/app#/settings/profile now.", "See https://github.com/a/b#L10 now."]) assert.equal(brief(S, s), s);
  });
});
