// Planejamento: the budget screen. Everyone sees it; only admins change the numbers.
import { Hono } from "hono";
import type { AppEnv } from "../env";
import { Layout } from "../pages/layout";
import { CatIcon, MonthNav } from "../pages/bits";
import { ensureBudgetsFor, listCategories, setBudget, type Pace } from "../db";
import { buildOrcamento, type OrcamentoLine } from "../reports/orcamento";
import { currentMonth, isMonth } from "../lib/dates";
import { formatBRL, parseBRL } from "../lib/money";
import { requireAdmin } from "../middleware";

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
        <small>
          {formatBRL(l.spent)} de {formatBRL(l.cap)} · {l.used_pct}% · <span class={`st ${l.status}`}>{STATUS_LABEL[l.status]}</span>
        </small>
      </span>
      {canEdit ? (
        <input name={`cap_${l.category_id}`} inputmode="decimal" value={(l.cap / 100).toFixed(2).replace(".", ",")} aria-label={`Planejado para ${l.name}`} />
      ) : (
        <b class="amt">{formatBRL(l.remaining)}</b>
      )}
    </div>
    <div class="bar" title={l.pace === "continuo" ? `esperado até hoje: ${l.expected_pct}%` : ""}>
      <i class={l.status} style={`width:${Math.min(100, l.used_pct)}%`}></i>
      {l.pace === "continuo" && l.expected_pct < 100 ? <em style={`left:${l.expected_pct}%`}></em> : null}
    </div>
    <small class="muted proj">
      {l.pace === "fixo"
        ? l.over
          ? `passou ${formatBRL(-l.remaining)} do planejado`
          : `restam ${formatBRL(l.remaining)}`
        : `projeção ${formatBRL(l.projected)} · ${l.over ? `passou ${formatBRL(-l.remaining)}` : `restam ${formatBRL(l.remaining)}`}`}
    </small>
  </li>
);

planejamento.get("/", async (c) => {
  const q = c.req.query("mes");
  const month = q && isMonth(q) ? q : currentMonth();
  const admin = c.get("user").admin;
  if (admin) await ensureBudgetsFor(c.env.DB, month);
  const [rep, cats] = await Promise.all([buildOrcamento(c.env.DB, month), listCategories(c.env.DB)]);
  const planned = new Set(rep.lines.map((l) => l.category_id));
  const notPlanned = cats.filter((x) => x.kind === "out" && !planned.has(x.id));
  const body = (
    <>
      <section class="hero small">
        <small>
          planejado {formatBRL(rep.total_cap)} · gasto {formatBRL(rep.total_spent)}
        </small>
        <h1 class={rep.total_spent > rep.total_cap ? "neg" : "pos"}>{formatBRL(rep.total_cap - rep.total_spent)}</h1>
        <small>
          {rep.days_elapsed > 0 && rep.days_elapsed < rep.days_in_month
            ? `dia ${rep.days_elapsed} de ${rep.days_in_month} (${rep.elapsed_pct}%) · projeção ${formatBRL(rep.total_projected)}`
            : rep.days_elapsed === 0
              ? "mês ainda não começou"
              : "mês encerrado"}
        </small>
      </section>
      <ul class="budget">
        {rep.lines.map((l) => (
          <Line l={l} canEdit={admin} />
        ))}
      </ul>
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
      <MonthNav month={month} base="/planejamento" />
      {admin ? (
        <form method="post" action={`/planejamento?mes=${month}`} class="stack">
          {body}
          <button type="submit" class="btn primary">
            Salvar planejamento
          </button>
          <p class="muted center">
            Como cada categoria avisa: <a href="/categorias">tipo por categoria</a>. O risco na barra marca onde uma categoria contínua deveria estar hoje.
          </p>
        </form>
      ) : (
        body
      )}
    </Layout>,
  );
});

planejamento.post("/", requireAdmin, async (c) => {
  const q = c.req.query("mes");
  const month = q && isMonth(q) ? q : currentMonth();
  const form = await c.req.parseBody();
  const cats = await listCategories(c.env.DB);
  for (const cat of cats) {
    if (cat.kind !== "out") continue;
    const raw = form[`cap_${cat.id}`];
    if (raw === undefined) continue;
    const cents = String(raw).trim() === "" ? 0 : parseBRL(String(raw));
    if (cents === null) continue;
    await setBudget(c.env.DB, cat.id, month, cents);
  }
  return c.redirect(`/planejamento?mes=${month}&ok=${encodeURIComponent("Planejamento salvo")}`);
});
