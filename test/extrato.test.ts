import { describe, it, expect } from "vitest";
import { converter, ExtratoError, lerArquivo, paraCsv, parseCsv, refDe } from "../src/lib/extrato";
import { analisar, contraparteDe, ehInvestimento, ehTransferencia, normalizar, type Contexto, type Existente } from "../src/lib/importacao";
// @ts-expect-error plain browser module, no types
import { linhasDeItens } from "../public/extrato-pdf.mjs";

// Shaped like a real Neon "Extrato por período" after public/extrato-pdf.mjs; the people are made up.
const NEON = `#pdf-linhas
Conta digital Data da solicitação Hora da solicitação
Neon Pagamentos S/A 19/11/2026 15¤34
Extrato por
período Cliente Agência bancária Conta
MARIA TESTE DA SILVA 0655 1234567¤8
Ano Base: 2026
Período de 18/08/2026 a 19/11/2026
Descrição Data Hora Valor Saldo Cartão
TED recebido de IMOBILIARIA EXEMPLO LTDA 18/08/2026 12¤09 R$ 1.523,27 R$ 1.531,97 -
NETFLIX.COM SAO PAULO BR 18/08/2026 16¤40 ¤R$ 44,90 R$ 1.487,07 -
PIX enviado para Joao Teste Souza 20/08/2026 09¤11 ¤R$ 487,00 R$ 1.000,07 -
Chat do App Fale com a gente WhatsApp Ouvidoria
/timeneon
Descrição Data Hora Valor Saldo Cartão
Aplicação em Corrente, pode mexer 26/08/2026 17¤09 ¤R$ 1.000,00 R$ 0,07 -
Resgate em Corrente, pode mexer 28/08/2026 17¤57 R$ 600,00 R$ 600,07 -
PIX enviado para Maria Teste da Silva 28/08/2026 17¤57 ¤R$ 500,00 R$ 100,07 -
PIX enviado para MERCADO EXEMPLO LTDA 29/08/2026 12¤45 ¤R$ 77,86 R$ 22,21 -`;

const NUBANK = `Data,Valor,Identificador,Descrição
03/11/2026,-51.46,aaaa-1,Transferência enviada pelo Pix - MERCADO EXEMPLO - 00.000.000/0001-00 - BANCO X (0001) Agência: 1 Conta: 2-3
05/11/2026,-27.99,aaaa-2,Compra no débito - FARMACIA EXEMPLO    0222
08/11/2026,350.00,aaaa-3,Resgate RDB
09/11/2026,500.00,aaaa-4,Transferência recebida pelo Pix - Maria Teste da Silva - •••.000.000-•• - NEON PAGAMENTOS S.A. IP (0536) Agência: 655 Conta: 1234567-8
18/11/2026,-140.00,aaaa-5,Transferência enviada pelo Pix - Joao Teste Souza - •••.000.000-•• - BANCO X (0001) Agência: 1 Conta: 9-9
18/11/2026,140.00,aaaa-5,Estorno - Transferência enviada pelo Pix - Joao Teste Souza - •••.000.000-•• - BANCO X (0001) Agência: 1 Conta: 9-9
`;

const ofx = (trns: string) => `OFXHEADER:100
DATA:OFXSGML
<OFX>
<SIGNONMSGSRSV1><SONRS>
<FI>
<ORG>NU PAGAMENTOS S.A.</ORG>
<FID>260</FID>
</FI>
</SONRS></SIGNONMSGSRSV1>
<BANKMSGSRSV1><STMTTRNRS><STMTRS>
<BANKACCTFROM>
<ACCTID>7654321-0</ACCTID>
</BANKACCTFROM>
<BANKTRANLIST>
${trns}
</BANKTRANLIST>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>`;
const trn = (date: string, amt: string, id: string, memo: string) =>
  `<STMTTRN>\n<TRNTYPE>DEBIT</TRNTYPE>\n<DTPOSTED>${date}000000[-3:BRT]</DTPOSTED>\n<TRNAMT>${amt}</TRNAMT>\n<FITID>${id}</FITID>\n<MEMO>${memo}</MEMO>\n</STMTTRN>`;

const ctx = (over: Partial<Contexto> = {}): Contexto => ({
  existentes: [],
  importados: new Set(),
  ignorados: new Set(),
  titulares: new Set(),
  aprendido: new Map(),
  inicio: null,
  ...over,
});
const ex = (id: number, date: string, kind: "in" | "out", amount_cents: number, import_ref: string | null = null): Existente => ({
  id,
  date,
  kind,
  amount_cents,
  payee: `e${id}`,
  category_name: null,
  import_ref,
});

describe("PDF → linhas", () => {
  const item = (str: string, x: number, y: number, width = str.length * 5) => ({ str, width, transform: [1, 0, 0, 1, x, y] });
  it("rebuilds each printed row left to right and marks glyphs without text", () => {
    const nul = String.fromCharCode(0);
    const lines = linhasDeItens([
      item("R$", 425, 559, 8),
      item("NETFLIX", 30, 559, 25),
      item(".", 55, 559, 2),
      item("COM", 58, 559, 15),
      item(`16${nul}40`, 379, 559.4, 16),
      item(nul, 422, 559, 3),
      item(" ", 432, 559, 2),
      item("44,90", 434, 559, 18),
      item("Descrição", 30, 602),
      item("", 30, 559, 0),
    ]);
    expect(lines).toEqual(["Descrição", "NETFLIX.COM 16¤40 ¤R$ 44,90"]);
  });
});

describe("Neon PDF", () => {
  it("reads holder, account, sign and balance of every row", () => {
    const { formato, linhas } = lerArquivo(NEON);
    expect(formato).toBe("Neon PDF");
    expect(linhas).toHaveLength(7);
    expect(linhas[0]).toEqual({
      conta: "Neon 1234567-8",
      titular: "MARIA TESTE DA SILVA",
      data: "2026-08-18",
      hora: "12:09",
      descricao: "TED recebido de IMOBILIARIA EXEMPLO LTDA",
      valor: 152327,
      saldo: 153197,
      id: "",
    });
    expect(linhas[1].valor).toBe(-4490);
    expect(linhas[1].descricao).toBe("NETFLIX.COM SAO PAULO BR");
  });

  it("refuses the statement when a row is missing: the balance no longer adds up", () => {
    const semUma = NEON.split("\n").filter((l) => !l.startsWith("NETFLIX")).join("\n");
    expect(() => lerArquivo(semUma)).toThrow(/saldo não fecha/);
  });

  it("refuses the statement when a sign is wrong", () => {
    expect(() => lerArquivo(NEON.replace("16¤40 ¤R$", "16¤40 R$"))).toThrow(ExtratoError);
  });

  it("refuses a PDF from a bank it does not know", () => {
    expect(() => lerArquivo("#pdf-linhas\nBanco Qualquer\nalgo 01/01/2026")).toThrow(/ainda não leio/);
  });
});

describe("Nubank CSV e OFX", () => {
  it("reads the CSV", () => {
    const { formato, linhas } = lerArquivo(NUBANK);
    expect(formato).toBe("Nubank CSV");
    expect(linhas).toHaveLength(6);
    expect(linhas[1]).toMatchObject({ conta: "Nubank", data: "2026-11-05", valor: -2799, id: "aaaa-2", descricao: "Compra no débito - FARMACIA EXEMPLO 0222" });
  });

  it("reads the OFX, and the same row from both files is the same row", () => {
    const o = ofx(
      [
        trn("20261103", "-51.46", "aaaa-1", "Transferência enviada pelo Pix - MERCADO EXEMPLO"),
        trn("20261118", "-140.00", "aaaa-5", "Transferência enviada pelo Pix - Joao Teste Souza"),
        trn("20261118", "140.00", "aaaa-5:reversal", "Estorno - Transferência enviada pelo Pix - Joao Teste Souza"),
      ].join("\n"),
    );
    const lido = lerArquivo(o);
    expect(lido.formato).toBe("OFX");
    expect(lido.linhas[0]).toMatchObject({ conta: "Nubank 7654321-0", data: "2026-11-03", valor: -5146, id: "aaaa-1" });
    const { linhas, fontes } = converter([
      { nome: "a.csv", conteudo: NUBANK },
      { nome: "a.ofx", conteudo: o },
    ]);
    expect(fontes.map((f) => f.linhas)).toEqual([6, 3]);
    expect(linhas).toHaveLength(6);
  });

  it("names the file it could not read", () => {
    expect(() => converter([{ nome: "x.csv", conteudo: "a,b\n1,2\n" }])).toThrow(/^x\.csv: formato não reconhecido/);
  });
});

describe("CSV do app", () => {
  it("round-trips, commas and quotes included", () => {
    const linhas = [...lerArquivo(NEON).linhas, ...lerArquivo(NUBANK).linhas];
    linhas[0] = { ...linhas[0], descricao: 'Loja "A", filial 2' };
    const again = lerArquivo(paraCsv(linhas));
    expect(again.formato).toBe("CSV");
    expect(again.linhas).toEqual(linhas);
  });

  it("parses quoted fields", () => {
    expect(parseCsv('a,"b,c","d ""e"""\r\n\r\n1,2,3')).toEqual([["a", "b,c", 'd "e"'], ["1", "2", "3"]]);
  });

  it("refuses a bad value with the line number", () => {
    expect(() => lerArquivo("conta,titular,data,hora,descricao,valor,saldo,id\nX,,2026-01-01,,algo,abc,,")).toThrow(/linha 2: valor inválido/);
  });
});

describe("análise", () => {
  it("finds the other side of a row in both banks' wording", () => {
    expect(contraparteDe("PIX enviado para Joao Teste Souza")).toBe("Joao Teste Souza");
    expect(contraparteDe("TED Enviada para Maria Teste")).toBe("Maria Teste");
    expect(contraparteDe("Transferência recebida pelo Pix - Maria Teste da Silva - •••.000.000-•• - NEON (0536) Agência: 655 Conta: 1-8")).toBe("Maria Teste da Silva");
    expect(contraparteDe("Compra no débito - FARMACIA EXEMPLO")).toBe("FARMACIA EXEMPLO");
    expect(contraparteDe("Pagamento de boleto efetuado - ESCOLA - SOCIEDADE LTDA.")).toBe("ESCOLA - SOCIEDADE LTDA.");
    expect(contraparteDe("NETFLIX.COM SAO PAULO BR")).toBe("NETFLIX.COM SAO PAULO BR");
    expect(contraparteDe("Plano Nucel - Conta")).toBe("Plano Nucel - Conta");
    expect(contraparteDe("ESCOLA - SOCIEDADE EDUCACIONAL LTDA.")).toBe("ESCOLA - SOCIEDADE EDUCACIONAL LTDA.");
    expect(contraparteDe("Estorno - Transferência enviada pelo Pix - Joao Teste Souza - doc - BANCO X Agência: 1 Conta: 9")).toBe("Joao Teste Souza");
  });

  it("knows a transfer between people from a purchase", () => {
    for (const d of ["PIX enviado para Joao Teste", "TED Enviada para Maria", "Transferência recebida pelo Pix - Maria - doc - banco", "Estorno - Transferência enviada pelo Pix - Joao"]) {
      expect(ehTransferencia(d), d).toBe(true);
    }
    for (const d of ["Compra no débito - PADARIA", "NETFLIX.COM SAO PAULO BR", "Resgate RDB"]) expect(ehTransferencia(d), d).toBe(false);
  });

  it("knows an investment move", () => {
    for (const d of ["Aplicação em Planejado", "Resgate em Corrente, pode mexer", "Complemento de resgate em Planejado", "Resgate RDB", "Aplicação RDB"]) {
      expect(ehInvestimento(d), d).toBe(true);
    }
    expect(ehInvestimento("PIX enviado para RESGATE LTDA")).toBe(false);
  });

  it("classifies a Neon statement: investments and transfers to the holder stay out", () => {
    const rows = analisar(lerArquivo(NEON).linhas, ctx());
    expect(rows.map((r) => r.status)).toEqual(["novo", "novo", "novo", "investimento", "investimento", "interna", "novo"]);
    expect(rows.map((r) => r.acao)).toEqual(["importar", "importar", "importar", "ignorar", "ignorar", "ignorar", "importar"]);
  });

  it("classifies a Nubank statement: reversal pair, investment, and a transfer from a known holder", () => {
    const rows = analisar(lerArquivo(NUBANK).linhas, ctx({ titulares: new Set([normalizar("Maria Teste da Silva")]) }));
    expect(rows.map((r) => r.status)).toEqual(["novo", "novo", "investimento", "interna", "estorno", "estorno"]);
  });

  it("pairs a row with the nearest entry of the same value, each entry once", () => {
    const linhas = lerArquivo(NEON).linhas;
    const rows = analisar(
      linhas,
      ctx({
        existentes: [
          ex(1, "2026-08-22", "out", 4490), // 4 days after the Netflix row
          ex(2, "2026-08-18", "out", 4490), // same day: the better match
          ex(3, "2026-08-18", "in", 4490), // other direction
          ex(4, "2026-09-10", "out", 7786), // too far from the market row
        ],
      }),
    );
    expect(rows[1].status).toBe("duplicata");
    expect(rows[1].match?.id).toBe(2);
    expect(rows[1].acao).toBe("vincular");
    expect(rows[6].status).toBe("novo");
  });

  it("between two entries of the same day and value, the one with the same name is the match", () => {
    const l = lerArquivo("conta,titular,data,hora,descricao,valor,saldo,id\nX,,2026-10-18,20:34,PIX enviado para FULANO BELTRANO,-50.00,,i1\nX,,2026-10-19,,Compra no débito - POSTO,-50.00,,i2\n").linhas;
    const gasosa = { ...ex(1, "2026-10-18", "out", 5000), payee: "Gasosa" };
    const fulano = { ...ex(2, "2026-10-18", "out", 5000), payee: "Fulano Beltrano" };
    const rows = analisar(l, ctx({ existentes: [gasosa, fulano] }));
    expect(rows.map((r) => r.match?.id)).toEqual([2, 1]);
  });

  it("two equal rows take two entries; a third stays new", () => {
    const l = lerArquivo("conta,titular,data,hora,descricao,valor,saldo,id\nX,,2026-10-23,,Bolo,-45.00,,i1\nX,,2026-10-23,,Bolo,-45.00,,i2\nX,,2026-10-23,,Bolo,-45.00,,i3\n").linhas;
    const rows = analisar(l, ctx({ existentes: [ex(1, "2026-10-23", "out", 4500), ex(2, "2026-10-23", "out", 4500)] }));
    expect(rows.map((r) => r.status)).toEqual(["duplicata", "duplicata", "novo"]);
    expect(new Set(rows.map((r) => r.match?.id))).toEqual(new Set([1, 2, undefined]));
  });

  it("a row imported, ignored, or older than the ledger is not offered as new", () => {
    const linhas = lerArquivo(NEON).linhas;
    const rows = analisar(linhas, ctx({ importados: new Set([refDe(linhas[1])]), ignorados: new Set([refDe(linhas[2])]), inicio: "2026-08-25" }));
    expect(rows.map((r) => r.status)).toEqual(["anterior", "importado", "ignorado", "investimento", "investimento", "interna", "novo"]);
  });

  it("an entry already tied to a statement row is not matched again", () => {
    const linhas = lerArquivo(NEON).linhas;
    const rows = analisar(linhas, ctx({ existentes: [ex(1, "2026-08-18", "out", 4490, "outra-linha")] }));
    expect(rows[1].status).toBe("novo");
  });

  it("suggests the name and category last used for the same counterparty, same direction only", () => {
    const linhas = lerArquivo(NEON).linhas;
    const rows = analisar(
      linhas,
      ctx({
        aprendido: new Map([
          ["MERCADO EXEMPLO LTDA", { category_id: 7, payee: "Mercado", kind: "out" }],
          ["IMOBILIARIA EXEMPLO LTDA", { category_id: 9, payee: "Aluguel", kind: "out" }],
        ]),
      }),
    );
    expect(rows[6]).toMatchObject({ payee: "Mercado", category_id: 7 });
    expect(rows[0]).toMatchObject({ payee: "Aluguel", category_id: null });
  });
});
