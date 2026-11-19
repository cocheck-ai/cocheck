// A change document does not carry its level (the connector's hello does). Where a level is needed for a document already in hand (the source line, the
// served level), it is read off what the document holds: a box is level 3, a picture level 2, a plain change list level 1.
export type DocLevel = 1 | 2 | 3;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The level a document's content reaches. */
export function levelOfDoc(doc: unknown): DocLevel {
  if (!isObj(doc)) return 1;
  const changes = Array.isArray(doc.changes) ? doc.changes : [];
  if (changes.some((c) => isObj(c) && Array.isArray(c.boxes) && c.boxes.length > 0)) return 3;
  return Array.isArray(doc.pictures) && doc.pictures.length > 0 ? 2 : 1;
}

/** The level a document is drawn at: the connector's declared level (hello), never above what the document holds. With no declared level, what it holds. */
export function drawnLevel(doc: unknown, declared?: unknown): DocLevel {
  const held = levelOfDoc(doc);
  return declared === 1 || declared === 2 || declared === 3 ? (Math.min(declared, held) as DocLevel) : held;
}

/** The level a frozen document was drawn at: the one its source says (set at capture from the connector's hello), else what it holds. */
export function storedLevelOf(doc: unknown): DocLevel {
  const l = isObj(doc) && isObj(doc.source) ? doc.source.level : undefined;
  return l === 1 || l === 2 || l === 3 ? l : levelOfDoc(doc);
}
