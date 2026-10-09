import { Hono } from "hono";
import type { AppEnv } from "../env";
import { home } from "./home";
import { transacoes } from "./transacoes";
import { categorias } from "./categorias";
import { orcamento } from "./orcamento";
import { relatorios } from "./relatorios";
import { mais } from "./mais";

export const app = new Hono<AppEnv>();
app.route("/", home);
app.route("/", transacoes);
app.route("/categorias", categorias);
app.route("/orcamento", orcamento);
app.route("/relatorios", relatorios);
app.route("/", mais);
