// Statements → the app's CSV, on the command line. Same parsers as the Importar page.
//   node scripts/extrato.mjs extrato.pdf outro.ofx > extrato.csv
// PDF (Neon), OFX and Nubank CSV can be mixed; rows repeated between files come out once.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { textoDoPdf } from "../public/extrato-pdf.mjs";
import { converter, paraCsv, ExtratoError } from "../src/lib/extrato.ts";

const files = process.argv.slice(2);
if (!files.length) {
  console.error("uso: node scripts/extrato.mjs <arquivo.pdf|.ofx|.csv> [...] > saida.csv");
  process.exit(2);
}

const arquivos = [];
for (const f of files) {
  const bytes = readFileSync(f);
  if (bytes.subarray(0, 5).toString("latin1") === "%PDF-") {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    arquivos.push({ nome: basename(f), conteudo: await textoDoPdf(pdfjs, new Uint8Array(bytes)) });
  } else {
    arquivos.push({ nome: basename(f), conteudo: bytes.toString("utf8") });
  }
}

try {
  const { linhas, fontes } = converter(arquivos);
  for (const s of fontes) console.error(`${s.nome}: ${s.formato}, ${s.linhas} linhas`);
  process.stdout.write(paraCsv(linhas));
} catch (e) {
  if (!(e instanceof ExtratoError)) throw e;
  console.error(e.message);
  process.exit(1);
}
