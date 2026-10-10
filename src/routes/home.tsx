import { Hono } from "hono";
import type { AppEnv } from "../env";
import { Layout } from "../pages/layout";
import { ChartData, ChartJs, Icon, MonthNav, TxList } from "../pages/bits";
import { listTransactions, totalsByCategory, totalsByDay } from "../db";
import { buildOrcamento } from "../reports/orcamento";
import { activeAlerts, alertMessage, dismissAlert, noteAlert, syncAlerts } from "../alerts";
import { addDays, currentMonth, dateLabel, isMonth, todayISO, weekdayLabel } from "../lib/dates";
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
  const today = todayISO();
  const weekFrom = addDays(today, -6);
  const [totals, txs, plan, alerts, days] = await Promise.all([
    totalsByCategory(db, month),
    listTransactions(db, { month, limit: admin ? 8 : 20 }),
    buildOrcamento(db, month),
    activeAlerts(db, month),
    isCurrent ? totalsByDay(db, weekFrom, today) : Promise.resolve([]),
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
    colors: planned.map((l) => l.color),
    elapsedPct: plan.elapsed_pct,
  };
  // Up to 7 days ending today, starting at the first day that has anything: one day of data = one bar.
  const firstWithData = days.length ? days[0].date : today;
  const start = firstWithData > weekFrom ? firstWithData : weekFrom;
  const nDays = Math.round((Date.parse(today) - Date.parse(start)) / 86_400_000) + 1;
  const week = Array.from({ length: nDays }, (_, i) => addDays(start, i)).map((d) => {
    const row = days.find((x) => x.date === d);
    return { date: d, label: `${weekdayLabel(d)} ${dateLabel(d).slice(0, 2)}`, expense: row?.expense ?? 0, income: row?.income ?? 0, count: row?.count ?? 0 };
  });
  const weekExpense = week.reduce((a, d) => a + d.expense, 0);
  // Expenses only: a salary landing inside the window would flatten every other bar.
  const weekChart = { labels: week.map((d) => d.label), expense: week.map((d) => d.expense), counts: week.map((d) => d.count) };

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
        <details class="card fold" id="fold-plano" open>
          <summary>
            <span>Real × planejado</span>
            <a href={`/planejamento?mes=${month}`}>ver tudo</a>
          </summary>
          <div class="chartbox" style={`height:${Math.max(150, planned.length * 36)}px`}>
            <canvas id="plan" data-src="plan-data"></canvas>
          </div>
          <ChartData id="plan-data" data={planChart} />
          <p class="muted legendline">
            <i class="sw solid"></i> gasto <i class="sw faded"></i> planejado <i class="sw tick"></i> onde deveria estar hoje
          </p>
        </details>
      ) : null}

      {isCurrent ? (
        <details class="card fold" id="fold-semana" open>
          <summary>
            <span>Últimos 7 dias</span>
            <b class="neg">− {formatBRL(weekExpense)}</b>
          </summary>
          <div class="chartbox" style="height:160px">
            <canvas id="week" data-src="week-data"></canvas>
          </div>
          <ChartData id="week-data" data={weekChart} />
        </details>
      ) : null}

      {out.length ? (
        <details class="card fold" id="fold-categorias" open>
          <summary>
            <span>Para onde foi</span>
            <b class="neg">− {formatBRL(expense)}</b>
          </summary>
          <div class="donutrow" id="donutrow">
            <div class="donutwrap">
              <canvas id="donut" data-src="donut-data"></canvas>
            </div>
            <ul class="legend">
              {out.map((t) => (
                <li>
                  <i style={`background:${t.color ?? "#7d7d7d"}`}></i>
                  <span>{t.name ?? "Sem categoria"}</span>
                  <b>{formatBRL(t.total)}</b>
                </li>
              ))}
            </ul>
          </div>
          <p class="center expandline">
            <a href="#" data-expand="donutrow">ver detalhes</a>
          </p>
          <ChartData id="donut-data" data={donut} />
        </details>
      ) : null}
      {out.length || planned.length || isCurrent ? <ChartJs /> : null}

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
