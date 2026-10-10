import { Hono } from "hono";
import type { AppEnv } from "../env";
import { requireAdmin } from "../middleware";
import { home } from "./home";
import { transacoes } from "./transacoes";
import { categorias } from "./categorias";
import { planejamento } from "./planejamento";
import { relatorios } from "./relatorios";
import { mais } from "./mais";
import { admin } from "./admin";

export const app = new Hono<AppEnv>();

// Everyone who is logged in: ledger, alerts, the plan (read-only for non-admins), own password.
app.route("/", home);
app.route("/", transacoes);
app.route("/", mais);
app.route("/planejamento", planejamento);
app.get("/orcamento", (c) => c.redirect("/planejamento" + (c.req.query("mes") ? `?mes=${c.req.query("mes")}` : "")));

// Admins only: categories, reports, access management.
app.use("/categorias/*", requireAdmin);
app.use("/categorias", requireAdmin);
app.use("/relatorios/*", requireAdmin);
app.use("/relatorios", requireAdmin);
app.use("/acessos/*", requireAdmin);
app.use("/acessos", requireAdmin);
app.route("/categorias", categorias);
app.route("/relatorios", relatorios);
app.route("/acessos", admin);
