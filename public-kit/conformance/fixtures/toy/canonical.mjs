// Canonical form of a diff for hashing: keys sorted, no whitespace. Shared by the golden and the conformance tests; no OS-dependent field.
import { createHash } from "node:crypto";
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",")}}`;
  return JSON.stringify(v);
}
export const hashOf = (v) => createHash("sha256").update(canonical(v)).digest("hex");
