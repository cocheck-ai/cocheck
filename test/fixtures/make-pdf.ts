/** Builds a small valid PDF from plain text lines (Helvetica 12 pt, US Letter, 18 pt leading, 72 pt margin); one string array per page.
 *  `fills` adds filled rectangles per page, in points from the bottom left, drawn under the text: a change to a picture with the same text. */
export interface Fill {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 0 black, 1 white. */
  gray: number;
}
export function makePdf(pages: string[][], fills: Fill[][] = []): Buffer {
  const objs: string[] = [];
  const add = (body: string): number => objs.push(body);
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add(`<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  pages.forEach((lines, i) => {
    const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
    const rects = (fills[i] ?? []).map((f) => `${f.gray} g ${f.x} ${f.y} ${f.w} ${f.h} re f 0 g`).join(" ");
    const stream = `${rects} BT /F1 12 Tf 18 TL 72 720 Td ${lines.map((l) => `(${esc(l)}) Tj T*`).join(" ")} ET`;
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
