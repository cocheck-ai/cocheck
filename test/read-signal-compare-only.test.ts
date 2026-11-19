import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { callReads } from "../src/timeline/read-signal.ts";

// A script is compare-only only when every statement is an import, a read assigned to a name, or a print/assert of a comparison built from reads.
// Anything else (any other call, a write form this code has never heard of) keeps the script's inputs.

const reads = (command: string, named: string[] = []) => callReads({ tool: "Bash", command, input: null, named } as never).map((r) => r.path);

describe("compare-only is an allow-list", () => {
  it("np.loadtxt then np.savetxt keeps its input", () => {
    assert.ok(reads(`python3 -c "import numpy as np\nx=np.loadtxt('data/a.csv')\nnp.savetxt('out/o.csv', x==x)"`).includes("data/a.csv"));
  });
  it("xlsxwriter.Workbook with a csv read and wb.close() keeps its input", () => {
    assert.ok(reads(`python3 -c "import xlsxwriter\nwb=xlsxwriter.Workbook('out/o.xlsx')\nd=open('data/in.csv').read()\nprint(d!='')\nwb.close()"`).includes("data/in.csv"));
  });
  it("node readFileSync then createWriteStream keeps its input", () => {
    const cmd = `node -e "const fs=require('fs');const a=fs.readFileSync('data/a.json','utf8');if(a!=='')fs.createWriteStream('out/o.json').end(a)"`;
    assert.ok(reads(cmd).includes("data/a.json"));
  });
  it("sqlite connect, create table, commit keeps its input", () => {
    assert.ok(reads(`python3 -c "import sqlite3\nc=sqlite3.connect('data/in.db')\nc.execute('create table t(x)')\nc.commit()\nprint(c==c)"`).includes("data/in.db"));
  });
  it("a named input stays when the same call's script also writes through an unlisted form", () => {
    const D = "/w/";
    const cmd = `python3 -c "import numpy as np\nx=np.loadtxt('data/a.csv')\nnp.savetxt('out/o.csv', x)\nprint(x==x)"`;
    assert.ok(reads(cmd, [D + "data/a.csv"]).some((p) => p.endsWith("data/a.csv")));
  });
  it("c141 shape stays compare-only: two workbooks loaded and compared, result printed", () => {
    const cmd = `python3 -c "\nimport openpyxl\na=openpyxl.load_workbook('output/deck/p.xlsx',data_only=True);b=openpyxl.load_workbook('output/p.xlsx',data_only=True)\nprint(all([c.value for c in r]==[c.value for c in b[n][r[0].row]] for n in ['S'] for r in a[n].iter_rows()))"`;
    assert.deepEqual(reads(cmd), []);
  });
  it("filecmp.cmp alone and an assert of two reads are compare-only", () => {
    assert.deepEqual(reads(`python3 -c "import filecmp; print(filecmp.cmp('data/a.csv','data/b.csv'))"`), []);
    assert.deepEqual(reads(`python3 -c "assert open('data/a.csv').read()==open('data/b.csv').read()"`), []);
  });
});
