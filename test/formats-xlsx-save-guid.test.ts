import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { createXlsxLayer } from "../src/office/connector/xlsx/layer.ts";

// Fixed so two builds of the same workbook are byte-identical; fflate stamps the current time (2 s granularity) otherwise.
const ZIP_MTIME = new Date(2020, 0, 1);

const layer = createXlsxLayer({ openState: async () => "closed" });
const fixture = (name: string) => new URL(`./fixtures/save-guid/${name}`, import.meta.url);

/** Rewrites xl/workbook.xml of an Excel-saved package, leaving every other part as it was. */
async function withWorkbook(source: string, edit: (xml: string) => string): Promise<Uint8Array> {
  const parts = unzipSync(new Uint8Array(await readFile(fixture(source))));
  parts["xl/workbook.xml"] = strToU8(edit(strFromU8(parts["xl/workbook.xml"]!)));
  return zipSync(parts, { mtime: ZIP_MTIME });
}

async function diffBytes(a: Uint8Array | string, b: Uint8Array | string) {
  const dir = await mkdtemp(join(tmpdir(), "cocheck-save-guid-"));
  const put = async (name: string, v: Uint8Array | string) => {
    if (typeof v !== "string") {
      await writeFile(join(dir, name), v);
      return join(dir, name);
    }
    return fileURLToPath(fixture(v));
  };
  return layer.diff(await put("a.xlsx", a), await put("b.xlsx", b));
}

describe("xlsx layer: Excel's per-save revision attributes in workbook.xml", () => {
  it("an Excel re-save that only changed the revisionPtr GUID diffs to nothing", async () => {
    assert.deepEqual(await diffBytes("before.xlsx", "after.xlsx"), []);
  });

  it("every revisionPtr attribute is per-save noise", async () => {
    const changed = await withWorkbook("before.xlsx", (xml) =>
      xml.replace(/<xr:revisionPtr[^>]*\/>/, '<xr:revisionPtr revIDLastSave="7" documentId="13_ncr:1_{AAAAAAAA-0000-0000-0000-000000000000}" xr6:coauthVersionLast="48" xr6:coauthVersionMax="49" xr10:uidLastSave="{11111111-2222-3333-4444-555555555555}"/>'));
    assert.deepEqual(await diffBytes("before.xlsx", changed), []);
  });

  it("a sheet added to <sheets> is still a row", async () => {
    const changed = await withWorkbook("after.xlsx", (xml) => xml.replace("</sheets>", '<sheet name="Extra" sheetId="99" r:id="rId99"/></sheets>'));
    const rows = await diffBytes("before.xlsx", changed);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.kind, "file changed");
  });

  it("a changed activeTab alongside a new GUID is still a row (view state is not filtered)", async () => {
    const changed = await withWorkbook("after.xlsx", (xml) => xml.replace('activeTab="3"', 'activeTab="1"'));
    assert.equal((await diffBytes("before.xlsx", changed)).length, 1);
  });
});
