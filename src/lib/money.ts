// BRL formatting and parsing. Everything internal is integer centavos.

const fmt = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

export function formatBRL(cents: number): string {
  return fmt.format(cents / 100);
}

export function formatSigned(cents: number, kind: "in" | "out"): string {
  return (kind === "in" ? "+" : "−") + formatBRL(cents);
}

/** Accepts "1.234,56", "1234.56", "1234,56", "R$ 12", "12". Returns centavos or null. */
export function parseBRL(input: string): number | null {
  let s = input.trim().replace(/^R\$\s*/i, "").replace(/\s/g, "");
  if (!s) return null;
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma > lastDot) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else if (lastDot > lastComma) {
    s = s.replace(/,/g, "");
  }
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [int, frac = ""] = s.split(".");
  return parseInt(int, 10) * 100 + parseInt((frac + "00").slice(0, 2), 10);
}

export function pct(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 1000) / 10;
}
