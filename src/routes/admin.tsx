// Admin-only: access requests, devices, users, allowed IPs and the access log.
import { Hono } from "hono";
import type { AppEnv, Device } from "../env";
import { Layout } from "../pages/layout";
import { Icon } from "../pages/bits";
import { approveDevice, denyDevice, getDevice, revokeDevice } from "../auth/device";
import { parseId } from "../middleware";
import { banUser, unbanUser } from "../auth/session";
import { parseCidr } from "../lib/ip";
import { adminEmails } from "../lib/email";
import { currentNucleo } from "../nucleos";

export const admin = new Hono<AppEnv>();

const TABS = ["pedidos", "aparelhos", "usuarios", "ips", "log"] as const;
type Tab = (typeof TABS)[number];
const LABELS: Record<Tab, string> = { pedidos: "Pedidos", aparelhos: "Aparelhos", usuarios: "Usuários", ips: "IPs", log: "Registro" };

type CodeRow = { id: number; code: string; device_id: number; ip: string; email: string; name: string; attempts: number; created_at: string; expires_at: string; emailed: number };
type UserRow = { id: number; email: string; created_at: string; banned_at: string | null; devices: number };
type IpRow = { id: number; cidr: string; label: string; created_at: string };
type LogRow = { id: number; at: string; ip: string; country: string; user_agent: string; device_id: number | null; user_id: number | null; method: string; path: string; status: number; outcome: string; email: string | null; device_name: string | null };

function shortUA(ua: string): string {
  if (/iphone|ipad/i.test(ua)) return "iOS";
  if (/android/i.test(ua)) return "Android";
  if (/windows/i.test(ua)) return "Windows";
  if (/mac os/i.test(ua)) return "macOS";
  if (/linux/i.test(ua)) return "Linux";
  return "?";
}

const when = (s: string) => s.slice(5, 16).replace("T", " ").replace(" ", " ");

admin.get("/", async (c) => {
  const db = c.env.DB;
  const tabQ = c.req.query("tab");
  const tab: Tab = (TABS as readonly string[]).includes(tabQ ?? "") ? (tabQ as Tab) : "pedidos";
  const me = c.get("user");
  const myIp = c.get("ip");
  // Approving can drop the new account straight into the admin's current núcleo (when they administer it).
  const myNucleo = await currentNucleo(db, me.id);
  const joinable = myNucleo && myNucleo.role === "admin" ? myNucleo : null;
  const pendingCount = (await db.prepare("SELECT COUNT(*) AS n FROM devices WHERE status = 'pending'").first<{ n: number }>())?.n ?? 0;

  const admins = adminEmails(c.env);
  let body;
  if (tab === "pedidos") {
    const codes = (
      await db
        .prepare(
          `SELECT c.* FROM access_codes c JOIN devices d ON d.id = c.device_id
           WHERE d.status = 'pending' AND c.used_at IS NULL ORDER BY c.id DESC`,
        )
        .all<CodeRow>()
    ).results;
    body = codes.length ? (
      <ul class="reqs">
        {codes.map((r) => {
          const live = r.expires_at > new Date().toISOString().slice(0, 19).replace("T", " ");
          return (
            <li>
              <div class="txt">
                <b>
                  {r.name} <small class="muted">{r.email}</small>
                </b>
                <small>
                  IP {r.ip} · {when(r.created_at)} · {r.emailed ? "e-mail enviado" : "só no app"}
                  {r.attempts ? ` · ${r.attempts} tentativa(s)` : ""}
                </small>
              </div>
              <div class="codebox">
                <small>{live ? "código, 30 min" : "expirado"}</small>
                <b>{r.code.slice(0, 4)} {r.code.slice(4)}</b>
              </div>
              {admins.includes(r.email) ? (
                <p class="err">
                  Este pedido usa um e-mail de <b>administrador</b>. Aprovar entrega essa conta a quem fez o pedido. Só aprove se a pessoa for mesmo quem diz.
                </p>
              ) : null}
              <div class="row">
                <form method="post" action={`/acessos/aparelhos/${r.device_id}/aprovar`} class="inline">
                  <label class="check">
                    <input type="checkbox" name="allow_ip" value="1" checked /> liberar IP {r.ip}
                  </label>
                  {joinable ? (
                    <label class="check">
                      <input type="checkbox" name="join_nucleo" value="1" /> já entrar em “{joinable.name}” como membro
                    </label>
                  ) : null}
                  {admins.includes(r.email) ? (
                    <label class="check">
                      <input type="checkbox" name="confirm_admin" value="1" /> confirmo que é {r.email}
                    </label>
                  ) : null}
                  <button class="btn small">Aprovar agora</button>
                </form>
                <form method="post" action={`/acessos/aparelhos/${r.device_id}/negar`} class="inline">
                  <button class="btn small danger">Negar</button>
                </form>
              </div>
            </li>
          );
        })}
      </ul>
    ) : (
      <p class="muted">Nenhum pedido pendente. Quando alguém pedir acesso, o código aparece aqui e por e-mail.</p>
    );
  } else if (tab === "aparelhos") {
    const devices = (
      await db
        .prepare("SELECT id, name, user_agent, status, requested_email, requested_ip, created_at, last_seen_at, approved_at, revoked_at FROM devices WHERE status IN ('approved','pending') ORDER BY last_seen_at DESC")
        .all<Device>()
    ).results;
    const mine = c.get("device").id;
    body = (
      <ul class="devlist">
        {devices.map((d) => (
          <li>
            <span class="txt">
              <b>
                {d.name}
                {d.id === mine ? " (este)" : ""}
                {d.status === "pending" ? <small class="badge">pendente</small> : null}
              </b>
              <small>
                {d.requested_email || "sem e-mail"} · {shortUA(d.user_agent)} · visto {d.last_seen_at.slice(0, 10)} · IP {d.requested_ip || "?"}
              </small>
            </span>
            {d.id === mine ? null : (
              <form method="post" action={`/acessos/aparelhos/${d.id}/revogar`} onsubmit="return confirm('Revogar este aparelho?')">
                <button class="btn small danger">Revogar</button>
              </form>
            )}
          </li>
        ))}
      </ul>
    );
  } else if (tab === "usuarios") {
    const users = (
      await db
        .prepare("SELECT u.id, u.email, u.created_at, u.banned_at, (SELECT COUNT(*) FROM devices d WHERE d.requested_email = u.email AND d.status = 'approved') AS devices FROM users u ORDER BY u.id")
        .all<UserRow>()
    ).results;
    body = (
      <ul class="devlist">
        {users.map((u) => (
          <li>
            <span class="txt">
              <b>
                {u.email}
                {admins.includes(u.email) ? <small class="badge">admin</small> : null}
                {u.banned_at ? <small class="badge gone">bloqueado</small> : null}
              </b>
              <small>
                desde {u.created_at.slice(0, 10)} · {u.devices} aparelho(s)
              </small>
            </span>
            {u.id === me.id || admins.includes(u.email) ? null : u.banned_at ? (
              <form method="post" action={`/acessos/usuarios/${u.id}/desbloquear`}>
                <button class="btn small">Desbloquear</button>
              </form>
            ) : (
              <form method="post" action={`/acessos/usuarios/${u.id}/bloquear`} onsubmit="return confirm('Bloquear este usuário? As sessões e aparelhos dele são revogados.')">
                <button class="btn small danger">Bloquear</button>
              </form>
            )}
          </li>
        ))}
      </ul>
    );
  } else if (tab === "ips") {
    const ips = (await db.prepare("SELECT id, cidr, label, created_at FROM allowed_ips ORDER BY id DESC").all<IpRow>()).results;
    const myIpListed = ips.some((x) => x.cidr === myIp);
    body = (
      <>
        <p class="muted">
          Só endereços desta lista acessam o app. Seu IP agora: <b>{myIp}</b>
          {myIpListed ? " (já na lista)" : ""}
        </p>
        <form method="post" action="/acessos/ips" class="row ipform">
          <label>
            IP ou faixa (CIDR)
            <input name="cidr" value={myIpListed ? "" : myIp} placeholder="203.0.113.7 ou 203.0.113.0/24" required />
          </label>
          <label>
            Rótulo
            <input name="label" placeholder="casa" maxlength={40} />
          </label>
          <button class="btn small">Adicionar</button>
        </form>
        <ul class="devlist">
          {ips.map((x) => (
            <li>
              <span class="txt">
                <b>{x.cidr}</b>
                <small>
                  {x.label || "sem rótulo"} · {x.created_at.slice(0, 10)}
                </small>
              </span>
              <form method="post" action={`/acessos/ips/${x.id}/remover`} onsubmit="return confirm('Remover este IP da lista?')">
                <button class="btn small danger">Remover</button>
              </form>
            </li>
          ))}
        </ul>
      </>
    );
  } else {
    const only = c.req.query("so") ?? "";
    const rows = (
      await db
        .prepare(
          `SELECT l.*, u.email, d.name AS device_name FROM access_log l
           LEFT JOIN users u ON u.id = l.user_id LEFT JOIN devices d ON d.id = l.device_id
           ${only === "negados" ? "WHERE l.outcome <> 'ok'" : ""} ORDER BY l.id DESC LIMIT 200`,
        )
        .all<LogRow>()
    ).results;
    body = (
      <>
        <p class="downloads">
          <a href="/acessos?tab=log" class={only ? "" : "on"}>
            tudo
          </a>
          <a href="/acessos?tab=log&so=negados" class={only ? "on" : ""}>
            só negados
          </a>
        </p>
        <table class="rep log">
          <thead>
            <tr>
              <th>Quando</th>
              <th>Quem</th>
              <th>Rota</th>
              <th>Resultado</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr class={r.outcome === "ok" ? "" : "deny"}>
                <td>{when(r.at)}</td>
                <td>
                  {r.email ?? r.device_name ?? "sem nome"}
                  <small>
                    {r.ip}
                    {r.country ? ` ${r.country}` : ""} · {shortUA(r.user_agent)}
                  </small>
                </td>
                <td>
                  {r.method} {r.path}
                </td>
                <td>
                  {r.status} {r.outcome}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </>
    );
  }

  return c.html(
    <Layout title="Acessos" active="mais" toast={c.req.query("ok") ?? undefined}>
      <h1>
        <Icon name="shield-check" /> Acessos
      </h1>
      <nav class="subtabs">
        {TABS.map((t) => (
          <a href={`/acessos?tab=${t}`} class={t === tab ? "on" : ""}>
            {LABELS[t]}
            {t === "pedidos" && pendingCount ? ` (${pendingCount})` : ""}
          </a>
        ))}
      </nav>
      {body}
    </Layout>,
  );
});

const back = (tab: Tab, ok: string) => `/acessos?tab=${tab}&ok=${encodeURIComponent(ok)}`;

admin.post("/aparelhos/:id/aprovar", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.notFound();
  const form = await c.req.parseBody();
  const d = await getDevice(c.env.DB, id);
  if (!d || d.status !== "pending") return c.notFound();
  // Approving a request that claims an admin address hands that account over: require the explicit tick.
  if (adminEmails(c.env).includes(d.requested_email) && form.confirm_admin !== "1") {
    return c.redirect(back("pedidos", "Pedido com e-mail de administrador: marque a confirmação para aprovar"));
  }
  let join: number | null = null;
  if (form.join_nucleo === "1") {
    const mine = await currentNucleo(c.env.DB, c.get("user").id);
    if (mine && mine.role === "admin") join = mine.id;
  }
  await approveDevice(c.env.DB, id, c.get("user").id, form.allow_ip === "1", join);
  return c.redirect(back("pedidos", join ? "Aparelho aprovado; a conta entra no seu núcleo" : "Aparelho aprovado"));
});
admin.post("/aparelhos/:id/negar", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.notFound();
  await denyDevice(c.env.DB, id);
  return c.redirect(back("pedidos", "Pedido negado"));
});
admin.post("/aparelhos/:id/revogar", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.notFound();
  if (id === c.get("device").id) return c.text("Não dá para revogar o aparelho atual", 400);
  await revokeDevice(c.env.DB, id);
  return c.redirect(back("aparelhos", "Aparelho revogado"));
});
admin.post("/usuarios/:id/bloquear", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.notFound();
  const u = await c.env.DB.prepare("SELECT email FROM users WHERE id = ?").bind(id).first<{ email: string }>();
  if (!u) return c.notFound();
  if (id === c.get("user").id || adminEmails(c.env).includes(u.email)) return c.text("Não dá para bloquear um administrador", 400);
  await banUser(c.env.DB, id, u.email);
  return c.redirect(back("usuarios", "Usuário bloqueado"));
});
admin.post("/usuarios/:id/desbloquear", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.notFound();
  await unbanUser(c.env.DB, id);
  return c.redirect(back("usuarios", "Usuário desbloqueado"));
});
admin.post("/ips", async (c) => {
  const form = await c.req.parseBody();
  const cidr = String(form.cidr ?? "").trim();
  if (!parseCidr(cidr)) return c.text("IP ou faixa inválida", 400);
  await c.env.DB.prepare("INSERT OR IGNORE INTO allowed_ips (cidr, label, created_by) VALUES (?, ?, ?)")
    .bind(cidr, String(form.label ?? "").trim().slice(0, 40), c.get("user").id)
    .run();
  return c.redirect(back("ips", "IP adicionado"));
});
admin.post("/ips/:id/remover", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.notFound();
  // The allowlist is mandatory: removing the last entry would silently switch the layer off.
  const n = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM allowed_ips").first<{ n: number }>();
  if ((n?.n ?? 0) <= 1) return c.redirect(back("ips", "A lista não pode ficar vazia: adicione outro IP antes de remover este"));
  await c.env.DB.prepare("DELETE FROM allowed_ips WHERE id = ?").bind(id).run();
  return c.redirect(back("ips", "IP removido"));
});
