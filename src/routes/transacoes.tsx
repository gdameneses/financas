import { Hono } from "hono";
import type { AppEnv } from "../env";
import { Layout } from "../pages/layout";
import { parseId } from "../middleware";
import { CatIcon, Icon, MonthNav, TxList } from "../pages/bits";
import {
  createTransaction,
  deleteTransaction,
  getTransaction,
  listCategories,
  listPayees,
  listTransactions,
  updateTransaction,
  type Category,
  type Kind,
  type TransactionView,
  type TxInput,
} from "../db";
import { currentMonth, isISODate, isMonth, todayISO } from "../lib/dates";
import { parseBRL } from "../lib/money";

export const transacoes = new Hono<AppEnv>();

type FormProps = {
  cats: Category[];
  payees: string[];
  tx?: TransactionView;
  error?: string;
  back: string;
};

// Order is deliberate: who → how much → which category. Enter on "Destinatário" moves to the
// amount; Enter on the amount drops the keyboard so the category grid is visible (see app.js).
const TxForm = ({ cats, payees, tx, error, back }: FormProps) => {
  const kind: Kind = tx?.kind ?? "out";
  const amount = tx ? (tx.amount_cents / 100).toFixed(2).replace(".", ",") : "";
  return (
    <form method="post" action={tx ? `/transacoes/${tx.id}` : "/nova"} class={`txform ${kind}`} id="txform">
      {error ? <p class="err">{error}</p> : null}
      <div class="kind">
        <label class={kind === "out" ? "on" : ""}>
          <input type="radio" name="kind" value="out" checked={kind === "out"} /> Saída
        </label>
        <label class={kind === "in" ? "on" : ""}>
          <input type="radio" name="kind" value="in" checked={kind === "in"} /> Entrada
        </label>
      </div>
      <label class="field">
        Destinatário ou origem
        <input
          name="payee"
          list="payees"
          value={tx?.payee ?? ""}
          placeholder="Padaria, aluguel, salário"
          maxlength={80}
          autocomplete="off"
          enterkeyhint="next"
          autofocus={!tx}
        />
        <datalist id="payees">
          {payees.map((p) => (
            <option value={p} />
          ))}
        </datalist>
      </label>
      <label class="field amount">
        <span>R$</span>
        <input name="amount" inputmode="decimal" placeholder="0,00" value={amount} required autocomplete="off" enterkeyhint="done" />
      </label>
      <div class="cats">
        {cats.map((cat) => (
          <label class={`chip ${cat.kind} ${tx?.category_id === cat.id ? "on" : ""}`} data-kind={cat.kind}>
            <input type="radio" name="category_id" value={cat.id} checked={tx?.category_id === cat.id} />
            <CatIcon icon={cat.icon} color={cat.color} />
            {cat.name}
          </label>
        ))}
        <label class={`chip any ${tx && tx.category_id === null ? "on" : ""}`} data-kind="any">
          <input type="radio" name="category_id" value="" checked={!!tx && tx.category_id === null} />
          <span class="ico">
            <Icon name="question" />
          </span>
          Sem categoria
        </label>
      </div>
      <details open={!!tx}>
        <summary>Data e observação</summary>
        <label>
          Data
          <input type="date" name="date" value={tx?.date ?? todayISO()} required />
        </label>
        <label>
          Observação
          <input name="note" value={tx?.note ?? ""} maxlength={200} enterkeyhint="done" />
        </label>
      </details>
      <div class="submitbar">
        <div class="actions">
          <a href={back} class="btn ghost">
            Cancelar
          </a>
          <button type="submit" class="btn primary">
            {tx ? "Salvar" : "Adicionar"}
          </button>
        </div>
      </div>
    </form>
  );
};

function parseTxForm(form: Record<string, unknown>, cats: Category[]): { ok: true; tx: TxInput } | { ok: false; error: string } {
  const kind = form.kind === "in" ? "in" : "out";
  const amount = parseBRL(String(form.amount ?? ""));
  if (amount === null || amount <= 0) return { ok: false, error: "Valor inválido." };
  const date = String(form.date ?? "");
  if (!isISODate(date)) return { ok: false, error: "Data inválida." };
  const rawCat = String(form.category_id ?? "");
  let category_id: number | null = null;
  if (rawCat !== "") {
    const id = Number(rawCat);
    const cat = cats.find((c) => c.id === id);
    if (!cat) return { ok: false, error: "Categoria inválida." };
    if (cat.kind !== kind) return { ok: false, error: "A categoria não combina com o tipo." };
    category_id = id;
  }
  return {
    ok: true,
    tx: {
      kind,
      amount_cents: amount,
      date,
      category_id,
      payee: String(form.payee ?? "").trim().slice(0, 80),
      note: String(form.note ?? "").trim().slice(0, 200),
    },
  };
}

transacoes.get("/nova", async (c) => {
  const n = c.get("nucleo").id;
  const [cats, payees] = await Promise.all([listCategories(c.env.DB, n), listPayees(c.env.DB, n)]);
  return c.html(
    <Layout title="Novo lançamento" bare>
      <h1>Novo lançamento</h1>
      <TxForm cats={cats} payees={payees} back="/" />
    </Layout>,
  );
});

transacoes.post("/nova", async (c) => {
  const n = c.get("nucleo").id;
  const [cats, payees, form] = await Promise.all([listCategories(c.env.DB, n), listPayees(c.env.DB, n), c.req.parseBody()]);
  const parsed = parseTxForm(form, cats);
  if (!parsed.ok) {
    return c.html(
      <Layout title="Novo lançamento" bare>
        <h1>Novo lançamento</h1>
        <TxForm cats={cats} payees={payees} error={parsed.error} back="/" />
      </Layout>,
      400,
    );
  }
  await createTransaction(c.env.DB, n, parsed.tx, c.get("user").id);
  return c.redirect(`/?mes=${parsed.tx.date.slice(0, 7)}&ok=${encodeURIComponent("Lançamento adicionado")}`);
});

transacoes.get("/transacoes", async (c) => {
  const q = c.req.query("mes");
  const month = q && isMonth(q) ? q : currentMonth();
  const catQ = c.req.query("cat");
  const categoryId = catQ === "none" ? null : catQ ? Number(catQ) : undefined;
  const n = c.get("nucleo").id;
  const [txs, cats] = await Promise.all([listTransactions(c.env.DB, n, { month, categoryId }), listCategories(c.env.DB, n)]);
  const base = catQ ? `/transacoes?cat=${catQ}` : "/transacoes";
  return c.html(
    <Layout title="Lançamentos" active="tx" toast={c.req.query("ok") ?? undefined}>
      <MonthNav month={month} base={base} />
      <form method="get" action="/transacoes" class="filter">
        <input type="hidden" name="mes" value={month} />
        <select name="cat" onchange="this.form.submit()">
          <option value="">Todas as categorias</option>
          <option value="none" selected={catQ === "none"}>
            Sem categoria
          </option>
          {cats.map((cat) => (
            <option value={cat.id} selected={catQ === String(cat.id)}>
              {cat.name}
            </option>
          ))}
        </select>
      </form>
      <TxList txs={txs} empty={catQ ? "Nenhum lançamento nessa categoria neste mês." : "Nenhum lançamento neste mês. Toque em + para começar."} />
    </Layout>,
  );
});

transacoes.get("/transacoes/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.notFound();
  const n = c.get("nucleo").id;
  const [tx, cats, payees] = await Promise.all([getTransaction(c.env.DB, n, id), listCategories(c.env.DB, n), listPayees(c.env.DB, n)]);
  if (!tx) return c.notFound();
  const back = `/transacoes?mes=${tx.date.slice(0, 7)}`;
  return c.html(
    <Layout title="Editar lançamento" bare>
      <h1>Editar lançamento</h1>
      <TxForm cats={cats} payees={payees} tx={tx} back={back} />
      <form method="post" action={`/transacoes/${tx.id}/excluir`} onsubmit="return confirm('Excluir este lançamento?')">
        <button type="submit" class="btn danger">
          Excluir
        </button>
      </form>
    </Layout>,
  );
});

transacoes.post("/transacoes/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.notFound();
  const n = c.get("nucleo").id;
  const [tx, cats, payees, form] = await Promise.all([
    getTransaction(c.env.DB, n, id),
    listCategories(c.env.DB, n),
    listPayees(c.env.DB, n),
    c.req.parseBody(),
  ]);
  if (!tx) return c.notFound();
  const parsed = parseTxForm(form, cats);
  if (!parsed.ok) {
    return c.html(
      <Layout title="Editar lançamento" bare>
        <h1>Editar lançamento</h1>
        <TxForm cats={cats} payees={payees} tx={tx} error={parsed.error} back="/transacoes" />
      </Layout>,
      400,
    );
  }
  await updateTransaction(c.env.DB, n, id, parsed.tx);
  return c.redirect(`/transacoes?mes=${parsed.tx.date.slice(0, 7)}&ok=${encodeURIComponent("Lançamento salvo")}`);
});

transacoes.post("/transacoes/:id/excluir", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.notFound();
  const n = c.get("nucleo").id;
  const tx = await getTransaction(c.env.DB, n, id);
  if (!tx) return c.notFound();
  await deleteTransaction(c.env.DB, n, id);
  return c.redirect(`/transacoes?mes=${tx.date.slice(0, 7)}&ok=${encodeURIComponent("Lançamento excluído")}`);
});
