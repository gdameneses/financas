import { Hono } from "hono";
import type { AppEnv } from "./env";
import { accessLog, requireAccess, requireAdmin, requireIpAndDevice, requireSession } from "./middleware";
import { gates } from "./routes/gates";
import { app as pages } from "./routes/pages";
import { api } from "./routes/api";

const app = new Hono<AppEnv>();

// Layer 0: static assets, client IP, and one access_log row for every other request.
app.use("*", accessLog);

// Layer 1: Cloudflare Access identity must be present in production.
app.use("*", requireAccess);

// Layer 2: IP allowlist + approved device. Unapproved traffic only ever sees /acesso.
app.use("*", requireIpAndDevice);

// Gate pages (request access, login, logout) sit before the session requirement.
app.route("/", gates);

// Layer 3: login session for everything else.
app.use("*", requireSession);
app.route("/", pages);

// Reports and export are admin-only.
app.use("/api/*", requireAdmin);
app.route("/api", api);

app.notFound((c) => c.text("Não encontrado", 404));
app.onError((err, c) => {
  console.error(err);
  return c.text("Erro interno", 500);
});

export default app;
