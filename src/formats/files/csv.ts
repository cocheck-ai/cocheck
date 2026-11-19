/**
 * The delimiter of `text`: whichever of comma, semicolon (the default in locales with a decimal
 * comma) and tab occurs most outside quotes on the first line, comma on a tie.
 */
export function sniffDelimiter(text: string): string {
  const counts = new Map([[",", 0], [";", 0], ["\t", 0]]);
  let inQuotes = false;
  for (const c of text) {
    if (c === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (c === "\n" || c === "\r")) break;
    else if (!inQuotes && counts.has(c)) counts.set(c, counts.get(c)! + 1);
  }
  let best = ",";
  for (const [d, n] of counts) if (n > counts.get(best)!) best = d;
  return best;
}

/**
 * Minimal RFC 4180 CSV parser: quoted fields, delimiters and newlines inside quotes, CRLF, BOM.
 * `delimiter` defaults to the one `sniffDelimiter` finds.
 */
export function parseCsv(text: string, delimiter = sniffDelimiter(text)): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let dirty = false; // anything seen on the current row, so a trailing newline adds no empty row
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      dirty = true;
    } else if (c === delimiter) {
      row.push(field);
      field = "";
      dirty = true;
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      dirty = false;
    } else {
      field += c;
      dirty = true;
    }
  }
  if (dirty || field !== "") {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
