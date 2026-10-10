import { Hono } from "hono";
import type { AppEnv } from "../env";
import { Layout } from "../pages/layout";
import { ChartData, ChartJs, Icon, MonthNav } from "../pages/bits";
import { listTransactions } from "../db";
import { buildMensal } from "../reports/mensal";
import { buildTendencia } from "../reports/tendencia";
import { detectRecorrentes } from "../reports/recorrentes";
import { buildOrcamento } from "../reports/orcamento";
import { currentMonth, isMonth } from "../lib/dates";
import { formatBRL } from "../lib/money";

export const relatorios = new Hono<AppEnv>();

const TABS = ["mensal", "tendencia", "recorrentes", "orcamento"] as const;
type Tab = (typeof TABS)[number];
const LABELS: Record<Tab, string> = { mensal: "Mensal", tendencia: "Tendência", recorrentes: "Recorrentes", orcamento: "Orçamento" };

const Tabs = ({ tab, month }: { tab: Tab; month: string }) => (
  <nav class="subtabs">
    {TABS.map((t) => (
      <a href={`/relatorios?tab=${t}&mes=${month}`} class={t === tab ? "on" : ""}>
        {LABELS[t]}
      </a>
    ))}
  </nav>
);

const Downloads = ({ json, md }: { json: string; md: string }) => (
  <p class="downloads">
    <a href={json} download>
      <Icon name="download-simple" /> JSON
    </a>
    <a href={md} download>
      <Icon name="download-simple" /> Markdown
    </a>
  </p>
);

const sign = (n: number) => (n >= 0 ? "+" : "−") + formatBRL(Math.abs(n));

relatorios.get("/", async (c) => {
  const q = c.req.query("mes");
  const month = q && isMonth(q) ? q : currentMonth();
  const tabQ = c.req.query("tab");
  const tab: Tab = (TABS as readonly string[]).includes(tabQ ?? "") ? (tabQ as Tab) : "mensal";
  const db = c.env.DB;
  const n = c.get("nucleo").id;

  let body;
  if (tab === "mensal") {
    const r = await buildMensal(db, n, month);
    body = (
      <>
        <section class="hero small">
          <small>
            ↑ {formatBRL(r.income)} · ↓ {formatBRL(r.expense)}
          </small>
          <h1 class={r.net >= 0 ? "pos" : "neg"}>{sign(r.net)}</h1>
          <small>mês anterior: {sign(r.prev.net)}</small>
        </section>
        <section class="card">
          <canvas id="bars" data-src="bars-data" height="220"></canvas>
          <ChartData
            id="bars-data"
            data={{ labels: r.out.map((l) => l.name), values: r.out.map((l) => l.total), colors: r.out.map((l) => l.color) }}
          />
        </section>
        <table class="rep">
          <thead>
            <tr>
              <th>Saídas</th>
              <th>Total</th>
              <th>%</th>
              <th>Δ</th>
            </tr>
          </thead>
          <tbody>
            {r.out.map((l) => (
              <tr>
                <td>
                  {l.name}
                </td>
                <td>{formatBRL(l.total)}</td>
                <td>{l.share_pct}%</td>
                <td class={l.delta > 0 ? "neg" : "pos"}>{sign(l.delta)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {r.in.length ? (
          <table class="rep">
            <thead>
              <tr>
                <th>Entradas</th>
                <th>Total</th>
                <th>%</th>
                <th>Δ</th>
              </tr>
            </thead>
            <tbody>
              {r.in.map((l) => (
                <tr>
                  <td>
                    {l.name}
                  </td>
                  <td>{formatBRL(l.total)}</td>
                  <td>{l.share_pct}%</td>
                  <td class={l.delta >= 0 ? "pos" : "neg"}>{sign(l.delta)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        {r.top_payees.length ? (
          <table class="rep">
            <thead>
              <tr>
                <th>Maiores destinos</th>
                <th>Total</th>
                <th>Qtd</th>
              </tr>
            </thead>
            <tbody>
              {r.top_payees.map((p) => (
                <tr>
                  <td>{p.payee}</td>
                  <td>{formatBRL(p.total)}</td>
                  <td>{p.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        <Downloads json={`/api/report/mensal/${month}.json`} md={`/api/report/mensal/${month}.md`} />
      </>
    );
  } else if (tab === "tendencia") {
    const r = await buildTendencia(db, n, month);
    body = (
      <>
        <section class="hero small">
          <small>média mensal (meses com dados)</small>
          <h1 class={r.avg_net >= 0 ? "pos" : "neg"}>{sign(r.avg_net)}</h1>
          <small>
            ↑ {formatBRL(r.avg_income)} · ↓ {formatBRL(r.avg_expense)}
          </small>
        </section>
        <section class="card">
          <canvas id="trend" data-src="trend-data" height="220"></canvas>
          <ChartData
            id="trend-data"
            data={{
              labels: r.rows.map((x) => x.label),
              income: r.rows.map((x) => x.income),
              expense: r.rows.map((x) => x.expense),
              net: r.rows.map((x) => x.net),
            }}
          />
        </section>
        <table class="rep">
          <thead>
            <tr>
              <th>Mês</th>
              <th>↑</th>
              <th>↓</th>
              <th>Saldo</th>
            </tr>
          </thead>
          <tbody>
            {r.rows.map((x) => (
              <tr>
                <td>{x.label}</td>
                <td>{formatBRL(x.income)}</td>
                <td>{formatBRL(x.expense)}</td>
                <td class={x.net >= 0 ? "pos" : "neg"}>{sign(x.net)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <Downloads json={`/api/report/tendencia.json?ate=${month}`} md={`/api/report/tendencia.md?ate=${month}`} />
      </>
    );
  } else if (tab === "recorrentes") {
    const txs = await listTransactions(db, n);
    const r = detectRecorrentes(txs, month);
    body = (
      <>
        <section class="hero small">
          <small>recorrentes ativos</small>
          <h1>{formatBRL(r.monthly_total)}/mês</h1>
          <small>{r.items.filter((i) => i.status !== "sumido").length} itens detectados</small>
        </section>
        {r.items.length ? (
          <table class="rep">
            <thead>
              <tr>
                <th>Destino</th>
                <th>Valor</th>
                <th>Último</th>
              </tr>
            </thead>
            <tbody>
              {r.items.map((i) => (
                <tr class={i.status}>
                  <td>
                    {i.payee}
                    {i.status === "novo" ? <small class="badge new">novo</small> : null}
                    {i.status === "sumido" ? <small class="badge gone">sumido</small> : null}
                  </td>
                  <td>{formatBRL(i.amount)}</td>
                  <td>
                    {i.last.slice(8)}/{i.last.slice(5, 7)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p class="muted">Nada recorrente ainda: são necessários 3 lançamentos mensais com o mesmo destino e valor parecido.</p>
        )}
        <Downloads json={`/api/report/recorrentes.json?mes=${month}`} md={`/api/report/recorrentes.md?mes=${month}`} />
      </>
    );
  } else {
    const r = await buildOrcamento(db, n, month);
    body = (
      <>
        <section class="hero small">
          <small>
            planejado {formatBRL(r.total_cap)} · gasto {formatBRL(r.total_spent)}
          </small>
          <h1 class={r.total_spent > r.total_cap ? "neg" : "pos"}>{formatBRL(r.total_cap - r.total_spent)}</h1>
          <small>projeção: {formatBRL(r.total_projected)}</small>
        </section>
        {r.lines.length ? (
          <table class="rep">
            <thead>
              <tr>
                <th>Categoria</th>
                <th>Gasto / planejado</th>
                <th>%</th>
                <th>Proj.</th>
              </tr>
            </thead>
            <tbody>
              {r.lines.map((l) => (
                <tr class={l.over ? "over" : ""}>
                  <td>
                    {l.name}
                  </td>
                  <td>
                    {formatBRL(l.spent)} / {formatBRL(l.cap)}
                  </td>
                  <td>{l.used_pct}%</td>
                  <td>{formatBRL(l.projected)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p class="muted">
            Nenhum valor planejado para este mês. <a href={`/planejamento?mes=${month}`}>Abrir planejamento</a>.
          </p>
        )}
        {r.unbudgeted.length ? (
          <table class="rep">
            <thead>
              <tr>
                <th>Sem valor planejado</th>
                <th>Gasto</th>
              </tr>
            </thead>
            <tbody>
              {r.unbudgeted.map((u) => (
                <tr>
                  <td>
                    {u.name}
                  </td>
                  <td>{formatBRL(u.spent)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        <Downloads json={`/api/report/orcamento/${month}.json`} md={`/api/report/orcamento/${month}.md`} />
      </>
    );
  }

  return c.html(
    <Layout title={`Relatórios · ${LABELS[tab]}`} active="mais">
      <MonthNav month={month} base={`/relatorios?tab=${tab}`} />
      <Tabs tab={tab} month={month} />
      {body}
      <ChartJs />
    </Layout>,
  );
});
