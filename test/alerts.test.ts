import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { levelFor, syncAlerts, activeAlerts, dismissAlert, alertMessage } from "../src/alerts";
import { createTransaction, setBudget } from "../src/db";
import { formatBRL } from "../src/lib/money";
import { categoryId, fixture, resetDb } from "./helpers";

describe("alert rules", () => {
  it("continuous categories alert on pace, 80 and 100", () => {
    expect(levelFor({ used_pct: 20, pace: "continuo", over: false }, 5)).toBeNull(); // below the 25% floor
    expect(levelFor({ used_pct: 50, pace: "continuo", over: false }, 17)).toBe("ritmo"); // day 5 of 30, half spent
    expect(levelFor({ used_pct: 50, pace: "continuo", over: false }, 45)).toBeNull(); // within 15 points of pace
    expect(levelFor({ used_pct: 85, pace: "continuo", over: false }, 90)).toBe("80");
    expect(levelFor({ used_pct: 100, pace: "continuo", over: false }, 10)).toBe("100");
  });
  it("fixed categories only alert when over; free ones at 80 and 100", () => {
    expect(levelFor({ used_pct: 100, pace: "fixo", over: false }, 3)).toBeNull(); // rent paid exactly: fine
    expect(levelFor({ used_pct: 101, pace: "fixo", over: true }, 3)).toBe("100");
    expect(levelFor({ used_pct: 95, pace: "fixo", over: false }, 3)).toBeNull();
    expect(levelFor({ used_pct: 60, pace: "livre", over: false }, 10)).toBeNull();
    expect(levelFor({ used_pct: 80, pace: "livre", over: false }, 10)).toBe("80");
  });
});

describe("alert sync", () => {
  let uid = 0;
  let nid = 0;
  beforeEach(async () => {
    await resetDb();
    ({ uid, nid } = await fixture());
  });
  const now = new Date("2026-10-05T15:00:00Z"); // day 5 of 31 → 16% elapsed
  const month = "2026-10";

  const cat = (name: string) => categoryId(nid, name);

  it("fires once per level, escalates, and dismissal sticks", async () => {
    const mercado = await cat("Mercado");
    await setBudget(env.DB, nid, mercado, month, 100000);
    await createTransaction(env.DB, nid, { date: "2026-10-03", amount_cents: 50000, kind: "out", category_id: mercado, payee: "A", note: "" });
    await syncAlerts(env.DB, nid, now);
    await syncAlerts(env.DB, nid, now); // idempotent
    let alerts = await activeAlerts(env.DB, nid, month);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ level: "ritmo", spent_pct: 50, elapsed_pct: 16 });
    expect(alertMessage(alerts[0], formatBRL)).toContain("50% do seu valor planejado para mercado");

    await dismissAlert(env.DB, nid, alerts[0].id, uid);
    await syncAlerts(env.DB, nid, now);
    expect(await activeAlerts(env.DB, nid, month)).toHaveLength(0); // dismissed stays dismissed

    // Spending reaches 100%: a new level fires even though "ritmo" was dismissed.
    await createTransaction(env.DB, nid, { date: "2026-10-04", amount_cents: 60000, kind: "out", category_id: mercado, payee: "B", note: "" });
    await syncAlerts(env.DB, nid, now);
    alerts = await activeAlerts(env.DB, nid, month);
    expect(alerts.map((a) => a.level)).toEqual(["100"]);
  });

  it("rent paid in full on day 2 is not an alert; over budget is", async () => {
    const moradia = await cat("Moradia");
    await setBudget(env.DB, nid, moradia, month, 200000);
    await createTransaction(env.DB, nid, { date: "2026-10-02", amount_cents: 200000, kind: "out", category_id: moradia, payee: "Aluguel", note: "" });
    await syncAlerts(env.DB, nid, now);
    expect(await activeAlerts(env.DB, nid, month)).toHaveLength(0);
    await createTransaction(env.DB, nid, { date: "2026-10-02", amount_cents: 1000, kind: "out", category_id: moradia, payee: "Condomínio", note: "" });
    await syncAlerts(env.DB, nid, now);
    expect((await activeAlerts(env.DB, nid, month)).map((a) => a.level)).toEqual(["100"]);
  });
});
