import { Hono } from "hono";
import type { AppEnv } from "../env";
import { Layout } from "../pages/layout";
import { CatIcon, MonthNav } from "../pages/bits";
import { ensureBudgetsFor, listCategories, setBudget } from "../db";
import { buildOrcamento } from "../reports/orcamento";
import { currentMonth, isMonth } from "../lib/dates";
import { formatBRL, parseBRL } from "../lib/money";

export const orcamento = new Hono<AppEnv>();

orcamento.get("/", async (c) => {
  const q = c.req.query("mes");
  const month = q && isMonth(q) ? q : currentMonth();
  await ensureBudgetsFor(c.env.DB, month);
  const [rep, cats] = await Promise.all([buildOrcamento(c.env.DB, month), listCategories(c.env.DB)]);
  const capOf = new Map(rep.lines.map((l) => [l.category_id, l]));
  return c.html(
    <Layout title="Orçamento" active="mais" toast={c.req.query("ok") ?? undefined}>
      <MonthNav month={month} base="/orcamento" />
      <section class="hero small">
        <small>
          Teto {formatBRL(rep.total_cap)} · gasto {formatBRL(rep.total_spent)}
        </small>
        <h1 class={rep.total_spent > rep.total_cap ? "neg" : "pos"}>{formatBRL(rep.total_cap - rep.total_spent)} restantes</h1>
        {rep.days_elapsed > 0 && rep.days_elapsed < rep.days_in_month ? (
          <small>projeção no fim do mês: {formatBRL(rep.total_projected)}</small>
        ) : null}
      </section>
      <form method="post" action={`/orcamento?mes=${month}`} class="stack">
        <ul class="budget">
          {cats
            .filter((x) => x.kind === "out")
            .map((cat) => {
              const l = capOf.get(cat.id);
              const w = l ? Math.min(100, l.used_pct) : 0;
              return (
                <li>
                  <div class="brow">
                    <CatIcon icon={cat.icon} color={cat.color} />
                    <span class="txt">
                      <b>{cat.name}</b>
                      <small>{l ? `${formatBRL(l.spent)} de ${formatBRL(l.cap)} · ${l.used_pct}%` : "sem teto"}</small>
                    </span>
                    <input name={`cap_${cat.id}`} inputmode="decimal" placeholder="0,00" value={l ? (l.cap / 100).toFixed(2).replace(".", ",") : ""} />
                  </div>
                  {l ? (
                    <div class="bar">
                      <i class={l.over ? "over" : ""} style={`width:${w}%`}></i>
                    </div>
                  ) : null}
                </li>
              );
            })}
        </ul>
        <button type="submit" class="btn">
          Salvar tetos
        </button>
      </form>
    </Layout>,
  );
});

orcamento.post("/", async (c) => {
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
  return c.redirect(`/orcamento?mes=${month}&ok=${encodeURIComponent("Tetos salvos")}`);
});
