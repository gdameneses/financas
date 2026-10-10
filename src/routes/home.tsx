import { Hono } from "hono";
import type { AppEnv } from "../env";
import { Layout } from "../pages/layout";
import { ChartData, ChartJs, Icon, MonthNav, TxList } from "../pages/bits";
import { listTransactions, totalsByCategory } from "../db";
import { buildOrcamento } from "../reports/orcamento";
import { activeAlerts, alertMessage, dismissAlert, noteAlert, syncAlerts } from "../alerts";
import { currentMonth, isMonth } from "../lib/dates";
import { formatBRL } from "../lib/money";
import { parseId } from "../middleware";

export const home = new Hono<AppEnv>();

home.get("/", async (c) => {
  const q = c.req.query("mes");
  const month = q && isMonth(q) ? q : currentMonth();
  const isCurrent = month === currentMonth();
  const admin = c.get("user").admin;
  const db = c.env.DB;
  if (isCurrent) await syncAlerts(db);
  const [totals, txs, plan, alerts] = await Promise.all([
    totalsByCategory(db, month),
    listTransactions(db, { month, limit: admin ? 8 : 20 }),
    buildOrcamento(db, month),
    activeAlerts(db, month),
  ]);
  const income = totals.filter((t) => t.kind === "in").reduce((a, t) => a + t.total, 0);
  const expense = totals.filter((t) => t.kind === "out").reduce((a, t) => a + t.total, 0);
  const out = totals.filter((t) => t.kind === "out");
  const donut = {
    labels: out.map((t) => t.name ?? "Sem categoria"),
    values: out.map((t) => t.total),
    colors: out.map((t) => t.color ?? "#7d7d7d"),
  };
  const planned = plan.lines.slice(0, 8);
  const planChart = {
    labels: planned.map((l) => l.name),
    planned: planned.map((l) => l.cap),
    actual: planned.map((l) => l.spent),
    projected: planned.map((l) => l.projected),
    colors: planned.map((l) => l.color),
    elapsedPct: plan.elapsed_pct,
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

      {alerts.length ? (
        <section class="alerts">
          {alerts.map((a) => (
            <article class={`alert ${a.level}`}>
              <p>
                <Icon name={a.level === "100" ? "x" : "lightning"} /> {alertMessage(a, formatBRL)}
              </p>
              {a.note ? (
                <p class="note">
                  “{a.note}” <small class="muted">{a.note_email?.split("@")[0]}</small>
                </p>
              ) : null}
              <div class="row">
                <details class="notebox">
                  <summary>{a.note ? "Editar anotação" : "Anotar"}</summary>
                  <form method="post" action={`/avisos/${a.id}/anotar`} class="row">
                    <input name="note" value={a.note} maxlength={200} placeholder="ex.: foi a compra do mês inteiro" required />
                    <button class="btn small">Salvar</button>
                  </form>
                </details>
                <form method="post" action={`/avisos/${a.id}/ignorar`}>
                  <button class="btn small ghost">Ignorar</button>
                </form>
              </div>
            </article>
          ))}
        </section>
      ) : null}

      {planned.length ? (
        <section class="card">
          <h2>
            Real × planejado <a href={`/planejamento?mes=${month}`}>ver tudo</a>
          </h2>
          <canvas id="plan" data-src="plan-data" height={Math.max(140, planned.length * 34)}></canvas>
          <ChartData id="plan-data" data={planChart} />
          <p class="muted legendline">
            <i class="sw solid"></i> gasto <i class="sw faded"></i> planejado <i class="sw tick"></i> onde deveria estar hoje
          </p>
        </section>
      ) : admin ? (
        <p class="muted">
          Sem valores planejados para este mês. <a href={`/planejamento?mes=${month}`}>Planejar</a>.
        </p>
      ) : null}

      {out.length ? (
        <section class="card">
          <h2>Para onde foi</h2>
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
        </section>
      ) : null}
      {out.length || planned.length ? <ChartJs /> : null}

      <section>
        <h2>
          Últimos lançamentos <a href={`/transacoes?mes=${month}`}>ver todos</a>
        </h2>
        <TxList txs={txs} empty="Nenhum lançamento neste mês. Toque em + para começar." />
      </section>
    </Layout>,
  );
});

// Alerts are household-wide: anyone logged in can note or dismiss.
home.post("/avisos/:id/ignorar", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.notFound();
  await dismissAlert(c.env.DB, id, c.get("user").id);
  return c.redirect("/");
});

home.post("/avisos/:id/anotar", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.notFound();
  const form = await c.req.parseBody();
  const note = String(form.note ?? "").trim().slice(0, 200);
  if (note) await noteAlert(c.env.DB, id, c.get("user").id, note);
  return c.redirect("/");
});
