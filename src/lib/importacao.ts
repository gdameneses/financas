// Statement rows against the ledger: what is new, what is probably there already, and what is
// not an entry at all. Fixed rules only, so the same statement always gets the same answer.
import { refDe, type Linha } from "./extrato";

export type Status =
  /** not in the ledger: import it */
  | "novo"
  /** an entry with the same value and a close date exists: probably typed in by hand already */
  | "duplicata"
  /** this very row was imported or matched before */
  | "importado"
  /** this very row was looked at before and left out */
  | "ignorado"
  /** transfer between the núcleo's own accounts */
  | "interna"
  /** money going into or coming out of an investment */
  | "investimento"
  /** an entry and its reversal: they cancel out */
  | "estorno"
  /** older than the núcleo's first entry */
  | "anterior";

/** What happens to a row nobody touches on the review screen. */
export type Acao = "importar" | "vincular" | "ignorar";

export type Existente = {
  id: number;
  date: string;
  kind: "in" | "out";
  amount_cents: number;
  payee: string;
  category_name: string | null;
  import_ref: string | null;
};

export type Aprendido = { category_id: number | null; payee: string; kind: "in" | "out" };

export type Analisada = {
  /** position in the CSV: the form fields of the row are named after it */
  n: number;
  linha: Linha;
  ref: string;
  kind: "in" | "out";
  cents: number;
  /** who the money went to or came from, as the bank spells it */
  contraparte: string;
  /** a transfer to or from a named person or company: the kind of row that can be "between our accounts" */
  transferencia: boolean;
  /** `contraparte` normalised: the key suggestions are learned under */
  chave: string;
  status: Status;
  /** the ledger entry this row seems to be (status "duplicata") */
  match: Existente | null;
  /** suggested name and category, from the last entry with the same counterparty */
  payee: string;
  category_id: number | null;
  acao: Acao;
};

export type Contexto = {
  /** ledger entries around the statement's dates */
  existentes: Existente[];
  /** fingerprints of every row already imported or matched, whatever the entry's date is now */
  importados: Set<string>;
  ignorados: Set<string>;
  /** holder names already known, normalised */
  titulares: Set<string>;
  aprendido: Map<string, Aprendido>;
  /** date of the núcleo's first entry, null when the ledger is empty */
  inicio: string | null;
};

/** An entry within this many days of a statement row with the same value counts as the same one. */
export const JANELA_DIAS = 4;

/** Upper case, no accents, single spaces: how names are compared. */
export function normalizar(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
}

const NEON_TRANSFER = /^(?:PIX|TED|DOC)\s+(?:enviad[oa]|recebid[oa]|devolvid[oa])\s+(?:para|de|por)\s+(.+)$/i;

/**
 * The other side of a row.
 *   Neon:   "PIX enviado para FULANO DE TAL"                      → FULANO DE TAL
 *   Nubank: "Transferência enviada pelo Pix - FULANO - doc - banco…" → FULANO
 *           "Compra no débito - PADARIA"                           → PADARIA
 * Anything else is its own counterparty ("Plano Nucel - Conta", "NETFLIX.COM SAO PAULO BR").
 */
const NUBANK_KIND = /^(compra|transferencia|pagamento|reembolso)\b/i;
export function contraparteDe(descricao: string): string {
  const neon = NEON_TRANSFER.exec(descricao);
  if (neon) return neon[1].trim();
  let parts = descricao.split(" - ").map((p) => p.trim());
  if (parts.length > 1 && /^estorno$/i.test(parts[0])) parts = parts.slice(1);
  if (parts.length < 2 || !NUBANK_KIND.test(normalizar(parts[0]))) return descricao.trim();
  if (parts.length >= 4) return parts[1]; // kind - name - document - bank
  return parts.slice(1).join(" - ");
}

/** PIX, TED or DOC to or from somebody, in either bank's wording. */
export const ehTransferencia = (descricao: string) => NEON_TRANSFER.test(descricao) || /^(estorno - )?transferencia\b/i.test(normalizar(descricao));

/** "Aplicação em …", "Resgate …", "Complemento de resgate …" (Neon and Nubank wording). */
export const ehInvestimento = (descricao: string) => /^(aplicacao|resgate|complemento de resgate)\b/i.test(normalizar(descricao));

const dias = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;

/** 1 when the entry's name and the statement's counterparty share a word of 4+ letters, else 0. */
function mesmoNome(payee: string, chave: string): number {
  const words = new Set(chave.split(/[^A-Z0-9]+/).filter((w) => w.length >= 4));
  return normalizar(payee).split(/[^A-Z0-9]+/).some((w) => words.has(w)) ? 1 : 0;
}

const ACAO_PADRAO: Record<Status, Acao> = {
  novo: "importar",
  duplicata: "vincular",
  importado: "ignorar",
  ignorado: "ignorar",
  interna: "ignorar",
  investimento: "ignorar",
  estorno: "ignorar",
  anterior: "ignorar",
};

export function analisar(linhas: Linha[], ctx: Contexto): Analisada[] {
  // holders named by the statements themselves count from the first import on
  const titulares = new Set(ctx.titulares);
  for (const l of linhas) if (l.titular) titulares.add(normalizar(l.titular));

  // a row and its reversal carry the same bank id and opposite values
  const porId = new Map<string, Linha[]>();
  for (const l of linhas) if (l.id) porId.set(l.id, [...(porId.get(l.id) ?? []), l]);
  const estornadas = new Set<Linha>();
  for (const grupo of porId.values()) {
    const livres = [...grupo];
    for (const a of grupo) {
      if (!livres.includes(a)) continue;
      const b = livres.find((x) => x !== a && x.valor === -a.valor);
      if (!b) continue;
      estornadas.add(a).add(b);
      livres.splice(livres.indexOf(a), 1);
      livres.splice(livres.indexOf(b), 1);
    }
  }

  const out: Analisada[] = linhas.map((linha, n) => {
    const ref = refDe(linha);
    const contraparte = contraparteDe(linha.descricao);
    const chave = normalizar(contraparte);
    const kind = linha.valor < 0 ? "out" : "in";
    let status: Status = "novo";
    if (ctx.importados.has(ref)) status = "importado";
    else if (ctx.ignorados.has(ref)) status = "ignorado";
    else if (ehInvestimento(linha.descricao)) status = "investimento";
    else if (estornadas.has(linha)) status = "estorno";
    else if (titulares.has(chave)) status = "interna";
    const visto = ctx.aprendido.get(chave);
    return {
      n,
      linha,
      ref,
      kind,
      cents: Math.abs(linha.valor),
      contraparte,
      transferencia: ehTransferencia(linha.descricao),
      chave,
      status,
      match: null,
      payee: visto?.payee || contraparte.replace(/\s+/g, " ").slice(0, 80),
      category_id: visto && visto.kind === kind ? visto.category_id : null,
      acao: "ignorar",
    };
  });

  // Same value, same direction, close date: pair each row with at most one entry, nearest first.
  // Entries already tied to a statement row belong to that row and are not offered again.
  const livres = ctx.existentes.filter((e) => !e.import_ref);
  // Between entries equally close in date, the one whose name looks like the statement's wins.
  const pares: { row: Analisada; ex: Existente; d: number; nome: number }[] = [];
  for (const row of out) {
    if (row.status !== "novo") continue;
    for (const ex of livres) {
      if (ex.kind !== row.kind || ex.amount_cents !== row.cents) continue;
      const d = dias(ex.date, row.linha.data);
      if (d <= JANELA_DIAS) pares.push({ row, ex, d, nome: mesmoNome(ex.payee, row.chave) });
    }
  }
  pares.sort((a, b) => a.d - b.d || b.nome - a.nome || a.row.n - b.row.n || a.ex.id - b.ex.id);
  const usados = new Set<number>();
  for (const p of pares) {
    if (p.row.match || usados.has(p.ex.id)) continue;
    p.row.match = p.ex;
    p.row.status = "duplicata";
    usados.add(p.ex.id);
  }

  for (const row of out) {
    // only what found no entry: a row from just before the first entry can still be that entry
    if (row.status === "novo" && ctx.inicio && row.linha.data < ctx.inicio) row.status = "anterior";
    row.acao = ACAO_PADRAO[row.status];
  }
  return out;
}
