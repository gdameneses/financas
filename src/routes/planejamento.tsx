// Planejamento: the budget screen. Every member sees it; only núcleo admins change the numbers.
import { Hono } from "hono";
import type { AppEnv } from "../env";
import { Layout } from "../pages/layout";
import { CatIcon, Icon, MonthNav } from "../pages/bits";
import { ensureBudgetsFor, listBudgetsYear, listCategories, setBudget, spentByMonthCategory, type Pace } from "../db";
import { buildOrcamento, type OrcamentoLine } from "../reports/orcamento";
import { currentMonth, isMonth, monthLabel } from "../lib/dates";
import { formatBRL, parseBRL } from "../lib/money";
import { requireNucleoAdmin } from "../middleware";

export const planejamento = new Hono<AppEnv>();

const PACE_LABEL: Record<Pace, string> = { continuo: "contínua", fixo: "fixa", livre: "livre" };
const STATUS_LABEL = { ok: "no ritmo", atencao: "atenção", estourou: "estourou" } as const;

const Line = ({ l, canEdit }: { l: OrcamentoLine; canEdit: boolean }) => (
  <li class={`plan ${l.status}`}>
    <div class="brow">
      <CatIcon icon={l.icon} color={l.color} />
      <span class="txt">
        <b>
          {l.name} <small class="muted">{PACE_LABEL[l.pace]}</small>
        </b>
      </span>
      {canEdit ? (
        <input name={`cap_${l.category_id}`} inputmode="decimal" value={(l.cap / 100).toFixed(2).replace(".", ",")} aria-label={`Planejado para ${l.name}`} />
      ) : null}
    </div>
    <div class="bar">
      <i class={l.status} style={`width:${Math.min(100, l.used_pct)}%`}></i>
      {l.pace === "continuo" && l.expected_pct < 100 ? <em style={`left:${l.expected_pct}%`}></em> : null}
    </div>
    <small class="muted meta">
      <span>
        {formatBRL(l.spent)} de {formatBRL(l.cap)} ({l.used_pct}%)
      </span>
      <span class={`st ${l.status}`}>{STATUS_LABEL[l.status]}</span>
    </small>
    <small class="muted proj">
      {l.pace === "fixo"
        ? l.over
          ? `passou ${formatBRL(-l.remaining)} do planejado`
          : `restam ${formatBRL(l.remaining)}`
        : `projeção ${formatBRL(l.projected)} · ${l.over ? `passou ${formatBRL(-l.remaining)}` : `restam ${formatBRL(l.remaining)}`}`}
    </small>
  </li>
);

const PlanTabs = ({ on, month }: { on: "mes" | "ano"; month: string }) => (
  <nav class="subtabs">
    <a href={`/planejamento?mes=${month}`} class={on === "mes" ? "on" : ""}>
      Mês
    </a>
    <a href={`/planejamento/anual?ano=${month.slice(0, 4)}`} class={on === "ano" ? "on" : ""}>
      Ano
    </a>
  </nav>
);

planejamento.get("/", async (c) => {
  const q = c.req.query("mes");
  const month = q && isMonth(q) ? q : currentMonth();
  const n = c.get("nucleo").id;
  const admin = c.get("nucleo").role === "admin";
  if (admin) await ensureBudgetsFor(c.env.DB, n, month);
  const [rep, cats] = await Promise.all([buildOrcamento(c.env.DB, n, month), listCategories(c.env.DB, n)]);
  const planned = new Set(rep.lines.map((l) => l.category_id));
  // Balance adjustments are not spending: they never get a cap.
  const notPlanned = cats.filter((x) => x.kind === "out" && !x.ajuste && !planned.has(x.id));
  const over = rep.total_spent > rep.total_cap;
  const body = (
    <>
      <section class="hero small">
        <small>{over ? "Passou do planejado" : "Restam do planejado"}</small>
        <h1 class={over ? "neg" : "pos"}>{formatBRL(Math.abs(rep.total_cap - rep.total_spent))}</h1>
        <small>
          gasto {formatBRL(rep.total_spent)} de {formatBRL(rep.total_cap)}
        </small>
        <small>
          {rep.days_elapsed > 0 && rep.days_elapsed < rep.days_in_month
            ? `dia ${rep.days_elapsed} de ${rep.days_in_month} · projeção ${formatBRL(rep.total_projected)}`
            : rep.days_elapsed === 0
              ? "mês ainda não começou"
              : "mês encerrado"}
        </small>
      </section>
      {rep.lines.length ? (
        <ul class="budget">
          {rep.lines.map((l) => (
            <Line l={l} canEdit={admin} />
          ))}
        </ul>
      ) : admin ? null : (
        <p class="muted">Nenhum valor planejado para este mês ainda.</p>
      )}
      {admin && notPlanned.length ? (
        <section>
          <h2>Sem valor planejado</h2>
          <ul class="budget">
            {notPlanned.map((cat) => (
              <li class="plan">
                <div class="brow">
                  <CatIcon icon={cat.icon} color={cat.color} />
                  <span class="txt">
                    <b>
                      {cat.name} <small class="muted">{PACE_LABEL[cat.pace]}</small>
                    </b>
                    <small>{rep.unbudgeted.find((u) => u.category_id === cat.id) ? `gasto ${formatBRL(rep.unbudgeted.find((u) => u.category_id === cat.id)!.spent)}` : "sem gastos"}</small>
                  </span>
                  <input name={`cap_${cat.id}`} inputmode="decimal" placeholder="0,00" aria-label={`Planejado para ${cat.name}`} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {!admin && rep.unbudgeted.length ? (
        <p class="muted">Sem valor planejado: {rep.unbudgeted.map((u) => u.name).join(", ")}.</p>
      ) : null}
    </>
  );
  return c.html(
    <Layout title="Planejamento" active="plan" toast={c.req.query("ok") ?? undefined}>
      <PlanTabs on="mes" month={month} />
      <MonthNav month={month} base="/planejamento" />
      {admin ? (
        <form method="post" action={`/planejamento?mes=${month}`} class="stack">
          {body}
          <button type="submit" class="btn primary">
            Salvar planejamento
          </button>
          <p class="muted center">
            O traço na barra marca onde uma categoria contínua deveria estar hoje. O tipo de cada categoria se ajusta em <a href="/categorias">Categorias</a>.
          </p>
        </form>
      ) : (
        body
      )}
    </Layout>,
  );
});

planejamento.post("/", requireNucleoAdmin, async (c) => {
  const q = c.req.query("mes");
  const month = q && isMonth(q) ? q : currentMonth();
  const n = c.get("nucleo").id;
  const form = await c.req.parseBody();
  const cats = await listCategories(c.env.DB, n);
  for (const cat of cats) {
    if (cat.kind !== "out" || cat.ajuste) continue;
    const raw = form[`cap_${cat.id}`];
    if (raw === undefined) continue;
    const cents = String(raw).trim() === "" ? 0 : parseBRL(String(raw));
    if (cents === null) continue;
    await setBudget(c.env.DB, n, cat.id, month, cents);
  }
  return c.redirect(`/planejamento?mes=${month}&ok=${encodeURIComponent("Planejamento salvo")}`);
});

// Annual view: planned × spent per category for the twelve months of a year. Read-only; caps are
// still set month by month on the monthly screen (each month links there).
planejamento.get("/anual", async (c) => {
  const q = c.req.query("ano");
  const year = q && /^\d{4}$/.test(q) ? q : currentMonth().slice(0, 4);
  const n = c.get("nucleo").id;
  const [cats, budgets, spent] = await Promise.all([listCategories(c.env.DB, n), listBudgetsYear(c.env.DB, n, year), spentByMonthCategory(c.env.DB, n, year)]);
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);
  const cap = (id: number | null, m: string) => (id === null ? 0 : (budgets.find((b) => b.category_id === id && b.month === m)?.cap_cents ?? 0));
  const got = (id: number | null, m: string) => spent.find((x) => x.category_id === id && x.month === m)?.total ?? 0;
  type Row = { id: number | null; name: string; icon: string | null; color: string | null };
  const rows: Row[] = cats
    .filter((x) => x.kind === "out" && !x.ajuste)
    .filter((x) => budgets.some((b) => b.category_id === x.id) || spent.some((t) => t.category_id === x.id))
    .map((x) => ({ id: x.id, name: x.name, icon: x.icon, color: x.color }));
  if (spent.some((t) => t.category_id === null)) rows.push({ id: null, name: "Sem categoria", icon: "question", color: null });
  const sum = (f: (m: string) => number) => months.reduce((a, m) => a + f(m), 0);
  const capYear = rows.reduce((a, r) => a + sum((m) => cap(r.id, m)), 0);
  const spentYear = rows.reduce((a, r) => a + sum((m) => got(r.id, m)), 0);
  const cur = currentMonth();
  const Cell = ({ s: sp, p: pl, m }: { s: number; p: number; m?: string }) => (
    <td class={`${pl && sp > pl ? "over" : ""} ${m && m > cur ? "future" : ""}`}>
      {sp ? formatBRL(sp) : "—"}
      <small>{pl ? formatBRL(pl) : ""}</small>
    </td>
  );
  return c.html(
    <Layout title="Planejamento anual" active="plan">
      <PlanTabs on="ano" month={year === cur.slice(0, 4) ? cur : `${year}-01`} />
      <div class="monthnav">
        <a href={`/planejamento/anual?ano=${Number(year) - 1}`} aria-label="Ano anterior">
          <Icon name="caret-left" />
        </a>
        <span>{year}</span>
        <a href={`/planejamento/anual?ano=${Number(year) + 1}`} aria-label="Próximo ano">
          <Icon name="caret-right" />
        </a>
      </div>
      <section class="hero small">
        <small>{spentYear > capYear && capYear ? "Passou do planejado no ano" : "Gasto no ano"}</small>
        <h1 class={capYear && spentYear > capYear ? "neg" : ""}>{formatBRL(spentYear)}</h1>
        <small>planejado no ano {formatBRL(capYear)}</small>
      </section>
      {rows.length ? (
        <div class="tablewrap">
          <table class="rep annual">
            <thead>
              <tr>
                <th>Categoria</th>
                {months.map((m) => (
                  <th>
                    <a href={`/planejamento?mes=${m}`}>{monthLabel(m).slice(0, 3)}</a>
                  </th>
                ))}
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr>
                  <td>
                    <CatIcon icon={r.icon} color={r.color} /> {r.name}
                  </td>
                  {months.map((m) => (
                    <Cell s={got(r.id, m)} p={cap(r.id, m)} m={m} />
                  ))}
                  <Cell s={sum((m) => got(r.id, m))} p={sum((m) => cap(r.id, m))} />
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>Total</td>
                {months.map((m) => (
                  <Cell s={rows.reduce((a, r) => a + got(r.id, m), 0)} p={rows.reduce((a, r) => a + cap(r.id, m), 0)} m={m} />
                ))}
                <Cell s={spentYear} p={capYear} />
              </tr>
            </tfoot>
          </table>
        </div>
      ) : (
        <p class="muted">Nada planejado nem gasto em {year}.</p>
      )}
      <p class="muted">Em cada célula: gasto em cima, planejado embaixo; vermelho quando passou. Clique no mês para planejar.</p>
    </Layout>,
  );
});
