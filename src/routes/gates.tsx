import { Hono } from "hono";
import type { AppEnv } from "../env";
import { Layout } from "../pages/layout";
import { enrollDevice, redeemEnrollCode } from "../auth/device";
import { hashPassword, verifyPassword } from "../auth/crypto";
import {
  clearLoginAttempts,
  createSession,
  destroySession,
  findSession,
  loginRateLimited,
  recordLoginAttempt,
  sessionTokenFromRequest,
} from "../auth/session";

export const gates = new Hono<AppEnv>();

const EnrollPage = ({ error }: { error?: string }) => (
  <Layout title="Novo dispositivo" bare>
    <div class="gate">
      <h1>Dispositivo não reconhecido</h1>
      <p>Para liberar este aparelho, digite um código gerado em <b>Mais → Dispositivos</b> num aparelho já liberado.</p>
      {error ? <p class="err">{error}</p> : null}
      <form method="post" action="/enroll">
        <label>
          Código
          <input name="code" autocomplete="one-time-code" autocapitalize="characters" required autofocus />
        </label>
        <label>
          Nome deste aparelho
          <input name="name" placeholder="ex.: celular" required maxlength={40} />
        </label>
        <button type="submit">Liberar</button>
      </form>
    </div>
  </Layout>
);

gates.get("/enroll", (c) => {
  // Already enrolled devices skip straight to the app.
  if (c.get("device")) return c.redirect("/");
  return c.html(<EnrollPage />);
});

gates.post("/enroll", async (c) => {
  if (c.get("device")) return c.redirect("/");
  const form = await c.req.parseBody();
  const code = String(form.code ?? "");
  const name = String(form.name ?? "").trim().slice(0, 40) || "aparelho";
  if (!(await redeemEnrollCode(c.env.DB, code, c.env.ENROLL_SECRET))) {
    return c.html(<EnrollPage error="Código inválido ou expirado." />, 400);
  }
  await enrollDevice(c, name);
  return c.redirect("/login");
});

const LoginPage = ({ error, firstRun }: { error?: string; firstRun: boolean }) => (
  <Layout title={firstRun ? "Criar conta" : "Entrar"} bare>
    <div class="gate">
      <h1>{firstRun ? "Criar sua conta" : "Entrar"}</h1>
      {firstRun ? <p>Primeiro acesso: defina o e-mail e a senha que você usará daqui em diante.</p> : null}
      {error ? <p class="err">{error}</p> : null}
      <form method="post" action="/login">
        <label>
          E-mail
          <input name="email" type="email" autocomplete="username" required autofocus />
        </label>
        <label>
          Senha
          <input name="password" type="password" autocomplete={firstRun ? "new-password" : "current-password"} required minlength={8} />
        </label>
        <button type="submit">{firstRun ? "Criar" : "Entrar"}</button>
      </form>
    </div>
  </Layout>
);

async function userCount(db: D1Database): Promise<number> {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
  return r?.n ?? 0;
}

gates.get("/login", async (c) => {
  const device = c.get("device");
  if (await findSession(c.env.DB, sessionTokenFromRequest(c), device.id)) return c.redirect("/");
  return c.html(<LoginPage firstRun={(await userCount(c.env.DB)) === 0} />);
});

gates.post("/login", async (c) => {
  const device = c.get("device");
  const db = c.env.DB;
  const form = await c.req.parseBody();
  const email = String(form.email ?? "").trim().toLowerCase();
  const password = String(form.password ?? "");
  const firstRun = (await userCount(db)) === 0;

  if (firstRun) {
    if (!email || password.length < 8) return c.html(<LoginPage firstRun error="Senha com ao menos 8 caracteres." />, 400);
    const h = await hashPassword(password);
    const r = await db
      .prepare("INSERT INTO users (email, password_hash, salt, iterations) VALUES (?, ?, ?, ?)")
      .bind(email, h.hash, h.salt, h.iterations)
      .run();
    await createSession(c, Number(r.meta.last_row_id), device.id);
    return c.redirect("/");
  }

  if (await loginRateLimited(db, device.id)) {
    return c.html(<LoginPage firstRun={false} error="Muitas tentativas. Aguarde 15 minutos." />, 429);
  }
  const user = await db
    .prepare("SELECT id, password_hash, salt, iterations FROM users WHERE email = ?")
    .bind(email)
    .first<{ id: number; password_hash: string; salt: string; iterations: number }>();
  const ok =
    user !== null && (await verifyPassword(password, { hash: user.password_hash, salt: user.salt, iterations: user.iterations }));
  if (!ok) {
    await recordLoginAttempt(db, device.id);
    return c.html(<LoginPage firstRun={false} error="E-mail ou senha incorretos." />, 401);
  }
  await clearLoginAttempts(db, device.id);
  await createSession(c, user!.id, device.id);
  return c.redirect("/");
});

gates.post("/logout", async (c) => {
  const device = c.get("device");
  const s = await findSession(c.env.DB, sessionTokenFromRequest(c), device.id);
  if (s) await destroySession(c, s.sessionId);
  return c.redirect("/login");
});
