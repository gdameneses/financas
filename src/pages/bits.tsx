// Small view pieces shared by several pages.
import { html, raw } from "hono/html";
import type { TransactionView } from "../db";
import { addMonths, dateLabel, monthLabel, periodLabel, type Period } from "../lib/dates";
import { formatBRL } from "../lib/money";

/** Flat icon from the inlined Phosphor sprite. */
export const Icon = ({ name, class: cls }: { name: string; class?: string }) => (
  <svg class={`i ${cls ?? ""}`} aria-hidden="true">
    <use href={`#${name}`} />
  </svg>
);

/** Category badge: thin ring in the category colour around its icon. */
export const CatIcon = ({ icon, color }: { icon: string | null; color: string | null }) => (
  <span class="ico" style={`color:${color ?? "var(--fg-dim)"}`}>
    <Icon name={icon ?? "question"} />
  </span>
);

export const MonthNav = ({ month, base }: { month: string; base: string }) => {
  const sep = base.includes("?") ? "&" : "?";
  return (
    <div class="monthnav">
      <a href={`${base}${sep}mes=${addMonths(month, -1)}`} aria-label="Mês anterior">
        <Icon name="caret-left" />
      </a>
      <span>{monthLabel(month)}</span>
      <a href={`${base}${sep}mes=${addMonths(month, 1)}`} aria-label="Próximo mês">
        <Icon name="caret-right" />
      </a>
    </div>
  );
};

/**
 * Month arrows (the default) plus a "Período" picker for any from–to range. `keep` are extra
 * query parameters the page must not lose (e.g. the category filter).
 */
export const PeriodNav = ({ period, base, keep = {} }: { period: Period; base: string; keep?: Record<string, string> }) => {
  const extra = Object.entries(keep)
    .map(([k, v]) => `&${k}=${encodeURIComponent(v)}`)
    .join("");
  const backMonth = period.kind === "mes" ? period.month : period.to.slice(0, 7);
  return (
    <div class="periodnav">
      {period.kind === "mes" ? (
        <div class="monthnav">
          <a href={`${base}?mes=${addMonths(period.month, -1)}${extra}`} aria-label="Mês anterior">
            <Icon name="caret-left" />
          </a>
          <span>{monthLabel(period.month)}</span>
          <a href={`${base}?mes=${addMonths(period.month, 1)}${extra}`} aria-label="Próximo mês">
            <Icon name="caret-right" />
          </a>
        </div>
      ) : (
        <div class="monthnav period">
          <span>
            <Icon name="calendar-blank" /> {periodLabel(period)}
          </span>
          <a href={`${base}?mes=${backMonth}${extra}`} class="btn small ghost">
            Voltar ao mês
          </a>
        </div>
      )}
      <details class="periodpick">
        <summary>
          <Icon name="calendar-blank" /> {period.kind === "mes" ? "Escolher período" : "Mudar período"}
        </summary>
        <form method="get" action={base} class="row">
          {Object.entries(keep).map(([k, v]) => (
            <input type="hidden" name={k} value={v} />
          ))}
          <label>
            De
            <input type="date" name="de" value={period.from} required />
          </label>
          <label>
            Até
            <input type="date" name="ate" value={period.to} required />
          </label>
          <button type="submit" class="btn small">
            Ver
          </button>
        </form>
      </details>
    </div>
  );
};

export const TxList = ({ txs, empty = "Nada por aqui ainda." }: { txs: TransactionView[]; empty?: string }) => {
  if (!txs.length) return <p class="muted">{empty}</p>;
  const groups = new Map<string, TransactionView[]>();
  for (const t of txs) (groups.get(t.date) ?? groups.set(t.date, []).get(t.date)!).push(t);
  return (
    <ul class="txlist">
      {[...groups.entries()].map(([date, items]) => (
        <>
          <li class="day">{dateLabel(date)}</li>
          {items.map((t) => (
            <li>
              <a href={`/transacoes/${t.id}`} class="tx">
                <CatIcon icon={t.category_icon} color={t.category_color} />
                <span class="txt">
                  <b>{t.payee || t.category_name || "Sem categoria"}</b>
                  <small>{t.payee ? t.category_name ?? "Sem categoria" : t.note}</small>
                </span>
                <span class="who" title={t.user_email ?? ""}>
                  {t.user_email ? t.user_email[0].toUpperCase() : ""}
                </span>
                <span class={`amt ${t.kind}`}>
                  {t.kind === "in" ? "+" : "−"}
                  {formatBRL(t.amount_cents)}
                </span>
              </a>
            </li>
          ))}
        </>
      ))}
    </ul>
  );
};

/** Embeds JSON for app.js to pick up. Escapes `<` so no `</script>` breakout. */
export const ChartData = ({ id, data }: { id: string; data: unknown }) =>
  html`<script type="application/json" id="${id}">${raw(JSON.stringify(data).replace(/</g, "\\u003c"))}</script>`;

export const ChartJs = () =>
  html`<script src="/vendor/chart.umd.min.js" defer></script>`;
