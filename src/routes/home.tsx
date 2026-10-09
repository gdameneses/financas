import { Hono } from "hono";
import type { AppEnv } from "../env";
import { Layout } from "../pages/layout";
import { ChartData, ChartJs, MonthNav, TxList } from "../pages/bits";
import { listTransactions, totalsByCategory } from "../db";
import { currentMonth, isMonth } from "../lib/dates";
import { formatBRL } from "../lib/money";

export const home = new Hono<AppEnv>();

home.get("/", async (c) => {
  const q = c.req.query("mes");
  const month = q && isMonth(q) ? q : currentMonth();
  const admin = c.get("user").admin;
  const [totals, txs] = await Promise.all([totalsByCategory(c.env.DB, month), listTransactions(c.env.DB, { month, limit: admin ? 10 : 30 })]);
  const income = totals.filter((t) => t.kind === "in").reduce((a, t) => a + t.total, 0);
  const expense = totals.filter((t) => t.kind === "out").reduce((a, t) => a + t.total, 0);
  const out = totals.filter((t) => t.kind === "out");
  const donut = {
    labels: out.map((t) => t.name ?? "Sem categoria"),
    values: out.map((t) => t.total),
    colors: out.map((t) => t.color ?? "#7d7d7d"),
  };

  return c.html(
    <Layout title="Início" active="home" toast={c.req.query("ok") ?? undefined}>
      <MonthNav month={month} base="/" />
      <section class="hero">
        <small>Saldo do mês</small>
        <h1 class={income - expense >= 0 ? "pos" : "neg"}>{formatBRL(income - expense)}</h1>
        <div class="inout">
          <span class="in">+ {formatBRL(income)}</span>
          <span class="out">− {formatBRL(expense)}</span>
        </div>
      </section>
      {admin && out.length ? (
        <section class="card">
          <div class="donutwrap">
            <canvas id="donut" data-src="donut-data"></canvas>
          </div>
          <ul class="legend">
            {out.slice(0, 6).map((t) => (
              <li>
                <i style={`background:${t.color ?? "#7d7d7d"}`}></i>
                {t.name ?? "Sem categoria"}
                <b>{formatBRL(t.total)}</b>
              </li>
            ))}
          </ul>
          <ChartData id="donut-data" data={donut} />
          <ChartJs />
        </section>
      ) : null}
      <section>
        <h2>
          Últimos lançamentos <a href={`/transacoes?mes=${month}`}>ver todos</a>
        </h2>
        <TxList txs={txs} empty="Nenhum lançamento neste mês. Toque em + para começar." />
      </section>
    </Layout>,
  );
});
