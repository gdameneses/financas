import { Hono } from "hono";
import type { AppEnv } from "../env";
import { requireAppAdmin, requireNucleo, requireNucleoAdmin } from "../middleware";
import { home } from "./home";
import { transacoes } from "./transacoes";
import { categorias } from "./categorias";
import { planejamento } from "./planejamento";
import { relatorios } from "./relatorios";
import { mais } from "./mais";
import { admin } from "./admin";
import { nucleos } from "./nucleos";

export const app = new Hono<AppEnv>();

// Logged in, núcleo not required: Mais, own password, núcleo management (create / join / switch),
// and app administration (devices, IPs, users, access log).
app.route("/", mais);
app.route("/", nucleos);
app.use("/acessos/*", requireAppAdmin);
app.use("/acessos", requireAppAdmin);
app.route("/acessos", admin);

// Everything below works on the current núcleo; a user without one is sent to /comecar.
app.use("*", requireNucleo);
app.route("/", home);
app.route("/", transacoes);
app.route("/planejamento", planejamento);
app.get("/orcamento", (c) => c.redirect("/planejamento" + (c.req.query("mes") ? `?mes=${c.req.query("mes")}` : "")));

// Núcleo admins only: categories and reports.
app.use("/categorias/*", requireNucleoAdmin);
app.use("/categorias", requireNucleoAdmin);
app.use("/relatorios/*", requireNucleoAdmin);
app.use("/relatorios", requireNucleoAdmin);
app.route("/categorias", categorias);
app.route("/relatorios", relatorios);
