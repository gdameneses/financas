import { Hono } from "hono";
import type { AppEnv } from "../env";
import { requireAdmin } from "../middleware";
import { home } from "./home";
import { transacoes } from "./transacoes";
import { categorias } from "./categorias";
import { orcamento } from "./orcamento";
import { relatorios } from "./relatorios";
import { mais } from "./mais";
import { admin } from "./admin";

export const app = new Hono<AppEnv>();

// Everyone who is logged in: ledger + own password.
app.route("/", home);
app.route("/", transacoes);
app.route("/", mais);

// Admins only: categories, budgets, reports, access management.
app.use("/categorias/*", requireAdmin);
app.use("/categorias", requireAdmin);
app.use("/orcamento/*", requireAdmin);
app.use("/orcamento", requireAdmin);
app.use("/relatorios/*", requireAdmin);
app.use("/relatorios", requireAdmin);
app.use("/acessos/*", requireAdmin);
app.use("/acessos", requireAdmin);
app.route("/categorias", categorias);
app.route("/orcamento", orcamento);
app.route("/relatorios", relatorios);
app.route("/acessos", admin);
