import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { translateShell } from "../src/timeline/describe.ts";

// a failure is named only by a script or module path its error names, never by a folder made in the chain, and the first
// failing command in an && chain wins over later knock-on errors when its error text is present (recorded, calls 24 and 40).
const MEMO_ERR = "Exit code 1\nnode:internal/modules/cjs/loader:1595\n  throw err;\n  ^\n\nError: Cannot find module 'docx'\nRequire stack:\n- memo.js\n    at Module._resolveFilename (node:internal/modules/cjs/loader:1591:15)";
const DECK_ERR = "Exit code 1\nsed: 2: \"build_deck.js\n\": undefined label 'uild_deck.js'\n(eval):1: no matches found: slide-*.jpg\nI/O Error: Couldn't open file 'econ_data_deck.pdf': No such file or directory.\nTraceback (most recent call last):\n  File \"Image.py\", line 3639, in open\nFileNotFoundError: [Errno 2] No such file";

// The real recorded chains (heredoc body trimmed).
const S = "/private/tmp/x/scratch";
const MEMO = `mkdir -p /Users/t/work/fred/memo; S=${S}\ncat > $S/memo.js <<'EOF'\nconst d=require('docx');\nEOF\ncd $S && NODE_PATH=$(npm root -g) node memo.js && soffice --headless --convert-to pdf --outdir $S /Users/t/work/fred/memo/econ_data_memo.docx >/dev/null 2>&1; pdfinfo $S/econ_data_memo.pdf | grep Pages; pdftoppm -png -r 60 $S/econ_data_memo.pdf $S/pg`;
const DECK = `cd ${S} && sed -i "s/fontSize:26,valign:'top'/fontSize:26,align:'left'/; s/x:7.2,y:1.45/x:7.5,y:1.4/" build_deck.js && export NODE_PATH=$PWD/node_modules && node build_deck.js && cd r && python3 /s/soffice.py --headless --convert-to pdf /Users/t/work/fred/deck/econ_data_deck.pptx >/dev/null 2>&1; rm -f slide-*.jpg; pdftoppm -jpeg -r 80 econ_data_deck.pdf slide; python3 -c "\nfrom PIL import Image\nims=[Image.open(f'slide-{i}.jpg') for i in (1,2)]\ng.save('g2.jpg')"`;

describe("file-name rule", () => {
  it("recorded call 24: the real chain names node memo.js", () => {
    assert.equal(translateShell(MEMO, [], true, MEMO_ERR), "Ran a Node script (memo.js)");
  });
  it("recorded call 40: the real chain names the sed", () => {
    assert.equal(translateShell(DECK, [], true, DECK_ERR), "Edited build_deck.js");
  });
  it("memo chain: names node memo.js, not the memo folder", () => {
    for (const c of ["mkdir -p memo && cd memo && npm install docx && node memo.js", "mkdir -p memo && node memo.js", "mkdir -p memo && cd memo && node memo.js && ls memo"]) {
      assert.equal(translateShell(c, [], true, MEMO_ERR), "Ran a Node script (memo.js)", c);
    }
  });
  it("deck chain: names the sed, not the later pdf or python symptoms", () => {
    const c = "cd work && sed -i 's/a/b/' build_deck.js && node build_deck.js && soffice --headless --convert-to pdf econ_data_deck.pptx && pdftoppm -jpeg econ_data_deck.pdf slide && python3 grid.py";
    assert.equal(translateShell(c, [], true, DECK_ERR), "Edited build_deck.js");
  });
  it("a program named at the head of a line of the error beats later files", () => {
    assert.equal(translateShell("mkdir -p out && cp a.txt out && node run.js", [], true, "cp: a.txt: No such file or directory\nrun.js: not reached"), "Copied a.txt to out");
  });
  it("an error that really names a file still names that file", () => {
    assert.equal(translateShell("mkdir -p memo && node memo.js && ls memo", [], true, "Error: Cannot find module '/w/memo.js'"), "Ran a Node script (memo.js)");
    assert.equal(translateShell("mkdir -p out && python3 draw.py out", [], true, "draw.py\", line 2\nValueError: bad"), "Ran a Python script (draw.py)");
    assert.equal(translateShell("cat notes.txt && node a.js", [], true, "cat: notes.txt: No such file or directory"), "Read notes.txt");
  });
  it("an error naming only a created folder stays unidentified", () => {
    assert.equal(translateShell("mkdir -p memo && node build.js", [], true, "Error: ENOENT: memo/x.json"), "Ran a Node script (build.js), failed at a step in it");
  });
  it("a tie on the error's file goes to the segment that runs code, not the one that edits", () => {
    const err = "/w/app.js:3\n  foo(\nSyntaxError: Unexpected token\n\nNode.js v22";
    assert.equal(translateShell("sed -i 's/a/b/' app.js && node app.js", [], true, err), "Ran a Node script (app.js)");
  });
  it("a tie with no runner, or several runners, stays unidentified", () => {
    assert.equal(translateShell("cp a.txt b.txt && sed -i 's/a/b/' a.txt", [], true, "Error: a.txt is bad"), "Copied a.txt to b.txt, failed at a step in it");
    assert.equal(translateShell("node app.js && node app.js --again", [], true, "Error at app.js:3"), "Ran a Node script (app.js), failed at a step in it");
  });
  it("an unquoted apostrophe does not swallow the chain", () => {
    assert.equal(translateShell("echo don't && node a.js && node b.js", [], true, "Error: Cannot find module 'b.js'"), "Ran a Node script (b.js)");
  });
});
