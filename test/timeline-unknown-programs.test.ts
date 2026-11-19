import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { callReadsUnknown, jsReadsUnknown } from "../src/timeline/read-signal.ts";

// A call that runs a program whose reads CoCheck does not judge is "unknown" (a false clean is the guarded case); plain no-read commands and the earlier-recognised shapes are not.

const unk = (cmd: string, stored: Record<string, string> = {}): boolean => callReadsUnknown({ tool: "Bash", command: cmd, input: { command: cmd } }, (n) => (n in stored ? [stored[n]!] : []));

describe("jsReadsUnknown", () => {
  const unknown: Array<[string, string]> = [
    ["a variable path read", 'const fs = require("fs");\nfor (const f of files) fs.readFileSync(f);\n'],
    ["a template path with a substitution", 'fs.readFileSync(`data/${k}.csv`, "utf8");\n'],
    ["readFile on a join with a loop name", 'for (const n of names) fs.readFile(path.join(__dirname, "data", n), cb);\n'],
    ["a name assigned from argv", 'const p = process.argv[2];\nfs.readFileSync(p);\n'],
    ["a child process", 'const { execSync } = require("child_process");\nexecSync("python3 x.py");\n'],
    ["a createReadStream of a variable", 'fs.createReadStream(inputPath);\n'],
  ];
  for (const [name, src] of unknown) it("is unknown for" + name, () => assert.equal(jsReadsUnknown(src), true));
  const known: Array<[string, string]> = [
    ["literal readFileSync", 'const fs = require("fs");\nconst d = JSON.parse(fs.readFileSync("data/a.json", "utf8"));\n'],
    ["a name assigned a literal", 'const P = "data/a.csv";\nfs.readFileSync(P);\n'],
    ["a join of literals under __dirname", 'fs.readFileSync(path.join(__dirname, "data", "a.csv"));\n'],
    ["no reads at all", 'const p = require("pptxgenjs");\nnew p().writeFile({ fileName: "out.pptx" });\n'],
    ["a read in a comment only", '// fs.readFileSync(name)\nconsole.log(1);\n'],
    ["a write with a computed path", 'fs.writeFileSync(out, "x");\n'],
  ];
  for (const [name, src] of known) it("is not unknown for" + name, () => assert.equal(jsReadsUnknown(src), false));
});

describe("callReadsUnknown", () => {
  it("node deck.js with a variable path read is unknown, with literal reads it is judged clean", () => {
    assert.equal(unk("node deck.js", { "deck.js": "const p = process.argv[2];\nfs.readFileSync(p);" }), true);
    assert.equal(unk("node deck.js", { "deck.js": 'fs.readFileSync("data/a.csv");' }), false);
    assert.equal(unk("node -e 'fs.readFileSync(f)'"), true);
    assert.equal(unk("cat > m.js <<'EOF'\nfor (const f of fs) fs.readFileSync(f)\nEOF\nnode m.js"), true);
  });
  it("bash or sh running a script file is unknown, whatever its text", () => {
    assert.equal(unk("bash run.sh", { "run.sh": "python3 build.py" }), true);
    assert.equal(unk("sh ./run.sh"), true);
    assert.equal(unk("cd out && /bin/bash scripts/run.sh --fast"), true);
    assert.equal(unk("bash -c 'python3 build.py'"), true);
    assert.equal(unk("bash <<EOF\npython3 build.py\nEOF"), true);
  });
  it("a script launched by shebang path is judged by its text, and missing text is unknown", () => {
    assert.equal(unk("./build.py", { "build.py": "open('data/a.csv').read()\n" }), false);
    assert.equal(unk("./build.py", { "build.py": "k=3\nopen(f'data/{k}.csv').read()\n" }), true);
    assert.equal(unk("./build.py"), true);
    assert.equal(unk("./deck.js", { "deck.js": "#!/usr/bin/env node\nfs.readFileSync(f)" }), true);
    assert.equal(unk("./go", { go: "#!/bin/sh\npython3 x.py" }), true);
    assert.equal(unk("cat > b.py <<EOF\n#!/usr/bin/env python3\nopen('a.csv')\nEOF\nchmod +x b.py && ./b.py"), false);
  });
  it("an interpreter with no reader is unknown", () => {
    assert.equal(unk("ruby build.rb", { "build.rb": "puts 1" }), true);
    assert.equal(unk("perl -e 'print 1'"), true);
    assert.equal(unk("osascript build.scpt"), true);
    assert.equal(unk("python3.14 build.py"), true);
    assert.equal(unk("python3.14 build.py", { "build.py": "open('a.csv')" }), false);
  });
  it("known no-read commands and the earlier-recognised shapes stay not unknown", () => {
    for (const c of ["ls -la", "echo hi > a.txt", "mkdir -p out", "cp a.csv b.csv", "mv a b", "python3 -m venv .venv", "python3.14 -m venv -q .venv", ".venv/bin/python3 -m pip install pandas", "python3 -m http.server 8000", "bash -c 'ls && echo hi'", "./node_modules/.bin/tsc --noEmit", "/usr/bin/ls /tmp", "git status", "cd out && ls", "curl -sL https://x -o a.csv"]) assert.equal(unk(c), false, c);
    assert.equal(unk("cat > m.js <<'EOF'\nconsole.log(1)\nEOF\nnode m.js"), false);
    assert.equal(unk("node deck.js && python3 $SK/scripts/office/validate.py out.pptx", { "deck.js": "const p = require('pptxgenjs');" }), false);
    assert.equal(unk("bash $SK/scripts/run.sh"), true, "a shell script by a variable path is unread text");
    assert.equal(unk("python3 build.py"), true);
  });
});

// The first word decides, and anything unjudged is unknown (the guarded case is a clean answer for a read CoCheck cannot see).
describe("first word and the closed lists", () => {
  const osa = (...e: string[]): string => "osascript " + e.map((x) => `-e '${x}'`).join(" ");
  const unknown: string[] = [
    "osascript -lJavaScript -e '$.NSString.stringWithContentsOfFile(\"x\")'",
    "osascript -l JavaScript -e '$.NSString.stringWithContentsOfFile(\"x\")'",
    ...["Finder", "System Events", "TextEdit", "Numbers", "Microsoft Excel"].flatMap((a) => [osa(`tell application "${a}" to get contents of file "x"`), osa(`tell application "${a}" to get text of document 1`), osa(`tell application "${a}" to get value of cell "A1"`)]),
    osa('open POSIX file "/x.csv"'),
    osa('tell application "Microsoft Excel" to open POSIX file "/x.csv"'),
    osa("save active workbook"),
    osa('tell application "Microsoft Excel" to save active workbook'),
    osa('tell application "Microsoft Excel" to close active workbook saving yes'),
    osa("close active workbook saving yes"),
    osa('do shell script "cat x"'),
    osa('tell application "Finder" to quit -- note'),
    osa('tell application "Finder"', "-- comment", "quit", "end tell"),
    osa('tell application "Finder"', "get name of every file", "end tell"),
    osa('tell application "Finder"', "quit"),
    "echo 'tell application \"Finder\" to quit' | osascript",
    "osascript < x.scpt",
    "osascript <<EOF\ntell application \"Finder\" to quit\nEOF",
    "source ./build/activate",
    "source run.sh",
    ". ./run.sh",
    "source",
    "npm run build", "npm test", "yarn build", "pnpm install", "make", "just build", "go run main.go", "cargo run",
    'eval "$X"',
    "cat x.py | python3", "curl -s https://x | sh", "cat x.js | node", "cat x | bash",
    "find . -exec python3 {} \\;", "find . -name '*.py' -execdir python3 {} +", "xargs python3", "ls *.py | xargs -n 1 python3", "find . -exec ls {} \\; -exec python3 {} \\;",
    "npx cowsay hi", "npx -y prettier x.js", "npx -c 'ls'",
    "ruby x.rb", "perl x.pl", "php x.php", "Rscript x.R", "swift x.swift",
    "bash run.sh", "sh ./run.sh", "zsh run.sh", "bash < run.sh",
    "env FOO=1 bash run.sh", "sudo -u root bash run.sh", "time nohup exec bash run.sh", "FOO=1 ruby x.rb", "uv run ruby x.rb", "poetry run make",
  ];
  for (const c of unknown) it("is unknown for" + JSON.stringify(c), () => assert.equal(unk(c), true));
  const clean: string[] = [
    "source .venv/bin/activate", "source venv/bin/activate", ". ./.venv/bin/activate", "source /x/y/.venv/bin/activate && python3 -m pip install pandas",
    osa('tell application "Microsoft Excel" to quit'),
    osa('tell application "Microsoft Excel" to activate'),
    osa('tell application "Microsoft Excel" to close active workbook saving no'),
    osa('tell application "Microsoft Excel" to close every workbook saving no'),
    osa('tell application "Microsoft Word" to close front window'),
    osa('tell application "Numbers" to close document 1 saving no'),
    osa('tell application "Numbers" to close document "a.numbers"'),
    osa('tell application "Microsoft Excel"', "activate", "close active workbook saving no", "end tell"),
    osa('tell application "Microsoft Excel" to quit', 'tell application "Finder" to activate'),
    "which node python3", "which ruby perl", "type -a python3 node", "echo ruby x.rb", "command -v bash", "ls make", "git log --oneline -- make",
    "npm install", "npm ls", "go build ./...", "cargo build", "npx tsx -e 'console.log(1)'", "npx -y ts-node -e 'console.log(1)'",
    "uv run python3 -c 'print(1)'", "poetry run python3 -c 'print(1)'", "env -u FOO python3 -c 'print(1)'", "sudo -u root python3 -c 'print(1)'", "time python3 -c 'print(1)'",
    "tsx -e 'console.log(1)'", "ts-node -e 'fs.readFileSync(\"a.json\")'", "xargs python3 -c 'print(1)'", "xargs ls", "find . -name '*.py'", "find . -exec ls {} \\;",
    "git status | cat",
  ];
  for (const c of clean) it("is not unknown for" + JSON.stringify(c), () => assert.equal(unk(c), false));
  it("tsx and ts-node are judged by their text like node", () => {
    assert.equal(unk("tsx run.ts", { "run.ts": "fs.readFileSync(f)" }), true);
    assert.equal(unk("ts-node run.ts", { "run.ts": 'fs.readFileSync("a.json")' }), false);
    assert.equal(unk("npx tsx run.ts", { "run.ts": "fs.readFileSync(f)" }), true);
    assert.equal(unk("npx tsx run.ts"), true);
  });
  it("a runner is counted behind env, sudo, time, nohup, exec and VAR=x", () => {
    assert.equal(unk("env A=1 sudo nohup python3 build.py"), true);
    assert.equal(unk("A=1 exec python3 build.py", { "build.py": "open('a.csv')" }), false);
  });
  it("a multi-line quoted script is read as one script", () => {
    assert.equal(unk('python3 -c "\nimport pandas as pd\npd.read_csv(f)\n"'), true);
    assert.equal(unk('python3 -c "\nimport pandas as pd\npd.read_csv(\'a.csv\')\n"'), false);
    assert.equal(unk('osascript -e "tell application \\"Microsoft Excel\\" to quit"'), false);
  });
  it("a recorded intent is clean", () => {
    assert.equal(unk(readFileSync(new URL("./fixtures/long-intent.txt", import.meta.url), "utf8")), false);
  });
  it("the op 1403 intent turns unknown when a read it cannot name is added", () => {
    const base = readFileSync(new URL("./fixtures/long-intent.txt", import.meta.url), "utf8");
    assert.equal(unk(base + "\nbash $D/run.sh"), true);
    assert.equal(unk(base.replace("saving no", "saving yes")), true);
    assert.equal(unk(base.replace("pd.read_csv('us_gdp.csv')", "pd.read_csv(sys.argv[1])")), true);
  });
});
