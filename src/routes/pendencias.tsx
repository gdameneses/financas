// Pendências: statement rows waiting for someone to say what they were. Núcleo admins only.
// Each open item can be launched as an entry, marked as a transfer between the núcleo's own
// accounts, or left out; a note can be saved without deciding. Anything decided can be reopened.
import { Hono } from "hono";
import type { AppEnv } from "../env";
import { Layout } from "../pages/layout";
import { Icon } from "../pages/bits";
import { listCategories, type Category } from "../db";
import { dateLabel } from "../lib/dates";
import { formatBRL } from "../lib/money";

export const pendencias = new Hono<AppEnv>();

export type Pendencia = {
  id: number;
  conta: string;
  date: string;
  hora: string;
  amount_cents: number;
  kind: "in" | "out";
  descricao: string;
  ref: string | null;
  sugestao_payee: string;
  sugestao_category_id: number | null;
  status: "aberta" | "lancada" | "interna" | "ignorada";
  resposta: string;
  transaction_id: number | null;
  resolved_by: number | null;
  resolved_at: string | null;
  resolved_email: string | null;
};

const MAX_TEXTO = 300;

/** Open items of a núcleo: the count Mais and the home page show. */
export async function countPendencias(db: D1Database, nucleoId: number): Promise<number> {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM pendencias WHERE nucleo_id = ? AND status = 'aberta'").bind(nucleoId).first<{ n: number }>();
  return r?.n ?? 0;
}

async function listPendencias(db: D1Database, nucleoId: number): Promise<Pendencia[]> {
  const r = await db
    .prepare(
      `SELECT p.*, u.email AS resolved_email FROM pendencias p LEFT JOIN users u ON u.id = p.resolved_by
       WHERE p.nucleo_id = ? ORDER BY p.date, p.hora, p.id`,
    )
    .bind(nucleoId)
    .all<Pendencia>();
  return r.results;
}

async function getPendencia(db: D1Database, nucleoId: number, id: number): Promise<Pendencia | null> {
  if (!Number.isInteger(id) || id <= 0) return null;
  return db
    .prepare("SELECT p.*, NULL AS resolved_email FROM pendencias p WHERE p.id = ? AND p.nucleo_id = ?")
    .bind(id, nucleoId)
    .first<Pendencia>();
}

const texto = (v: unknown) => String(v ?? "").trim().slice(0, MAX_TEXTO);
const quem = (email: string | null) => (email ? email.split("@")[0] : "alguém");

const ESTADO: Record<Exclude<Pendencia["status"], "aberta">, string> = {
  lancada: "Lançada",
  interna: "Entre nossas contas",
  ignorada: "Ignorada",
};

const Valor = ({ p }: { p: Pendencia }) => (
  <b class={`amt ${p.kind}`}>
    {p.kind === "in" ? "+ " : "− "}
    {formatBRL(p.amount_cents)}
  </b>
);

const Aberta = ({ p, cats }: { p: Pendencia; cats: Category[] }) => {
  const opcoes = cats.filter((c) => c.kind === p.kind && !c.ajuste);
  return (
    <li class={`card pend ${p.kind}`} id={`p${p.id}`}>
      <div class="pend-head">
        <span class="txt">
          <small>
            {dateLabel(p.date)}
            {p.hora ? ` · ${p.hora}` : ""} · {p.conta}
          </small>
          <span class="pend-desc">{p.descricao}</span>
        </span>
        <Valor p={p} />
      </div>
      <form method="post" action={`/pendencias/${p.id}`} class="stack pend-form">
        <label>
          {p.kind === "in" ? "De onde veio" : "Para onde foi"}
          <textarea name="resposta" rows={2} maxlength={MAX_TEXTO} placeholder={p.kind === "in" ? "Quem mandou, por quê" : "Para quem, o que era"}>
            {p.resposta}
          </textarea>
        </label>
        <div class="row pend-fields">
          <label>
            Nome
            <input name="payee" value={p.sugestao_payee} maxlength={120} autocomplete="off" />
          </label>
          <label>
            Categoria
            <select name="category_id">
              <option value="">Sem categoria</option>
              {opcoes.map((c) => (
                <option value={String(c.id)} selected={c.id === p.sugestao_category_id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div class="pend-actions">
          <button type="submit" name="op" value="lancar" class="btn primary">
            <Icon name="check" /> Lançar
          </button>
          <button type="submit" name="op" value="interna" class="btn">
            <Icon name="bank" /> Entre nossas contas
          </button>
          <button type="submit" name="op" value="ignorar" class="btn ghost">
            <Icon name="x" /> Ignorar
          </button>
          <button type="submit" name="op" value="nota" class="btn ghost">
            Só salvar a nota
          </button>
        </div>
      </form>
    </li>
  );
};

const Resolvida = ({ p }: { p: Pendencia }) => (
  <li class="pend-done">
    <span class="txt">
      <b>
        {dateLabel(p.date)} · {p.conta} · {p.kind === "in" ? "+" : "−"} {formatBRL(p.amount_cents)}
      </b>
      <small>
        {ESTADO[p.status as Exclude<Pendencia["status"], "aberta">]} por {quem(p.resolved_email)}
        {p.resposta ? ` · ${p.resposta}` : ""}
      </small>
    </span>
    <form method="post" action={`/pendencias/${p.id}/reabrir`}>
      <button type="submit" class="btn small ghost">
        Reabrir
      </button>
    </form>
  </li>
);

pendencias.get("/", async (c) => {
  const nucleo = c.get("nucleo");
  const [itens, cats] = await Promise.all([listPendencias(c.env.DB, nucleo.id), listCategories(c.env.DB, nucleo.id)]);
  const abertas = itens.filter((p) => p.status === "aberta");
  const feitas = itens.filter((p) => p.status !== "aberta").reverse();
  return c.html(
    <Layout title="Pendências" active="mais" toast={c.req.query("ok") ?? undefined}>
      <h1>Pendências</h1>
      <p class="muted">
        Linhas de extrato que ainda não dá para saber o que foram. Escreva para onde foi o dinheiro (ou de onde veio) e escolha: lançar como gasto ou
        entrada, marcar como transferência entre contas do núcleo, ou ignorar. "Só salvar a nota" guarda o texto e deixa em aberto.
      </p>
      {abertas.length ? (
        <ul class="pendlist">
          {abertas.map((p) => (
            <Aberta p={p} cats={cats} />
          ))}
        </ul>
      ) : (
        <p class="card muted">Nada pendente.</p>
      )}
      {feitas.length ? (
        <details class="fold card">
          <summary>
            <span>Resolvidas</span>
            <small>{feitas.length}</small>
          </summary>
          <ul class="devlist pend-donelist">
            {feitas.map((p) => (
              <Resolvida p={p} />
            ))}
          </ul>
        </details>
      ) : null}
    </Layout>,
  );
});

pendencias.post("/:id", async (c) => {
  const nucleo = c.get("nucleo");
  const user = c.get("user");
  const db = c.env.DB;
  const p = await getPendencia(db, nucleo.id, Number(c.req.param("id")));
  if (!p) return c.text("Não encontrado", 404);
  if (p.status !== "aberta") return c.redirect("/pendencias?ok=" + encodeURIComponent("Essa já foi resolvida."));
  const form = await c.req.parseBody();
  const op = String(form.op ?? "");
  const resposta = texto(form.resposta);

  if (op === "nota") {
    await db.prepare("UPDATE pendencias SET resposta = ? WHERE id = ? AND nucleo_id = ? AND status = 'aberta'").bind(resposta, p.id, nucleo.id).run();
    return c.redirect(`/pendencias?ok=${encodeURIComponent("Nota salva.")}#p${p.id}`);
  }

  if (op === "lancar") {
    const payee = texto(form.payee).slice(0, 120) || p.sugestao_payee || p.descricao.slice(0, 120);
    let categoryId: number | null = null;
    const rawCat = Number(form.category_id);
    if (form.category_id && Number.isInteger(rawCat)) {
      const cat = await db.prepare("SELECT id, kind FROM categories WHERE id = ? AND nucleo_id = ?").bind(rawCat, nucleo.id).first<{ id: number; kind: string }>();
      if (!cat || cat.kind !== p.kind) return c.text("Categoria inválida", 400);
      categoryId = cat.id;
    }
    // The statement fingerprint goes on the entry unless another entry already carries it.
    const refLivre = p.ref
      ? !(await db.prepare("SELECT 1 FROM transactions WHERE nucleo_id = ? AND import_ref = ?").bind(nucleo.id, p.ref).first())
      : false;
    const ins = await db
      .prepare(
        `INSERT INTO transactions (nucleo_id, date, amount_cents, kind, category_id, payee, note, user_id, import_ref, import_desc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .bind(nucleo.id, p.date, p.amount_cents, p.kind, categoryId, payee, resposta, user.id, refLivre ? p.ref : null)
      .run();
    await db
      .prepare(
        `UPDATE pendencias SET status = 'lancada', resposta = ?, transaction_id = ?, resolved_by = ?, resolved_at = datetime('now')
         WHERE id = ? AND nucleo_id = ?`,
      )
      .bind(resposta, Number(ins.meta.last_row_id), user.id, p.id, nucleo.id)
      .run();
    return c.redirect("/pendencias?ok=" + encodeURIComponent("Lançado."));
  }

  if (op === "interna" || op === "ignorar") {
    const status = op === "interna" ? "interna" : "ignorada";
    const stmts = [
      db
        .prepare(
          `UPDATE pendencias SET status = ?, resposta = ?, resolved_by = ?, resolved_at = datetime('now')
           WHERE id = ? AND nucleo_id = ? AND status = 'aberta'`,
        )
        .bind(status, resposta, user.id, p.id, nucleo.id),
    ];
    // A future import of the same statement skips the row.
    if (p.ref) stmts.push(db.prepare("INSERT OR IGNORE INTO import_ignored (nucleo_id, ref) VALUES (?, ?)").bind(nucleo.id, p.ref));
    await db.batch(stmts);
    return c.redirect("/pendencias?ok=" + encodeURIComponent(op === "interna" ? "Marcada como entre nossas contas." : "Ignorada."));
  }

  return c.text("Ação inválida", 400);
});

pendencias.post("/:id/reabrir", async (c) => {
  const nucleo = c.get("nucleo");
  const db = c.env.DB;
  const p = await getPendencia(db, nucleo.id, Number(c.req.param("id")));
  if (!p) return c.text("Não encontrado", 404);
  if (p.status === "aberta") return c.redirect("/pendencias");
  const stmts: D1PreparedStatement[] = [];
  // Only the entry this page created goes away.
  if (p.status === "lancada" && p.transaction_id) {
    stmts.push(db.prepare("DELETE FROM transactions WHERE id = ? AND nucleo_id = ?").bind(p.transaction_id, nucleo.id));
  }
  if ((p.status === "interna" || p.status === "ignorada") && p.ref) {
    stmts.push(db.prepare("DELETE FROM import_ignored WHERE nucleo_id = ? AND ref = ?").bind(nucleo.id, p.ref));
  }
  stmts.push(
    db
      .prepare(
        "UPDATE pendencias SET status = 'aberta', transaction_id = NULL, resolved_by = NULL, resolved_at = NULL WHERE id = ? AND nucleo_id = ?",
      )
      .bind(p.id, nucleo.id),
  );
  await db.batch(stmts);
  return c.redirect(`/pendencias?ok=${encodeURIComponent("Reaberta.")}#p${p.id}`);
});
