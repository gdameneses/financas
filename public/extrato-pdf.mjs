// PDF → text lines, the only step of a statement import that needs pdf.js. It runs in the browser
// (public/importar.js) and in Node (scripts/extrato.mjs); the lines are then parsed by
// src/lib/extrato.ts. No bank knowledge here: it only rebuilds each printed row, left to right.

export const PDF_MARK = "#pdf-linhas";
/** Stands for a glyph the PDF has no text for (some banks print "-" and ":" that way). */
const UNKNOWN = "¤";

/** One page's text items → its lines, top to bottom. Exported for the tests. */
export function linhasDeItens(items) {
  const rows = [];
  for (const it of items) {
    if (!it.str) continue;
    const x = it.transform[4];
    const y = it.transform[5];
    // items of one printed row share a baseline (within a point or two)
    let row = rows.find((r) => Math.abs(r.y - y) <= 2);
    if (!row) rows.push((row = { y, items: [] }));
    row.items.push({ x, w: it.width || 0, str: it.str });
  }
  rows.sort((a, b) => b.y - a.y);
  return rows
    .map((r) => {
      r.items.sort((a, b) => a.x - b.x);
      let line = "";
      let end = null;
      for (const it of r.items) {
        // a visible gap between two items is a space, unless one of them already is
        if (end !== null && it.x - end > 1.5 && !/\s$/.test(line) && !/^\s/.test(it.str)) line += " ";
        line += it.str;
        end = it.x + it.w;
      }
      let clean = "";
      for (const ch of line) clean += ch.charCodeAt(0) < 32 ? UNKNOWN : ch;
      return clean.replace(/\s+/g, " ").trim();
    })
    .filter(Boolean);
}

/** `pdfjs` is the pdf.js module, `data` the file's bytes. Returns the text src/lib/extrato.ts reads. */
export async function textoDoPdf(pdfjs, data) {
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  const out = [PDF_MARK];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    out.push(...linhasDeItens(content.items));
  }
  return out.join("\n");
}
