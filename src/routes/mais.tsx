import { Hono } from "hono";
import type { AppEnv, Device } from "../env";
import { Layout } from "../pages/layout";
import { createEnrollCode, revokeDevice } from "../auth/device";
import { hashPassword, verifyPassword } from "../auth/crypto";

export const mais = new Hono<AppEnv>();

mais.get("/mais", (c) => {
  const user = c.get("user");
  return c.html(
    <Layout title="Mais" active="mais" toast={c.req.query("ok") ?? undefined}>
      <h1>Mais</h1>
      <ul class="menu">
        <li>
          <a href="/categorias">🏷️ Categorias</a>
        </li>
        <li>
          <a href="/orcamento">🎯 Orçamento</a>
        </li>
        <li>
          <a href="/dispositivos">📱 Dispositivos</a>
        </li>
        <li>
          <a href="/config">🔐 Senha</a>
        </li>
        <li>
          <a href="/api/export.json" download>
            ⬇ Exportar tudo (JSON)
          </a>
        </li>
      </ul>
      <p class="muted">Conectado como {user.email}</p>
      <form method="post" action="/logout">
        <button type="submit" class="btn ghost">
          Sair
        </button>
      </form>
    </Layout>,
  );
});

mais.get("/dispositivos", async (c) => {
  const me = c.get("device");
  const r = await c.env.DB.prepare(
    "SELECT id, name, user_agent, created_at, last_seen_at, revoked_at FROM devices WHERE revoked_at IS NULL ORDER BY last_seen_at DESC",
  ).all<Device>();
  const code = c.req.query("code");
  return c.html(
    <Layout title="Dispositivos" active="mais" toast={c.req.query("ok") ?? undefined}>
      <h1>Dispositivos liberados</h1>
      <p class="muted">Só aparelhos desta lista conseguem abrir o app. Para liberar um novo, gere um código e digite nele em até 10 minutos.</p>
      {code ? (
        <section class="card code">
          <small>Código (uso único, 10 min)</small>
          <b>{code}</b>
        </section>
      ) : null}
      <form method="post" action="/dispositivos/codigo">
        <button type="submit" class="btn">
          Gerar código de liberação
        </button>
      </form>
      <ul class="devlist">
        {r.results.map((d) => (
          <li>
            <span class="txt">
              <b>
                {d.name}
                {d.id === me.id ? " (este)" : ""}
              </b>
              <small>visto {d.last_seen_at.slice(0, 10)} · {shortUA(d.user_agent)}</small>
            </span>
            {d.id === me.id ? null : (
              <form method="post" action={`/dispositivos/${d.id}/revogar`} onsubmit="return confirm('Revogar este aparelho?')">
                <button type="submit" class="btn small danger">
                  Revogar
                </button>
              </form>
            )}
          </li>
        ))}
      </ul>
    </Layout>,
  );
});

function shortUA(ua: string): string {
  if (/iphone|ipad/i.test(ua)) return "iOS";
  if (/android/i.test(ua)) return "Android";
  if (/windows/i.test(ua)) return "Windows";
  if (/mac os/i.test(ua)) return "macOS";
  if (/linux/i.test(ua)) return "Linux";
  return "desconhecido";
}

mais.post("/dispositivos/codigo", async (c) => {
  const code = await createEnrollCode(c.env.DB, c.get("device").id);
  return c.redirect(`/dispositivos?code=${code}`);
});

mais.post("/dispositivos/:id/revogar", async (c) => {
  const id = Number(c.req.param("id"));
  if (id === c.get("device").id) return c.text("Não dá para revogar o aparelho atual", 400);
  await revokeDevice(c.env.DB, id);
  return c.redirect(`/dispositivos?ok=${encodeURIComponent("Aparelho revogado")}`);
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
      <button type="submit" class="btn">
        Salvar
      </button>
    </form>
  </Layout>
);

mais.get("/config", (c) => c.html(<ConfigPage ok={c.req.query("ok") ?? undefined} />));

mais.post("/config/senha", async (c) => {
  const user = c.get("user");
  const form = await c.req.parseBody();
  const row = await c.env.DB.prepare("SELECT password_hash, salt, iterations FROM users WHERE id = ?")
    .bind(user.id)
    .first<{ password_hash: string; salt: string; iterations: number }>();
  if (!row || !(await verifyPassword(String(form.current ?? ""), { hash: row.password_hash, salt: row.salt, iterations: row.iterations }))) {
    return c.html(<ConfigPage error="Senha atual incorreta." />, 401);
  }
  const next = String(form.next ?? "");
  if (next.length < 8) return c.html(<ConfigPage error="A nova senha precisa de ao menos 8 caracteres." />, 400);
  const h = await hashPassword(next);
  await c.env.DB.prepare("UPDATE users SET password_hash = ?, salt = ?, iterations = ? WHERE id = ?")
    .bind(h.hash, h.salt, h.iterations, user.id)
    .run();
  return c.redirect(`/config?ok=${encodeURIComponent("Senha alterada")}`);
});
