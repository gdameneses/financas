// Structured outputs: every report as JSON and Markdown, plus a full export.
// These are what Gus feeds to Claude Code; no LLM runs here.
import { Hono } from "hono";
import type { AppEnv } from "../env";
import { exportAll, listTransactions } from "../db";
import { buildMensal, mensalMarkdown } from "../reports/mensal";
import { buildTendencia, tendenciaMarkdown } from "../reports/tendencia";
import { detectRecorrentes, recorrentesMarkdown } from "../reports/recorrentes";
import { buildOrcamento, orcamentoMarkdown } from "../reports/orcamento";
import { currentMonth, isMonth } from "../lib/dates";

export const api = new Hono<AppEnv>();

const md = (body: string, name: string) =>
  new Response(body, {
    headers: { "content-type": "text/markdown; charset=utf-8", "content-disposition": `inline; filename="${name}.md"` },
  });

function monthParam(raw: string | undefined): string | null {
  if (!raw) return currentMonth();
  return isMonth(raw) ? raw : null;
}

api.get("/export.json", async (c) => {
  const data = await exportAll(c.env.DB, c.get("nucleo").id);
  c.header("content-disposition", `attachment; filename="financas-${data.exported_at.slice(0, 10)}.json"`);
  return c.json(data);
});

// Hono can't follow a path param with a literal suffix, so the whole "YYYY-MM.json" is the param.
function splitFile(file: string): { mes: string; ext: "json" | "md" } | null {
  const m = /^(\d{4}-(?:0[1-9]|1[0-2]))\.(json|md)$/.exec(file);
  return m ? { mes: m[1], ext: m[2] as "json" | "md" } : null;
}

api.get("/report/mensal/:file", async (c) => {
  const f = splitFile(c.req.param("file"));
  if (!f) return c.notFound();
  const r = await buildMensal(c.env.DB, c.get("nucleo").id, f.mes);
  return f.ext === "json" ? c.json(r) : md(mensalMarkdown(r), `mensal-${f.mes}`);
});

api.get("/report/tendencia.json", async (c) => {
  const ate = monthParam(c.req.query("ate"));
  if (!ate) return c.text("ate inválido", 400);
  return c.json(await buildTendencia(c.env.DB, c.get("nucleo").id, ate));
});
api.get("/report/tendencia.md", async (c) => {
  const ate = monthParam(c.req.query("ate"));
  if (!ate) return c.text("ate inválido", 400);
  return md(tendenciaMarkdown(await buildTendencia(c.env.DB, c.get("nucleo").id, ate)), `tendencia-${ate}`);
});

api.get("/report/recorrentes.json", async (c) => {
  const mes = monthParam(c.req.query("mes"));
  if (!mes) return c.text("mes inválido", 400);
  return c.json(detectRecorrentes(await listTransactions(c.env.DB, c.get("nucleo").id), mes));
});
api.get("/report/recorrentes.md", async (c) => {
  const mes = monthParam(c.req.query("mes"));
  if (!mes) return c.text("mes inválido", 400);
  return md(recorrentesMarkdown(detectRecorrentes(await listTransactions(c.env.DB, c.get("nucleo").id), mes)), `recorrentes-${mes}`);
});

api.get("/report/orcamento/:file", async (c) => {
  const f = splitFile(c.req.param("file"));
  if (!f) return c.notFound();
  const r = await buildOrcamento(c.env.DB, c.get("nucleo").id, f.mes);
  return f.ext === "json" ? c.json(r) : md(orcamentoMarkdown(r), `orcamento-${f.mes}`);
});
