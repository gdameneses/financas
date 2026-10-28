import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { Browser, resetDb } from "./helpers";

beforeEach(resetDb);

const ADMIN = "admin@example.com";

async function admin(): Promise<Browser> {
  const b = new Browser("203.0.113.10");
  await b.form("/acesso", { op: "request", email: ADMIN, name: "laptop" });
  await b.form("/login", { email: ADMIN, password: "senha-forte-123" });
  expect((await b.form("/nucleos", { name: "Casa" })).status).toBe(302);
  return b;
}

const background = (b: Browser, data: Record<string, string>) =>
  b.fetch("/nova", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-fetch": "1" },
    body: new URLSearchParams(data).toString(),
  });

const count = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM transactions").first<{ n: number }>())!.n;

describe("novo lançamento: continuar adicionando", () => {
  it("a background add answers JSON with the new id instead of rendering a page", async () => {
    const b = await admin();
    const r = await background(b, { kind: "out", amount: "12,50", date: "2026-10-05", category_id: "", payee: "Padaria", continuar: "1" });
    expect(r.status).toBe(201);
    const { id } = await r.json<{ id: number }>();
    const row = await env.DB.prepare("SELECT amount_cents, payee FROM transactions WHERE id = ?").bind(id).first();
    expect(row).toEqual({ amount_cents: 1250, payee: "Padaria" });
  });

  it("a background add with a bad value answers a JSON error and saves nothing", async () => {
    const b = await admin();
    const r = await background(b, { kind: "out", amount: "0", date: "2026-10-05", category_id: "" });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "Valor inválido." });
    expect(await count()).toBe(0);
  });

  it("without JS the ticked box returns to an empty form with the box still ticked", async () => {
    const b = await admin();
    const r = await b.form("/nova", { kind: "out", amount: "5", date: "2026-10-05", category_id: "", continuar: "1" });
    expect(r.status).toBe(302);
    const to = r.headers.get("location")!;
    expect(to).toMatch(/^\/nova\?continuar=1&ok=/);
    const page = await (await b.fetch(to)).text();
    expect(page).toMatch(/id="keepgoing"[^>]*checked/);
    expect(await count()).toBe(1);
  });

  it("an ordinary add still lands on the home page of that month", async () => {
    const b = await admin();
    const r = await b.form("/nova", { kind: "out", amount: "5", date: "2026-09-05", category_id: "" });
    expect(r.headers.get("location")).toMatch(/^\/\?mes=2026-09&ok=/);
  });
});
