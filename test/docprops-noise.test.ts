// The per-save docProps noise lists (src/office/connector/shared/docprops-noise.ts). The non-Word cases of the docx docprops test, kept when
// the lists are exact, the noise fields fold, and a real metadata edit stays.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { strToU8 } from "fflate";
import { APP_NOISE_FIELDS, CORE_NOISE_FIELDS, quietApp, quietCore } from "../src/office/connector/shared/docprops-noise.ts";
import { comparable } from "../src/office/connector/xlsx/layer.ts";

const CP = `xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"`;
interface Core { title?: string; creator?: string; subject?: string; lastBy?: string; revision?: string; modified?: string }
const core = (c: Core = {}): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties ${CP}><dc:title>${c.title ?? "Memo"}</dc:title><dc:subject>${c.subject ?? "S"}</dc:subject><dc:creator>${c.creator ?? "Ana"}</dc:creator><cp:lastModifiedBy>${c.lastBy ?? "Ana"}</cp:lastModifiedBy><cp:revision>${c.revision ?? "3"}</cp:revision><dcterms:created xsi:type="dcterms:W3CDTF">2026-01-01T00:00:00Z</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${c.modified ?? "2026-01-02T00:00:00Z"}</dcterms:modified></cp:coreProperties>`;
interface App { company?: string; time?: string; app?: string; ver?: string; titles?: string }
const app = (a: App = {}): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Template>Normal.dotm</Template><TotalTime>${a.time ?? "5"}</TotalTime><Pages>1</Pages><Application>${a.app ?? "Microsoft Office Word"}</Application><Company>${a.company ?? "Acme"}</Company><HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Title</vt:lpstr></vt:variant><vt:variant><vt:i4>1</vt:i4></vt:variant></vt:vector></HeadingPairs><TitlesOfParts><vt:vector size="1" baseType="lpstr"><vt:lpstr>${a.titles ?? "Memo"}</vt:lpstr></vt:vector></TitlesOfParts><AppVersion>${a.ver ?? "16.0000"}</AppVersion></Properties>`;

describe("per-save docProps noise", () => {
  it("the noise lists are exactly the named fields", () => {
    assert.deepEqual([...CORE_NOISE_FIELDS], ["dcterms:modified", "cp:lastModifiedBy", "cp:revision"]);
    assert.deepEqual([...APP_NOISE_FIELDS], ["Application", "AppVersion", "TotalTime", "TitlesOfParts", "HeadingPairs"]);
  });

  it("a re-save's core.xml and app.xml fields fold to the same text, and the xlsx layer compares core.xml the same way", () => {
    assert.equal(quietCore(core()), quietCore(core({ modified: "2026-02-03T04:05:06Z", revision: "4", lastBy: "Bo" })));
    assert.equal(quietApp(app()), quietApp(app({ time: "9", app: "Microsoft Office Word (Mac)", ver: "16.0100", titles: "Memo (2)" })));
    assert.deepEqual(comparable("docProps/core.xml", strToU8(core())), comparable("docProps/core.xml", strToU8(core({ modified: "x", revision: "9", lastBy: "Z" }))));
  });

  describe("a real metadata edit is never folded into noise", () => {
    it("core.xml dc:title, dc:creator and dc:subject changes stay", () => {
      for (const edit of [{ title: "Final" }, { creator: "Eve" }, { subject: "Other" }]) assert.notEqual(quietCore(core()), quietCore(core(edit)), JSON.stringify(edit));
    });
    it("app.xml Company change stays", () => assert.notEqual(quietApp(app()), quietApp(app({ company: "Evil Corp" }))));
    it("a noise-field change beside a real change still reports the real change", () => {
      assert.notEqual(quietCore(core()), quietCore(core({ title: "Final", modified: "2027-01-01T00:00:00Z", lastBy: "Q" })));
      assert.notEqual(quietApp(app()), quietApp(app({ company: "Evil Corp", time: "99", ver: "17" })));
    });
  });
});
