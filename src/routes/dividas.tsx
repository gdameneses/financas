// Dívidas: the núcleo's main debts. Every member sees them; núcleo admins add, edit and delete.
// The balance is updated by hand; nothing deducts it automatically (Gus's call).
import { Hono } from "hono";
import type { AppEnv } from "../env";
import { Layout } from "../pages/layout";
import { Icon } from "../pages/bits";
import { createDebt, deleteDebt, getDebt, listDebts, updateDebt, type Debt, type DebtInput } from "../db";
import { debtPayoff } from "../lib/projecoes";
import { dateLabel, monthLabel } from "../lib/dates";
import { formatBRL, parseBRL } from "../lib/money";
import { parseId, requireNucleoAdmin } from "../middleware";

export const dividas = new Hono<AppEnv>();

const cents = (n: number) => (n / 100).toFixed(2).replace(".", ",");
const rate = (bp: number | null) => (bp === null ? "" : (bp / 100).toFixed(2).replace(".", ","));

/** "termina em mar/2028 · R$ 1.234,00 de juros", or why it never ends. */
export function payoffText(d: Debt): string {
  const p = debtPayoff(d);
  if (p.status === "quitada") return "quitada";
  if (p.status === "nunca") return p.reason === "sem parcela" ? "sem parcela definida" : "a parcela não cobre os juros";
  const juros = d.interest_bp ? ` · ${formatBRL(p.interest)} de juros` : "";
  return `termina em ${monthLabel(p.end_month)} (${p.months} ${p.months === 1 ? "mês" : "meses"})${juros}`;
}

export const DebtRow = ({ d, link = true }: { d: Debt; link?: boolean }) => {
  const body = (
    <>
      <span class="ico">
        <Icon name="credit-card" />
      </span>
      <span class="txt">
        <b>{d.name}</b>
        <small>
          {d.creditor ? `${d.creditor} · ` : ""}
          {d.installment_cents ? `${formatBRL(d.installment_cents)}/mês` : "sem parcela"}
          {d.due_day ? ` · vence dia ${d.due_day}` : ""}
        </small>
        <small>{payoffText(d)}</small>
      </span>
      <span class="amt out">{formatBRL(d.balance_cents)}</span>
    </>
  );
  return <li>{link ? <a href={`/dividas/${d.id}`} class="tx">{body}</a> : <div class="tx">{body}</div>}</li>;
};

const DebtForm = ({ d, error }: { d?: Debt; error?: string }) => (
  <form method="post" action={d ? `/dividas/${d.id}` : "/dividas/nova"} class="stack debtform">
    {error ? <p class="err">{error}</p> : null}
    <label>
      Nome
      <input name="name" value={d?.name ?? ""} placeholder="Financiamento do carro, cartão…" required maxlength={60} autofocus={!d} />
    </label>
    <label>
      Credor
      <input name="creditor" value={d?.creditor ?? ""} placeholder="Banco, loja, pessoa" maxlength={60} />
    </label>
    <div class="row">
      <label>
        Saldo devedor (R$)
        <input name="balance" inputmode="decimal" value={d ? cents(d.balance_cents) : ""} placeholder="0,00" required />
      </label>
      <label>
        Parcela mensal (R$)
        <input name="installment" inputmode="decimal" value={d ? cents(d.installment_cents) : ""} placeholder="0,00" />
      </label>
    </div>
    <div class="row">
      <label>
        Vence no dia
        <input name="due_day" inputmode="numeric" value={d?.due_day ?? ""} placeholder="10" />
      </label>
      <label>
        Juros % ao mês
        <input name="interest" inputmode="decimal" value={rate(d?.interest_bp ?? null)} placeholder="opcional" />
      </label>
    </div>
    <label>
      Observação
      <input name="note" value={d?.note ?? ""} maxlength={200} />
    </label>
    {d ? <p class="muted">Saldo atualizado em {dateLabel(d.updated_at.slice(0, 10))}/{d.updated_at.slice(0, 4)}. Ele só muda quando você edita aqui.</p> : null}
    <div class="actions">
      <a href="/dividas" class="btn ghost">
        Cancelar
      </a>
      <button type="submit" class="btn primary">
        {d ? "Salvar" : "Cadastrar"}
      </button>
    </div>
  </form>
);

function parseDebtForm(f: Record<string, unknown>): { ok: true; d: DebtInput } | { ok: false; error: string } {
  const name = String(f.name ?? "").trim().slice(0, 60);
  if (!name) return { ok: false, error: "Dê um nome para a dívida." };
  const balance = parseBRL(String(f.balance ?? ""));
  if (balance === null || balance < 0) return { ok: false, error: "Saldo devedor inválido." };
  const rawInst = String(f.installment ?? "").trim();
  const installment = rawInst === "" ? 0 : parseBRL(rawInst);
  if (installment === null || installment < 0) return { ok: false, error: "Parcela inválida." };
  const rawDay = String(f.due_day ?? "").trim();
  const due = rawDay === "" ? null : Number(rawDay);
  if (due !== null && !(Number.isInteger(due) && due >= 1 && due <= 31)) return { ok: false, error: "Dia de vencimento entre 1 e 31." };
  const rawRate = String(f.interest ?? "").trim().replace(",", ".");
  const pctRate = rawRate === "" ? null : Number(rawRate);
  if (pctRate !== null && !(Number.isFinite(pctRate) && pctRate >= 0 && pctRate <= 100)) return { ok: false, error: "Juros inválidos." };
  return {
    ok: true,
    d: {
      name,
      creditor: String(f.creditor ?? "").trim().slice(0, 60),
      balance_cents: balance,
      installment_cents: installment,
      due_day: due,
      interest_bp: pctRate === null ? null : Math.round(pctRate * 100),
      note: String(f.note ?? "").trim().slice(0, 200),
    },
  };
}

dividas.get("/dividas", async (c) => {
  const admin = c.get("nucleo").role === "admin";
  const debts = await listDebts(c.env.DB, c.get("nucleo").id);
  const open = debts.filter((d) => d.balance_cents > 0);
  const paid = debts.filter((d) => d.balance_cents === 0);
  return c.html(
    <Layout title="Dívidas" active="dividas" toast={c.req.query("ok") ?? undefined}>
      <section class="hero small">
        <small>Total devido · {c.get("nucleo").name}</small>
        <h1 class={open.length ? "neg" : ""}>{formatBRL(open.reduce((a, d) => a + d.balance_cents, 0))}</h1>
        <small>parcelas {formatBRL(open.reduce((a, d) => a + d.installment_cents, 0))}/mês</small>
      </section>
      {open.length ? (
        <ul class="txlist debts">
          {open.map((d) => (
            <DebtRow d={d} link={admin} />
          ))}
        </ul>
      ) : (
        <p class="muted">Nenhuma dívida em aberto.</p>
      )}
      {paid.length ? (
        <>
          <h2>Quitadas</h2>
          <ul class="txlist debts">
            {paid.map((d) => (
              <DebtRow d={d} link={admin} />
            ))}
          </ul>
        </>
      ) : null}
      {admin ? (
        <p>
          <a href="/dividas/nova" class="btn primary">
            Cadastrar dívida
          </a>
        </p>
      ) : null}
      <p class="muted">O saldo devedor não muda sozinho: atualize-o editando a dívida. O fim e os juros são calculados com a parcela atual.</p>
    </Layout>,
  );
});

dividas.get("/dividas/nova", requireNucleoAdmin, (c) =>
  c.html(
    <Layout title="Nova dívida" bare>
      <h1>Nova dívida</h1>
      <DebtForm />
    </Layout>,
  ),
);

dividas.post("/dividas/nova", requireNucleoAdmin, async (c) => {
  const parsed = parseDebtForm(await c.req.parseBody());
  if (!parsed.ok) {
    return c.html(
      <Layout title="Nova dívida" bare>
        <h1>Nova dívida</h1>
        <DebtForm error={parsed.error} />
      </Layout>,
      400,
    );
  }
  await createDebt(c.env.DB, c.get("nucleo").id, parsed.d);
  return c.redirect(`/dividas?ok=${encodeURIComponent("Dívida cadastrada")}`);
});

dividas.get("/dividas/:id", requireNucleoAdmin, async (c) => {
  const id = parseId(c.req.param("id"));
  const d = id === null ? null : await getDebt(c.env.DB, c.get("nucleo").id, id);
  if (!d) return c.notFound();
  return c.html(
    <Layout title="Editar dívida" bare>
      <h1>Editar dívida</h1>
      <DebtForm d={d} />
      <form method="post" action={`/dividas/${d.id}/excluir`} onsubmit="return confirm('Excluir esta dívida?')">
        <button type="submit" class="btn danger">
          Excluir
        </button>
      </form>
    </Layout>,
  );
});

dividas.post("/dividas/:id", requireNucleoAdmin, async (c) => {
  const id = parseId(c.req.param("id"));
  const n = c.get("nucleo").id;
  const d = id === null ? null : await getDebt(c.env.DB, n, id);
  if (!d) return c.notFound();
  const parsed = parseDebtForm(await c.req.parseBody());
  if (!parsed.ok) {
    return c.html(
      <Layout title="Editar dívida" bare>
        <h1>Editar dívida</h1>
        <DebtForm d={d} error={parsed.error} />
      </Layout>,
      400,
    );
  }
  await updateDebt(c.env.DB, n, d.id, parsed.d);
  return c.redirect(`/dividas?ok=${encodeURIComponent("Dívida salva")}`);
});

dividas.post("/dividas/:id/excluir", requireNucleoAdmin, async (c) => {
  const id = parseId(c.req.param("id"));
  const n = c.get("nucleo").id;
  const d = id === null ? null : await getDebt(c.env.DB, n, id);
  if (!d) return c.notFound();
  await deleteDebt(c.env.DB, n, d.id);
  return c.redirect(`/dividas?ok=${encodeURIComponent("Dívida excluída")}`);
});
