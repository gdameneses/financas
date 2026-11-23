import { Hono } from "hono";
import type { AppEnv } from "../env";
import { Layout } from "../pages/layout";
import { ChartData, ChartJs, Icon, PeriodNav, TxList } from "../pages/bits";
import { DebtRow } from "./dividas";
import { ajustesTotal, cashBalance, listCategories, listDebts, listTransactions, totalsByCategory, totalsByDay, totalsByMonth } from "../db";
import { buildOrcamento } from "../reports/orcamento";
import { activeAlerts, alertMessage, dismissAlert, noteAlert, syncAlerts } from "../alerts";
import { addDays, addMonths, currentMonth, dateLabel, daysBetween, monthLabel, parsePeriod, periodQuery, todayISO, weekdayLabel } from "../lib/dates";
import { fimDoMes, proximosMeses } from "../lib/projecoes";
import { getCookie, setCookie } from "hono/cookie";
import { formatBRL } from "../lib/money";
import { parseId } from "../middleware";
import { countPendencias } from "./pendencias";

export const home = new Hono<AppEnv>();

// Last-N-days chart: a few fixed spans; the choice sticks on this device (cookie).
const SPANS = [7, 14, 30, 90] as const;

home.get("/", async (c) => {
  const period = parsePeriod({ mes: c.req.query("mes"), de: c.req.query("de"), ate: c.req.query("ate") });
  const range = { from: period.from, to: period.to };
  // Planning is monthly: a hand-picked period shows the plan of the month it ends in.
  const planMonth = period.kind === "mes" ? period.month : period.to.slice(0, 7);
  const thisMonth = currentMonth();
  const isCurrent = period.kind === "mes" && period.month === thisMonth;
  const nucleo = c.get("nucleo");
  const admin = nucleo.role === "admin";
  const db = c.env.DB;
  const today = todayISO();

  const qd = Number(c.req.query("dias"));
  const cd = Number(getCookie(c, "dias"));
  const span = SPANS.find((n) => n === qd) ?? SPANS.find((n) => n === cd) ?? 7;
  if (SPANS.some((n) => n === qd)) setCookie(c, "dias", String(qd), { path: "/", maxAge: 31_536_000, sameSite: "Lax" });
  const spanFrom = addDays(today, -(span - 1));

  if (planMonth === thisMonth) await syncAlerts(db, nucleo.id);
  // Cash on hand as of the end of what is shown, never past today.
  const cashUpTo = range.to < today ? range.to : today;
  const [totals, ajustes, txs, plan, alerts, days, cash, cats, debts, history, monthTotals, monthAjustes, abertas] = await Promise.all([
    totalsByCategory(db, nucleo.id, range),
    ajustesTotal(db, nucleo.id, range),
    listTransactions(db, nucleo.id, { range, limit: admin ? 8 : 20 }),
    buildOrcamento(db, nucleo.id, planMonth),
    activeAlerts(db, nucleo.id, planMonth),
    totalsByDay(db, nucleo.id, spanFrom, today),
    cashBalance(db, nucleo.id, cashUpTo),
    listCategories(db, nucleo.id),
    listDebts(db, nucleo.id),
    totalsByMonth(db, nucleo.id, addMonths(thisMonth, -3), addMonths(thisMonth, -1)),
    // projections always speak about the current month, whatever period is on screen
    isCurrent ? Promise.resolve(null) : totalsByCategory(db, nucleo.id, thisMonth),
    isCurrent ? Promise.resolve(null) : ajustesTotal(db, nucleo.id, thisMonth),
    admin ? countPendencias(db, nucleo.id) : Promise.resolve(0),
  ]);
  const income = totals.filter((t) => t.kind === "in").reduce((a, t) => a + t.total, 0);
  const expense = totals.filter((t) => t.kind === "out").reduce((a, t) => a + t.total, 0);
  const ajusteNet = ajustes.in - ajustes.out;
  const balance = income - expense + ajusteNet;
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
  // Up to N days ending today, starting at the first day that has anything: one day of data = one bar.
  const firstWithData = days.length ? days[0].date : today;
  const start = firstWithData > spanFrom ? firstWithData : spanFrom;
  const nDays = daysBetween(start, today) + 1;
  const week = Array.from({ length: nDays }, (_, i) => addDays(start, i)).map((d) => {
    const row = days.find((x) => x.date === d);
    return { date: d, label: span <= 14 ? `${weekdayLabel(d)} ${dateLabel(d).slice(0, 2)}` : dateLabel(d), expense: row?.expense ?? 0, income: row?.income ?? 0, count: row?.count ?? 0 };
  });
  // Expenses only: a salary landing inside the window would flatten every other bar.
  const weekChart = { labels: week.map((d) => d.label), expense: week.map((d) => d.expense), counts: week.map((d) => d.count) };
  const weekExpense = week.reduce((a, d) => a + d.expense, 0);

  const fim = fimDoMes(monthTotals ?? totals, cats, monthAjustes ?? ajustes);
  const prox = proximosMeses(await cashBalance(db, nucleo.id, today), fim, history, debts);
  const projChart = { labels: prox.points.map((p) => monthLabel(p.month)), values: prox.points.map((p) => p.balance) };
  const openDebts = debts.filter((d) => d.balance_cents > 0);
  const debtTotal = openDebts.reduce((a, d) => a + d.balance_cents, 0);
  const debtMonthly = openDebts.reduce((a, d) => a + d.installment_cents, 0);
  const pq = periodQuery(period);

  return c.html(
    <Layout title="Início" active="home" toast={c.req.query("ok") ?? undefined}>
      <PeriodNav period={period} base="/" />
      {abertas ? (
        <a class="alert pend-banner" href="/pendencias">
          <Icon name="question" /> {abertas === 1 ? "1 linha de extrato" : `${abertas} linhas de extrato`} para identificar
        </a>
      ) : null}
      <section class="stats">
        <div class="hero stat">
          <small>
            {period.kind === "mes" ? "Saldo do mês" : "Saldo do período"} · {nucleo.name}
          </small>
          <h1 class={balance >= 0 ? "pos" : "neg"}>{formatBRL(balance)}</h1>
          <div class="inout">
            <span class="in">+ {formatBRL(income)}</span>
            <span class="out">− {formatBRL(expense)}</span>
            {ajusteNet ? (
              <span class="adj" title="Ajustes de saldo: contam aqui, ficam fora dos gráficos">
                {ajusteNet > 0 ? "+" : "−"} {formatBRL(Math.abs(ajusteNet))} ajustes
              </span>
            ) : null}
          </div>
        </div>
        <div class="stat">
          <small>Saldo em caixa{cashUpTo < today ? ` em ${dateLabel(cashUpTo)}` : ""}</small>
          <b class={cash >= 0 ? "pos" : "neg"}>{formatBRL(cash)}</b>
          <small>tudo que entrou menos tudo que saiu, com ajustes</small>
        </div>
        <div class="stat">
          <small>Fim de {monthLabel(fim.month)} (projeção)</small>
          <b class={fim.balance_projected >= 0 ? "pos" : "neg"}>{formatBRL(fim.balance_projected)}</b>
          <small>
            gasto projetado {formatBRL(fim.expense_projected)} · dia {fim.days_elapsed} de {fim.days_in_month}
          </small>
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
                  “{a.note}” <small>{a.note_email?.split("@")[0]}</small>
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

      {/* one column on a phone, a grid of cards on a desktop */}
      <div class="board">
        {planned.length ? (
          <details class="card fold" id="fold-plano" open>
            <summary>
              <span>
                <Icon name="caret-right" class="caret" /> Real × planejado{planMonth !== thisMonth || period.kind === "periodo" ? ` · ${monthLabel(planMonth)}` : ""}
              </span>
              <a href={`/planejamento?mes=${planMonth}`}>ver tudo</a>
            </summary>
            <div class="chartbox" style={`height:${Math.max(150, planned.length * 36)}px`}>
              <canvas id="plan" data-src="plan-data"></canvas>
            </div>
            <ChartData id="plan-data" data={planChart} />
            <p class="muted legendline">
              <span>
                <i class="sw solid"></i> gasto
              </span>
              <span>
                <i class="sw faded"></i> planejado
              </span>
              <span>
                <i class="sw tick"></i> esperado hoje
              </span>
            </p>
          </details>
        ) : null}

        <details class="card fold" id="fold-semana" open>
          <summary>
            <span>
              <Icon name="caret-right" class="caret" /> Últimos {span} dias
            </span>
            <b class="neg">− {formatBRL(weekExpense)}</b>
          </summary>
          <p class="spans">
            {SPANS.map((n) => (
              <a href={`/?${pq}&dias=${n}`} class={n === span ? "on" : ""}>
                {n} dias
              </a>
            ))}
          </p>
          <div class="chartbox" style="height:160px">
            <canvas id="week" data-src="week-data"></canvas>
          </div>
          <ChartData id="week-data" data={weekChart} />
        </details>

        {out.length ? (
          <details class="card fold" id="fold-categorias" open>
            <summary>
              <span>
                <Icon name="caret-right" class="caret" /> Para onde foi
              </span>
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

        <details class="card fold" id="fold-projecoes" open>
          <summary>
            <span>
              <Icon name="caret-right" class="caret" /> Projeções
            </span>
            <b class={prox.points[prox.points.length - 1].balance >= 0 ? "pos" : "neg"}>
              {formatBRL(prox.points[prox.points.length - 1].balance)} em {monthLabel(prox.points[prox.points.length - 1].month)}
            </b>
          </summary>
          <table class="rep compact">
            <tbody>
              <tr>
                <td>Gasto até hoje</td>
                <td>{formatBRL(fim.expense)}</td>
              </tr>
              <tr>
                <td>Gasto projetado em {monthLabel(fim.month)}</td>
                <td>{formatBRL(fim.expense_projected)}</td>
              </tr>
              <tr>
                <td>Saldo projetado em {monthLabel(fim.month)}</td>
                <td class={fim.balance_projected >= 0 ? "pos" : "neg"}>{formatBRL(fim.balance_projected)}</td>
              </tr>
              <tr>
                <td>Resultado médio por mês</td>
                <td class={prox.avg_net >= 0 ? "pos" : "neg"}>{prox.months_used.length ? formatBRL(prox.avg_net) : "sem histórico"}</td>
              </tr>
            </tbody>
          </table>
          <div class="chartbox" style="height:170px">
            <canvas id="proj" data-src="proj-data"></canvas>
          </div>
          <ChartData id="proj-data" data={projChart} />
          <p class="muted small-note">
            Caixa no fim de cada mês: hoje + a média dos últimos {prox.months_used.length || 3} meses fechados. As parcelas já estão nessa média;
            quando uma dívida termina, a parcela dela volta para o caixa. Entradas futuras (salário) só contam depois de lançadas.
          </p>
        </details>

        <details class="card fold" id="fold-dividas" open>
          <summary>
            <span>
              <Icon name="caret-right" class="caret" /> Dívidas
            </span>
            <a href="/dividas">{admin ? "gerenciar" : "ver todas"}</a>
          </summary>
          {openDebts.length ? (
            <>
              <p class="debtsum">
                <b class="neg">{formatBRL(debtTotal)}</b> <small class="muted">· parcelas {formatBRL(debtMonthly)}/mês</small>
              </p>
              <ul class="debts">
                {openDebts.map((d) => (
                  <DebtRow d={d} />
                ))}
              </ul>
            </>
          ) : (
            <p class="muted">{admin ? <a href="/dividas/nova">Cadastrar uma dívida</a> : "Nenhuma dívida cadastrada."}</p>
          )}
        </details>

        <section class="card recent">
          <h2>
            Últimos lançamentos <a href={`/transacoes?${pq}`}>ver todos</a>
          </h2>
          <TxList txs={txs} empty="Nenhum lançamento neste período. Toque em + para começar." />
        </section>
      </div>
      <ChartJs />
    </Layout>,
  );
});

// Alerts are núcleo-wide: any member can note or dismiss.
home.post("/avisos/:id/ignorar", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.notFound();
  await dismissAlert(c.env.DB, c.get("nucleo").id, id, c.get("user").id);
  return c.redirect("/");
});

home.post("/avisos/:id/anotar", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.notFound();
  const form = await c.req.parseBody();
  const note = String(form.note ?? "").trim().slice(0, 200);
  if (note) await noteAlert(c.env.DB, c.get("nucleo").id, id, c.get("user").id, note);
  return c.redirect("/");
});
