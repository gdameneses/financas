import { Hono } from "hono";
import type { AppEnv } from "./env";
import { requireAccess, requireDevice, requireSession } from "./middleware";
import { gates } from "./routes/gates";
import { app as pages } from "./routes/pages";
import { api } from "./routes/api";

const app = new Hono<AppEnv>();

// Layer 1: Cloudflare Access identity must be present in production.
app.use("*", requireAccess);

// Layer 2: enrolled device cookie. Unenrolled browsers only ever see /enroll.
app.use("*", requireDevice);

// Gate pages (enroll, login, logout) sit before the session requirement.
app.route("/", gates);

// Layer 3: login session for everything else.
app.use("*", requireSession);
app.route("/", pages);
app.route("/api", api);

app.notFound((c) => c.text("Não encontrado", 404));
app.onError((err, c) => {
  console.error(err);
  return c.text("Erro interno", 500);
});

export default app;
