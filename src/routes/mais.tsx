import { Hono } from "hono";
import type { AppEnv } from "../env";
import { Layout } from "../pages/layout";
import { Icon } from "../pages/bits";
import { hashPassword, verifyPassword } from "../auth/crypto";
import { clearLoginAttempts, destroyOtherSessions, loginRateLimited, recordLoginAttempt } from "../auth/session";
import { currentNucleo } from "../nucleos";

export const mais = new Hono<AppEnv>();

// Works without a núcleo (mounted before requireNucleo): a new user can still reach Senha, Sair
// and the núcleo page from here.
mais.get("/mais", async (c) => {
  const user = c.get("user");
  const nucleo = await currentNucleo(c.env.DB, user.id);
  const nucleoAdmin = nucleo?.role === "admin";
  const pending = user.appAdmin
    ? ((await c.env.DB.prepare("SELECT COUNT(*) AS n FROM devices WHERE status = 'pending'").first<{ n: number }>())?.n ?? 0)
    : 0;
  return c.html(
    <Layout title="Mais" active="mais" toast={c.req.query("ok") ?? undefined}>
      <h1>Mais</h1>
      <ul class="menu">
        <li>
          <a href={nucleo ? "/nucleo" : "/comecar"}>
            <Icon name="users-three" /> Núcleo
            {nucleo ? <small class="muted"> · {nucleo.name}</small> : <small class="badge new">criar ou entrar</small>}
          </a>
        </li>
        {nucleoAdmin ? (
          <>
            <li>
              <a href="/categorias">
                <Icon name="tag" /> Categorias
              </a>
            </li>
            <li>
              <a href="/relatorios">
                <Icon name="trend-up" /> Relatórios
              </a>
            </li>
            <li>
              <a href="/api/export.json" download>
                <Icon name="download-simple" /> Exportar o núcleo (JSON)
              </a>
            </li>
          </>
        ) : null}
        {user.appAdmin ? (
          <li>
            <a href="/acessos">
              <Icon name="shield-check" /> Acessos
              {pending ? <small class="badge new">{pending} pendente(s)</small> : null}
            </a>
          </li>
        ) : null}
        <li>
          <a href="/config">
            <Icon name="lock-key" /> Senha
          </a>
        </li>
      </ul>
      <p class="muted">
        {user.email}
        {nucleo ? ` · ${nucleoAdmin ? "administrador" : "membro"} de ${nucleo.name}` : ""}
        {user.appAdmin ? " · administra o app" : ""}
      </p>
      <form method="post" action="/logout">
        <button type="submit" class="btn ghost">
          Sair
        </button>
      </form>
    </Layout>,
  );
});

const ConfigPage = ({ error, ok }: { error?: string; ok?: string }) => (
  <Layout title="Senha" active="mais" toast={ok}>
    <h1>Trocar senha</h1>
    {error ? <p class="err">{error}</p> : null}
    <form method="post" action="/config/senha" class="stack">
      <label>
        Senha atual
        <input type="password" name="current" autocomplete="current-password" required />
      </label>
      <label>
        Nova senha
        <input type="password" name="next" autocomplete="new-password" required minlength={8} />
      </label>
      <button type="submit" class="btn primary">
        Salvar
      </button>
    </form>
  </Layout>
);

mais.get("/config", (c) => c.html(<ConfigPage ok={c.req.query("ok") ?? undefined} />));

mais.post("/config/senha", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const form = await c.req.parseBody();
  // Same per-e-mail counter as /login: a hijacked session cannot guess the current password freely.
  if (await loginRateLimited(db, user.email)) return c.html(<ConfigPage error="Muitas tentativas. Aguarde 15 minutos." />, 429);
  const row = await db.prepare("SELECT password_hash, salt, iterations FROM users WHERE id = ?")
    .bind(user.id)
    .first<{ password_hash: string; salt: string; iterations: number }>();
  if (!row || !(await verifyPassword(String(form.current ?? ""), { hash: row.password_hash, salt: row.salt, iterations: row.iterations }))) {
    await recordLoginAttempt(db, user.email);
    return c.html(<ConfigPage error="Senha atual incorreta." />, 401);
  }
  const next = String(form.next ?? "");
  if (next.length < 8) return c.html(<ConfigPage error="A nova senha precisa de ao menos 8 caracteres." />, 400);
  const h = await hashPassword(next);
  await db.prepare("UPDATE users SET password_hash = ?, salt = ?, iterations = ? WHERE id = ?").bind(h.hash, h.salt, h.iterations, user.id).run();
  await clearLoginAttempts(db, user.email);
  // Changing the password logs out every other browser of this user.
  await destroyOtherSessions(db, user.id, c.get("sessionId"));
  return c.redirect(`/config?ok=${encodeURIComponent("Senha alterada")}`);
});
