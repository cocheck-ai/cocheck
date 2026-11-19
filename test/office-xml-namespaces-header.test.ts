import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalXml } from "../src/office/connector/shared/ooxml-names.ts";

describe("the header says what is normalised", () => {
  it("canonical text still differs where declarations are moved, which the header must not claim otherwise", () => {
    const a = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/></w:body></w:document>`;
    const b = `<w:document><w:body xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p/></w:body></w:document>`.replace("<w:document>", `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">`);
    assert.notEqual(canonicalXml(a, "ooxml", "d"), canonicalXml(b, "ooxml", "d"));
  });
  it("an attribute value holding ' = ' keeps an otherwise literal part on the literal path", () => {
    const text = `<?xml version="1.0"?><root><a:b v="x = y"/></root>`; // an undeclared prefix throws if the full rewrite runs
    assert.equal(canonicalXml(text, "ooxml", "d"), text);
  });
});
