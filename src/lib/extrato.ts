// Bank statements → one canonical CSV. Every parser here is deterministic: fixed patterns, no guessing.
// A statement that does not fit its pattern is refused with the reason, never imported half-read.
//
// Formats:
//   - canonical CSV (CSV_HEADER below): what every other format is converted to
//   - OFX (the banks' own exchange format; Nubank and most others export it)
//   - Nubank CSV ("Data,Valor,Identificador,Descrição")
//   - Neon PDF, as text lines extracted in the browser by public/extrato-pdf.mjs
//
// This file imports nothing, so scripts/extrato.mjs can load it straight from Node.

/** One statement row. `valor` is signed centavos: negative = money out. */
export type Linha = {
  /** Bank and account, for display and for the fingerprint of rows without a bank id. */
  conta: string;
  /** Account holder as printed on the statement, "" when the format does not say. */
  titular: string;
  /** YYYY-MM-DD */
  data: string;
  /** HH:MM, "" when the format has no time */
  hora: string;
  descricao: string;
  valor: number;
  /** Balance after the row, when the statement prints it. */
  saldo: number | null;
  /** The bank's own transaction id, "" when there is none. */
  id: string;
};

export type Fonte = { nome: string; formato: string; linhas: number };

export class ExtratoError extends Error {}

export const CSV_HEADER = "conta,titular,data,hora,descricao,valor,saldo,id";
const NUBANK_HEADER = "data,valor,identificador,descricao";
/** First line of the text the browser sends for a PDF (see public/extrato-pdf.mjs). */
export const PDF_MARK = "#pdf-linhas";
/** Stands for a glyph the PDF has no text for. Neon prints the minus sign and the time colon that way. */
const G = "¤";

/**
 * Stable fingerprint of a row, the same on every import of the same statement.
 * A bank id alone is not enough: Nubank gives a reversal the id of the entry it reverses.
 */
export function refDe(l: Linha): string {
  return l.id ? `${l.id}:${l.valor}` : `${l.conta}|${l.data}|${l.hora}|${l.valor}|${l.saldo ?? ""}`;
}

// ---- small helpers ----

/** "1.234,56" → 123456 */
function centavosBR(s: string): number | null {
  const m = /^(\d{1,3}(?:\.\d{3})*|\d+),(\d{2})$/.exec(s.trim());
  return m ? Number(m[1].replace(/\./g, "")) * 100 + Number(m[2]) : null;
}

/** "-1234.56", "12", "12,5" → signed centavos */
function centavosDecimal(s: string): number | null {
  const m = /^([+-]?)(\d+)(?:[.,](\d{1,2}))?$/.exec(s.trim());
  if (!m) return null;
  const v = Number(m[2]) * 100 + Number(((m[3] ?? "") + "00").slice(0, 2));
  return m[1] === "-" ? -v : v;
}

function decimal(cents: number): string {
  const a = Math.abs(cents);
  return `${cents < 0 ? "-" : ""}${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`;
}

function dataBR(s: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s.trim());
  if (!m) return null;
  const iso = `${m[3]}-${m[2]}-${m[1]}`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

const semAcento = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "");
const limpo = (s: string) => s.replace(/\s+/g, " ").trim();

/** RFC 4180: quoted fields, doubled quotes, CRLF or LF, optional BOM. Empty lines are dropped. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  return rows;
}

const campo = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

export function paraCsv(linhas: Linha[]): string {
  const out = [CSV_HEADER];
  for (const l of linhas) {
    out.push([l.conta, l.titular, l.data, l.hora, l.descricao, decimal(l.valor), l.saldo === null ? "" : decimal(l.saldo), l.id].map(campo).join(","));
  }
  return out.join("\n") + "\n";
}

const cabecalho = (row: string[]) => row.map((c) => semAcento(c).trim().toLowerCase()).join(",");

// ---- canonical CSV ----

function lerCanonico(rows: string[][]): Linha[] {
  return rows.slice(1).map((r, i) => {
    const n = i + 2;
    if (r.length !== 8) throw new ExtratoError(`linha ${n}: esperava 8 colunas, vieram ${r.length}`);
    const [conta, titular, data, hora, descricao, valorS, saldoS, id] = r.map((c) => c.trim());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data) || Number.isNaN(Date.parse(data))) throw new ExtratoError(`linha ${n}: data inválida "${data}"`);
    if (hora && !/^\d{2}:\d{2}$/.test(hora)) throw new ExtratoError(`linha ${n}: hora inválida "${hora}"`);
    const valor = centavosDecimal(valorS);
    if (valor === null || valor === 0) throw new ExtratoError(`linha ${n}: valor inválido "${valorS}"`);
    const saldo = saldoS === "" ? null : centavosDecimal(saldoS);
    if (saldoS !== "" && saldo === null) throw new ExtratoError(`linha ${n}: saldo inválido "${saldoS}"`);
    return { conta, titular, data, hora, descricao, valor, saldo, id };
  });
}

// ---- Nubank CSV: Data,Valor,Identificador,Descrição ----

function lerNubankCsv(rows: string[][]): Linha[] {
  return rows.slice(1).map((r, i) => {
    const n = i + 2;
    if (r.length !== 4) throw new ExtratoError(`linha ${n}: esperava 4 colunas, vieram ${r.length}`);
    const data = dataBR(r[0]);
    if (!data) throw new ExtratoError(`linha ${n}: data inválida "${r[0]}"`);
    const valor = centavosDecimal(r[1]);
    if (valor === null || valor === 0) throw new ExtratoError(`linha ${n}: valor inválido "${r[1]}"`);
    const id = r[2].trim();
    if (!id) throw new ExtratoError(`linha ${n}: sem identificador`);
    return { conta: "Nubank", titular: "", data, hora: "", descricao: limpo(r[3]), valor, saldo: null, id };
  });
}

// ---- OFX (SGML 1.x or XML 2.x): one STMTTRN block per row ----

function ofxTag(block: string, tag: string): string {
  const m = new RegExp(`<${tag}>([^<\\r\\n]*)`, "i").exec(block);
  return m ? m[1].trim() : "";
}

const xmlEntidades = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

function lerOfx(text: string): Linha[] {
  const org = ofxTag(text, "ORG");
  const acct = ofxTag(text, "ACCTID");
  const banco = /^NU PAGAMENTOS/i.test(org) || ofxTag(text, "FID") === "260" ? "Nubank" : org || "OFX";
  const conta = limpo(`${banco} ${acct}`);
  const blocks = text.match(/<STMTTRN>[\s\S]*?<\/STMTTRN>/gi) ?? [];
  if (!blocks.length && !/<BANKTRANLIST>/i.test(text)) throw new ExtratoError("OFX sem lista de lançamentos (BANKTRANLIST)");
  return blocks.map((b, i) => {
    const n = i + 1;
    const dt = /^(\d{4})(\d{2})(\d{2})/.exec(ofxTag(b, "DTPOSTED"));
    if (!dt || Number.isNaN(Date.parse(`${dt[1]}-${dt[2]}-${dt[3]}`))) throw new ExtratoError(`lançamento ${n}: data inválida`);
    const valor = centavosDecimal(ofxTag(b, "TRNAMT"));
    if (valor === null || valor === 0) throw new ExtratoError(`lançamento ${n}: valor inválido "${ofxTag(b, "TRNAMT")}"`);
    // Nubank's OFX marks a reversal as "<id>:reversal" where its CSV repeats the bare id: use the
    // bare id so both files give the same fingerprint (the sign of the value tells them apart).
    const id = ofxTag(b, "FITID").replace(/:reversal$/i, "");
    if (!id) throw new ExtratoError(`lançamento ${n}: sem FITID`);
    const descricao = limpo(xmlEntidades(ofxTag(b, "MEMO") || ofxTag(b, "NAME")));
    return { conta, titular: "", data: `${dt[1]}-${dt[2]}-${dt[3]}`, hora: "", descricao, valor, saldo: null, id };
  });
}

// ---- Neon PDF ("Extrato por período"), as text lines ----
// A row is: description, date, time, value, balance, card. Money out carries a glyph before "R$".
//   NETFLIX.COM SAO PAULO BR 18/08/2026 16¤40 ¤R$ 44,90 R$ 1.487,07 -
// Every row is checked against the running balance, so a row the pattern missed, or a wrong
// sign, stops the import instead of slipping through.

const NEON_ROW = new RegExp(
  `^(.+?)\\s+(\\d{2}/\\d{2}/\\d{4})\\s+(\\d{2})[${G}:\\s](\\d{2})\\s+([${G}-]?)\\s*R\\$\\s*([\\d.]+,\\d{2})\\s+([${G}-]?)\\s*R\\$\\s*([${G}-]?)([\\d.]+,\\d{2})(?:\\s+\\S.*)?$`,
);
const NEON_TITULAR = new RegExp(`^(\\D+?)\\s+(\\d{3,5})\\s+(\\d{4,})[${G}\\s-](\\d)$`);

function lerNeonPdf(lines: string[]): Linha[] {
  let titular = "";
  let conta = "Neon";
  const out: Linha[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = limpo(lines[i]);
    if (!titular) {
      const t = NEON_TITULAR.exec(line);
      if (t && /Cliente/.test(lines.slice(Math.max(0, i - 3), i).join(" "))) {
        titular = limpo(t[1]);
        conta = `Neon ${t[3]}-${t[4]}`;
      }
    }
    const m = NEON_ROW.exec(line);
    if (!m) continue;
    const data = dataBR(m[2]);
    const abs = centavosBR(m[6]);
    const saldoAbs = centavosBR(m[9]);
    if (!data || abs === null || saldoAbs === null) throw new ExtratoError(`linha não entendida: "${line}"`);
    const saldo = m[7] || m[8] ? -saldoAbs : saldoAbs;
    const valor = m[5] ? -abs : abs;
    const prev = out[out.length - 1];
    if (prev && prev.saldo !== null && prev.saldo + valor !== saldo) {
      throw new ExtratoError(
        `o saldo não fecha em ${m[2]} ${m[3]}:${m[4]} ("${limpo(m[1])}"): saldo anterior ${decimal(prev.saldo)}, valor ${decimal(valor)}, saldo impresso ${decimal(saldo)}. Alguma linha não foi lida.`,
      );
    }
    out.push({ conta, titular, data, hora: `${m[3]}:${m[4]}`, descricao: limpo(m[1]), valor, saldo, id: "" });
  }
  if (!out.length) throw new ExtratoError("nenhum lançamento encontrado no PDF");
  if (!titular) throw new ExtratoError("não achei o titular e a conta no cabeçalho do PDF");
  // the holder line can come after the first rows on a page: every row gets the same account
  return out.map((l) => ({ ...l, conta, titular }));
}

// ---- detection ----

/** Reads one file in any supported format. Throws ExtratoError saying why it was refused. */
export function lerArquivo(conteudo: string): { formato: string; linhas: Linha[] } {
  const text = conteudo.charCodeAt(0) === 0xfeff ? conteudo.slice(1) : conteudo;
  const head = text.trimStart().slice(0, 400);
  if (head.startsWith(PDF_MARK)) {
    const lines = text.split(/\r?\n/).slice(1);
    if (lines.some((l) => /Neon Pagamentos/i.test(l))) return { formato: "Neon PDF", linhas: lerNeonPdf(lines) };
    throw new ExtratoError("PDF de um banco que ainda não leio. Do Nubank, exporte o extrato em OFX ou CSV.");
  }
  if (/^OFXHEADER|<OFX>|<\?OFX/i.test(head)) return { formato: "OFX", linhas: lerOfx(text) };
  const rows = parseCsv(text);
  if (rows.length) {
    const h = cabecalho(rows[0]);
    if (h === CSV_HEADER) return { formato: "CSV", linhas: lerCanonico(rows) };
    if (h === NUBANK_HEADER) return { formato: "Nubank CSV", linhas: lerNubankCsv(rows) };
  }
  throw new ExtratoError("formato não reconhecido. Aceito: OFX, CSV do Nubank, PDF do Neon ou o CSV deste app.");
}

/**
 * Several files → one list in date order. The same row arriving twice (overlapping periods, or
 * the same month as CSV and as OFX) is kept once.
 */
export function converter(arquivos: { nome: string; conteudo: string }[]): { linhas: Linha[]; fontes: Fonte[] } {
  const fontes: Fonte[] = [];
  const seen = new Set<string>();
  const all: Linha[] = [];
  for (const a of arquivos) {
    let r: { formato: string; linhas: Linha[] };
    try {
      r = lerArquivo(a.conteudo);
    } catch (e) {
      if (e instanceof ExtratoError) throw new ExtratoError(`${a.nome}: ${e.message}`);
      throw e;
    }
    fontes.push({ nome: a.nome, formato: r.formato, linhas: r.linhas.length });
    for (const l of r.linhas) {
      const ref = refDe(l);
      if (seen.has(ref)) continue;
      seen.add(ref);
      all.push(l);
    }
  }
  // stable sort: rows of one statement keep their order inside the same minute
  const linhas = all
    .map((l, i) => ({ l, i }))
    .sort((a, b) => (a.l.data + a.l.hora).localeCompare(b.l.data + b.l.hora) || a.i - b.i)
    .map((x) => x.l);
  return { linhas, fontes };
}
