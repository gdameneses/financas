// Importar extrato: bank statements → a review screen → entries, in bulk. Núcleo admins only.
//   1. files (OFX, Nubank CSV, Neon PDF) become one CSV (POST /importar/converter)
//   2. the CSV is compared with the ledger and shown row by row: ticked goes in, with the date,
//      name and category on the row (POST /importar/revisar)
//   3. what the person left ticked is written in one batch (POST /importar/confirmar)
// The CSV travels with the form on every step and is analysed again before anything is written,
// so the server never trusts a row or a status the browser claims.
import { Hono } from "hono";
import { html } from "hono/html";
import type { AppEnv } from "../env";
import { Layout } from "../pages/layout";
import { Icon } from "../pages/bits";
import { applyImport, deleteTitular, importContext, listCategories, listTitulares, type Category, type ImportPlan } from "../db";
import { addDays, dateLabel, isISODate } from "../lib/dates";
import { formatBRL } from "../lib/money";
import { converter, ExtratoError, paraCsv, type Linha } from "../lib/extrato";
import { analisar, JANELA_DIAS, normalizar, type Analisada, type Status } from "../lib/importacao";

export const importar = new Hono<AppEnv>();

const MAX_BYTES = 2_000_000;
const MAX_LINHAS = 2000;

// Rows that are not entries. They are listed, closed, under the table; ticking one still imports it.
const SECOES: { status: Status; titulo: string; nota: string }[] = [
  { status: "interna", titulo: "Entre contas do núcleo", nota: "Transferências entre titulares do núcleo. Não são lançadas." },
  { status: "investimento", titulo: "Investimentos", nota: "Aplicações e resgates. Não são lançados." },
  { status: "estorno", titulo: "Estornados", nota: "Um lançamento e o seu estorno: um anula o outro." },
  { status: "anterior", titulo: "Antes do primeiro lançamento", nota: "Mais antigos que o primeiro lançamento do núcleo." },
  { status: "ignorado", titulo: "Ignorados antes", nota: "Você já deixou estas linhas de fora em outra importação." },
  { status: "importado", titulo: "Já importados", nota: "Estas linhas já viraram ou foram vinculadas a um lançamento." },
];

function ler(texto: string): { linhas: Linha[] } | { erro: string } {
  if (!texto.trim()) return { erro: "Escolha um arquivo ou cole o conteúdo do extrato." };
  if (texto.length > MAX_BYTES) return { erro: "Extrato grande demais. Importe um período menor." };
  try {
    const { linhas } = converter([{ nome: "extrato", conteudo: texto }]);
    if (!linhas.length) return { erro: "O extrato não tem lançamentos." };
    if (linhas.length > MAX_LINHAS) return { erro: `São ${linhas.length} linhas; o limite é ${MAX_LINHAS} por vez.` };
    return { linhas };
  } catch (e) {
    if (e instanceof ExtratoError) return { erro: e.message };
    throw e;
  }
}

async function analisarNoNucleo(db: D1Database, nucleoId: number, linhas: Linha[]): Promise<Analisada[]> {
  const datas = linhas.map((l) => l.data).sort();
  const ctx = await importContext(db, nucleoId, addDays(datas[0], -JANELA_DIAS), addDays(datas[datas.length - 1], JANELA_DIAS));
  return analisar(linhas, ctx);
}

const StartPage = ({ erro, texto, titulares, ok }: { erro?: string; texto?: string; titulares: string[]; ok?: string }) => (
  <Layout title="Importar extrato" active="mais" toast={ok}>
    <h1>Importar extrato</h1>
    <p class="muted">
      Extrato em OFX (Nubank e a maioria dos bancos), CSV do Nubank ou PDF do Neon. Pode escolher vários arquivos de uma vez; linhas repetidas
      entre eles contam uma vez só. Nada é lançado antes de você revisar.
    </p>
    {erro ? <p class="err">{erro}</p> : null}
    <form method="post" action="/importar/revisar" class="stack" id="impstart">
      <label>
        Arquivos do extrato
        <input type="file" id="impfiles" multiple accept=".ofx,.csv,.pdf,.txt" />
      </label>
      <p class="muted small-note" id="impstatus" aria-live="polite"></p>
      <details open={!!texto}>
        <summary>CSV das linhas lidas</summary>
        <label>
          Conferir, editar ou colar aqui (OFX e CSV também valem)
          <textarea name="csv" id="impcsv" rows={8} spellcheck={false}>
            {texto ?? ""}
          </textarea>
        </label>
        <p class="downloads">
          <a href="#" id="impdownload" hidden>
            <Icon name="download-simple" /> Baixar este CSV
          </a>
        </p>
      </details>
      <button type="submit" class="btn primary">
        Analisar
      </button>
    </form>
    <h2>Titulares das contas</h2>
    <p class="muted small-note">
      Transferência de ou para um destes nomes é dinheiro andando entre contas do núcleo e fica fora da importação. O titular de cada extrato entra
      aqui sozinho; os outros você marca na revisão.
    </p>
    {titulares.length ? (
      <ul class="devlist">
        {titulares.map((nome) => (
          <li>
            <span class="txt">
              <b>{nome}</b>
            </span>
            <form method="post" action="/importar/titulares/excluir">
              <input type="hidden" name="nome" value={nome} />
              <button type="submit" class="btn small ghost">
                Remover
              </button>
            </form>
          </li>
        ))}
      </ul>
    ) : (
      <p class="muted">Nenhum ainda.</p>
    )}
    {html`<script type="module" src="/importar.js"></script>`}
  </Layout>
);

importar.get("/", async (c) => {
  const titulares = await listTitulares(c.env.DB, c.get("nucleo").id);
  return c.html(<StartPage titulares={titulares} ok={c.req.query("ok") ?? undefined} />);
});

// Files → CSV, for importar.js. A custom header means a cross-site form can never take this path.
importar.post("/converter", async (c) => {
  if (c.req.header("x-fetch") !== "1") return c.json({ error: "Pedido inválido." }, 400);
  const body = await c.req.json<{ arquivos?: { nome?: unknown; conteudo?: unknown }[] }>().catch(() => null);
  const arquivos = (body?.arquivos ?? []).map((a) => ({ nome: String(a.nome ?? "arquivo").slice(0, 120), conteudo: String(a.conteudo ?? "") }));
  if (!arquivos.length) return c.json({ error: "Nenhum arquivo." }, 400);
  if (arquivos.reduce((n, a) => n + a.conteudo.length, 0) > MAX_BYTES) return c.json({ error: "Arquivos grandes demais. Importe um período menor." }, 400);
  try {
    const { linhas, fontes } = converter(arquivos);
    return c.json({ csv: paraCsv(linhas), fontes, linhas: linhas.length });
  } catch (e) {
    if (e instanceof ExtratoError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

const Row = ({ r, cats }: { r: Analisada; cats: Category[] }) => {
  const l = r.linha;
  const fixa = r.status === "importado";
  return (
    <li class={`imp ${r.kind}`} data-chave={r.chave} data-kind={r.kind}>
      {fixa ? (
        <span class="imp-go" />
      ) : (
        <label class="check imp-go" title="Vai para o app">
          <input type="hidden" name={`r${r.n}`} value="1" />
          <input type="checkbox" name={`i${r.n}`} value="1" checked={r.acao === "importar"} class="imp-on" aria-label="Vai para o app" />
        </label>
      )}
      {fixa ? (
        <span class="imp-date muted">{dateLabel(l.data)}</span>
      ) : (
        <input type="date" name={`d${r.n}`} value={l.data} required class="imp-date" aria-label="Data" />
      )}
      <span class="imp-name">
        {fixa ? <b>{r.contraparte}</b> : <input name={`p${r.n}`} value={r.payee} maxlength={80} aria-label="Nome no app" class="imp-payee" autocomplete="off" />}
        <small>
          {l.conta}
          {l.hora ? ` ${l.hora}` : ""} · {l.descricao}
        </small>
      </span>
      <span class={`amt ${r.kind}`}>
        {r.kind === "in" ? "+" : "−"}
        {formatBRL(r.cents)}
      </span>
      {fixa ? (
        <span class="catpick" />
      ) : (
        <span class="catpick" role="radiogroup" aria-label="Categoria">
          {cats
            .filter((cat) => cat.kind === r.kind)
            .map((cat) => (
              <label>
                <input type="radio" name={`c${r.n}`} value={cat.id} checked={cat.id === r.category_id} />
                {cat.name}
              </label>
            ))}
        </span>
      )}
      <span class="imp-dup">
        {r.match ? (
          <a href={`/transacoes/${r.match.id}`} target="_blank" class="match">
            Já no app em {dateLabel(r.match.date)}: {r.match.payee || r.match.category_name || "sem nome"}
            {r.match.payee && r.match.category_name ? ` · ${r.match.category_name}` : ""}
          </a>
        ) : null}
        {!fixa && r.transferencia && r.status !== "interna" ? (
          <label class="check imp-x">
            <input type="checkbox" name={`x${r.n}`} value="1" class="imp-nossa" /> é entre nossas contas
          </label>
        ) : null}
      </span>
    </li>
  );
};

const Head = () => (
  <div class="imp imphead" aria-hidden="true">
    <span />
    <span>Data</span>
    <span>Nome no app</span>
    <span class="amt">Valor</span>
    <span>Categoria</span>
    <span>Já no app?</span>
  </div>
);

importar.post("/revisar", async (c) => {
  const n = c.get("nucleo").id;
  const form = await c.req.parseBody();
  const texto = String(form.csv ?? "");
  const lido = ler(texto);
  if ("erro" in lido) {
    const titulares = await listTitulares(c.env.DB, n);
    return c.html(<StartPage erro={lido.erro} texto={texto.slice(0, MAX_BYTES)} titulares={titulares} />, 400);
  }
  const [rows, cats] = await Promise.all([analisarNoNucleo(c.env.DB, n, lido.linhas), listCategories(c.env.DB, n)]);
  const contas = [...new Set(lido.linhas.map((l) => l.conta))];
  const datas = lido.linhas.map((l) => l.data).sort();
  const aImportar = rows.filter((r) => r.acao === "importar").length;
  // the table: everything that may become an entry, in date order, each with its possible duplicate
  const principais = rows.filter((r) => r.status === "novo" || r.status === "duplicata");
  const dups = principais.filter((r) => r.status === "duplicata").length;
  return c.html(
    <Layout title="Revisar importação" bare wide>
      <h1>Revisar importação</h1>
      <p class="muted">
        {rows.length} linhas de {contas.join(" e ")}, de {dateLabel(datas[0])}/{datas[0].slice(0, 4)} a {dateLabel(datas[datas.length - 1])}/
        {datas[datas.length - 1].slice(0, 4)}. Marcado vai para o app; desmarcado fica de fora e não volta na próxima importação.{" "}
        <a href="#" id="impdownload" hidden>
          Baixar CSV
        </a>
      </p>
      <form method="post" action="/importar/confirmar" id="impform">
        <textarea name="csv" id="impcsv" hidden>
          {paraCsv(lido.linhas)}
        </textarea>
        {principais.length ? (
          <>
            <h2>
              <span>
                Lançamentos do extrato <span class="count">{principais.length}</span>
              </span>
              {dups ? <span class="muted">{dups} já parecem estar no app e vêm desmarcados</span> : null}
            </h2>
            <Head />
            <ul class="implist">
              {principais.map((r) => (
                <Row r={r} cats={cats} />
              ))}
            </ul>
          </>
        ) : (
          <p class="muted">Nenhuma linha nova neste extrato.</p>
        )}
        {SECOES.map((s) => {
          const items = rows.filter((r) => r.status === s.status);
          if (!items.length) return null;
          const entra = items.filter((r) => r.kind === "in").reduce((a, r) => a + r.cents, 0);
          const sai = items.filter((r) => r.kind === "out").reduce((a, r) => a + r.cents, 0);
          return (
            <details class="impsec">
              <summary>
                <b>{s.titulo}</b> <span class="count">{items.length}</span>
                <span class="inout">
                  {entra ? <span class="in">+ {formatBRL(entra)}</span> : null}
                  {sai ? <span class="out">− {formatBRL(sai)}</span> : null}
                </span>
              </summary>
              <p class="muted small-note">{s.nota}</p>
              <ul class="implist">
                {items.map((r) => (
                  <Row r={r} cats={cats} />
                ))}
              </ul>
            </details>
          );
        })}
        <div class="submitbar">
          <div class="actions">
            <a href="/importar" class="btn ghost">
              Cancelar
            </a>
            <button type="submit" class="btn primary" id="impsubmit">
              Salvar ({aImportar} {aImportar === 1 ? "lançamento" : "lançamentos"})
            </button>
          </div>
        </div>
      </form>
      {html`<script type="module" src="/importar.js"></script>`}
    </Layout>,
  );
});

importar.post("/confirmar", async (c) => {
  const n = c.get("nucleo").id;
  const form = await c.req.parseBody();
  const lido = ler(String(form.csv ?? ""));
  if ("erro" in lido) return c.redirect(`/importar?ok=${encodeURIComponent(lido.erro)}`);
  const [rows, cats] = await Promise.all([analisarNoNucleo(c.env.DB, n, lido.linhas), listCategories(c.env.DB, n)]);
  const plan: ImportPlan = { novos: [], vinculos: [], ignorar: [], reviver: [], titulares: [] };
  // the holder printed on a statement is remembered, so the other holder's statement sees the transfers
  const titulares = new Set(lido.linhas.filter((l) => l.titular).map((l) => normalizar(l.titular)));
  for (const r of rows) {
    // a row the form did not send was not on the screen: leave it exactly as it is
    if (form[`r${r.n}`] !== "1" || r.status === "importado") continue;
    if (form[`x${r.n}`] === "1" && r.transferencia) {
      titulares.add(r.chave);
    } else if (form[`i${r.n}`] === "1") {
      const catId = Number(form[`c${r.n}`] ?? "");
      const cat = cats.find((x) => x.id === catId && x.kind === r.kind);
      const payee = String(form[`p${r.n}`] ?? "").trim().slice(0, 80) || r.payee;
      const date = String(form[`d${r.n}`] ?? "");
      plan.novos.push({ date: isISODate(date) ? date : r.linha.data, cents: r.cents, kind: r.kind, cat: cat ? cat.id : null, payee, ref: r.ref, desc: r.chave });
      if (r.status === "ignorado") plan.reviver.push(r.ref);
    } else if (r.match) {
      // left out because it is already there: the entry is tied to this row, nothing is created
      plan.vinculos.push({ id: r.match.id, ref: r.ref, desc: r.chave });
    } else if (r.status === "novo") {
      plan.ignorar.push(r.ref);
    }
  }
  plan.titulares = [...titulares];
  await applyImport(c.env.DB, n, c.get("user").id, plan);
  const partes = [
    `${plan.novos.length} ${plan.novos.length === 1 ? "importado" : "importados"}`,
    plan.vinculos.length ? `${plan.vinculos.length} já ${plan.vinculos.length === 1 ? "estava" : "estavam"} no app` : "",
    plan.ignorar.length ? `${plan.ignorar.length} de fora` : "",
  ].filter(Boolean);
  return c.redirect(`/importar?ok=${encodeURIComponent(partes.join(", "))}`);
});

importar.post("/titulares/excluir", async (c) => {
  const form = await c.req.parseBody();
  await deleteTitular(c.env.DB, c.get("nucleo").id, String(form.nome ?? ""));
  return c.redirect(`/importar?ok=${encodeURIComponent("Titular removido")}`);
});
