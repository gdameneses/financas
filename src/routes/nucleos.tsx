// Núcleos: create, join by invite, switch, and (for its admins) rename, members and invites.
// Mounted before requireNucleo: a brand-new user lands on /comecar with nothing yet.
import { Hono, type Context } from "hono";
import type { AppEnv, NucleoRole } from "../env";
import { Layout } from "../pages/layout";
import { Icon } from "../pages/bits";
import { parseId } from "../middleware";
import {
  countAdmins,
  createInvite,
  createNucleo,
  currentNucleo,
  joinWithInvite,
  listInvites,
  listMembers,
  listMemberships,
  removeMember,
  renameNucleo,
  revokeInvite,
  setCurrentNucleo,
  setRole,
} from "../nucleos";

export const nucleos = new Hono<AppEnv>();

const ROLE_LABEL: Record<NucleoRole, string> = { admin: "administrador", membro: "membro" };
const when = (s: string) => `${s.slice(8, 10)}/${s.slice(5, 7)}`;
const okTo = (path: string, msg: string) => `${path}?ok=${encodeURIComponent(msg)}`;

const JoinForm = ({ error }: { error?: string }) => (
  <form method="post" action="/nucleos/entrar" class="stack">
    {error ? <p class="err">{error}</p> : null}
    <label>
      Código de convite (8 dígitos)
      <input name="code" inputmode="numeric" pattern="[0-9 ]*" autocomplete="one-time-code" maxlength={9} required class="code" />
    </label>
    <button type="submit" class="btn primary">
      Entrar no núcleo
    </button>
  </form>
);

const CreateForm = ({ error }: { error?: string }) => (
  <form method="post" action="/nucleos" class="stack">
    {error ? <p class="err">{error}</p> : null}
    <label>
      Nome do núcleo
      <input name="name" placeholder="Casa, Família, República…" required maxlength={40} />
    </label>
    <button type="submit" class="btn primary">
      Criar núcleo
    </button>
  </form>
);

const StartPage = ({ error, step }: { error?: string; step: "create" | "join" }) => (
  <Layout title="Começar" bare>
    <div class="gate">
      <h1>Seu núcleo</h1>
      <p class="muted">
        Lançamentos, categorias e planejamento vivem dentro de um núcleo. Crie o seu ou entre no de alguém com um código de convite.
      </p>
      <section class="card">
        <h2>Criar o meu</h2>
        <CreateForm error={step === "create" ? error : undefined} />
      </section>
      <section class="card">
        <h2>Fui convidado</h2>
        <JoinForm error={step === "join" ? error : undefined} />
      </section>
      <form method="post" action="/logout">
        <button type="submit" class="btn ghost">
          Sair
        </button>
      </form>
    </div>
  </Layout>
);

nucleos.get("/comecar", async (c) => {
  if (await currentNucleo(c.env.DB, c.get("user").id)) return c.redirect("/");
  return c.html(<StartPage step="create" />);
});

function cleanName(raw: unknown): string {
  return String(raw ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
}

nucleos.post("/nucleos", async (c) => {
  const form = await c.req.parseBody();
  const name = cleanName(form.name);
  const hadNucleo = !!(await currentNucleo(c.env.DB, c.get("user").id));
  if (!name) {
    return hadNucleo ? c.redirect(okTo("/nucleo", "Dê um nome ao núcleo")) : c.html(<StartPage step="create" error="Dê um nome ao núcleo." />, 400);
  }
  await createNucleo(c.env.DB, c.get("user").id, name);
  return c.redirect(okTo("/", `Núcleo “${name}” criado`));
});

nucleos.post("/nucleos/entrar", async (c) => {
  const form = await c.req.parseBody();
  const hadNucleo = !!(await currentNucleo(c.env.DB, c.get("user").id));
  const r = await joinWithInvite(c.env.DB, c.get("user").id, c.get("ip"), String(form.code ?? ""));
  if (r.kind === "ok") return c.redirect(okTo("/", `Você entrou em “${r.name}”`));
  const msg = r.kind === "rate_limited" ? "Muitas tentativas. Tente em uma hora." : "Código inválido ou expirado.";
  if (hadNucleo) return c.redirect(okTo("/nucleo", msg));
  return c.html(<StartPage step="join" error={msg} />, r.kind === "rate_limited" ? 429 : 400);
});

nucleos.post("/nucleos/:id/ativar", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.notFound();
  if (!(await setCurrentNucleo(c.env.DB, c.get("user").id, id))) return c.notFound();
  return c.redirect("/");
});

// ---- the current núcleo's page ---------------------------------------------------------------

nucleos.get("/nucleo", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const cur = await currentNucleo(db, user.id);
  if (!cur) return c.redirect("/comecar");
  const isAdmin = cur.role === "admin";
  const [members, invites, all] = await Promise.all([listMembers(db, cur.id), isAdmin ? listInvites(db, cur.id) : Promise.resolve([]), listMemberships(db, user.id)]);
  const admins = members.filter((m) => m.role === "admin").length;
  const others = all.filter((n) => n.id !== cur.id);
  const canLeave = !(cur.role === "admin" && admins <= 1);

  return c.html(
    <Layout title={cur.name} active="mais" toast={c.req.query("ok") ?? undefined}>
      <h1>
        <Icon name="users-three" /> {cur.name}
      </h1>
      <p class="muted">
        Você é {ROLE_LABEL[cur.role]} · {members.length} pessoa(s)
      </p>

      {isAdmin ? (
        <section class="card">
          <h2>Nome</h2>
          <form method="post" action="/nucleo/nome" class="row ipform">
            <label>
              Nome do núcleo
              <input name="name" value={cur.name} required maxlength={40} />
            </label>
            <button class="btn small">Salvar</button>
          </form>
        </section>
      ) : null}

      <section>
        <h2>Pessoas</h2>
        <ul class="devlist">
          {members.map((m) => (
            <li>
              <span class="txt">
                <b>
                  {m.email}
                  {m.user_id === user.id ? " (você)" : ""}
                  {m.role === "admin" ? <small class="badge">admin</small> : null}
                </b>
                <small>desde {m.joined_at.slice(0, 10)}</small>
              </span>
              {isAdmin && m.user_id !== user.id ? (
                <span class="row">
                  <form method="post" action={`/nucleo/membros/${m.user_id}/papel`} class="inline">
                    <input type="hidden" name="role" value={m.role === "admin" ? "membro" : "admin"} />
                    <button class="btn small">{m.role === "admin" ? "Tornar membro" : "Tornar admin"}</button>
                  </form>
                  <form method="post" action={`/nucleo/membros/${m.user_id}/remover`} class="inline" onsubmit="return confirm('Remover esta pessoa do núcleo?')">
                    <button class="btn small danger">Remover</button>
                  </form>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      {isAdmin ? (
        <section class="card">
          <h2>Convidar</h2>
          <p class="muted">
            Gere um código e passe para a pessoa. Ela precisa já ter acesso ao app (aparelho liberado) e digita o código em <i>Começar</i> ou em <i>Mais → Núcleo → Entrar em outro núcleo</i>. Vale 7 dias, uma vez só.
          </p>
          <form method="post" action="/nucleo/convites" class="row ipform">
            <label>
              Entra como
              <select name="role">
                <option value="membro">membro (só lança)</option>
                <option value="admin">administrador</option>
              </select>
            </label>
            <button class="btn small">Gerar código</button>
          </form>
          {invites.length ? (
            <ul class="reqs">
              {invites.map((i) => (
                <li>
                  <div class="txt">
                    <b>{ROLE_LABEL[i.role]}</b>
                    <small>
                      criado {when(i.created_at)} · vale até {when(i.expires_at)}
                    </small>
                  </div>
                  <div class="codebox">
                    <small>código</small>
                    <b>
                      {i.code.slice(0, 4)} {i.code.slice(4)}
                    </b>
                  </div>
                  <form method="post" action={`/nucleo/convites/${i.id}/revogar`} class="inline">
                    <button class="btn small ghost">Cancelar</button>
                  </form>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      {others.length ? (
        <section>
          <h2>Trocar de núcleo</h2>
          <ul class="devlist">
            {others.map((n) => (
              <li>
                <span class="txt">
                  <b>{n.name}</b>
                  <small>
                    {ROLE_LABEL[n.role]} · {n.members} pessoa(s)
                  </small>
                </span>
                <form method="post" action={`/nucleos/${n.id}/ativar`}>
                  <button class="btn small">Usar</button>
                </form>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <details class="card">
        <summary>Entrar em outro núcleo</summary>
        <JoinForm />
      </details>
      <details class="card">
        <summary>Criar outro núcleo</summary>
        <CreateForm />
      </details>

      <form method="post" action="/nucleo/sair" onsubmit={`return confirm(${JSON.stringify(`Sair de “${cur.name}”? Seus lançamentos ficam no núcleo.`)})`}>
        <button type="submit" class="btn danger" disabled={!canLeave}>
          Sair deste núcleo
        </button>
      </form>
      {!canLeave ? <p class="muted center">Você é o único administrador: torne outra pessoa administradora antes de sair.</p> : null}
    </Layout>,
  );
});

/** Admin actions on the current núcleo. */
async function adminNucleo(c: Context<AppEnv>) {
  const cur = await currentNucleo(c.env.DB, c.get("user").id);
  return cur && cur.role === "admin" ? cur : null;
}

nucleos.post("/nucleo/nome", async (c) => {
  const cur = await adminNucleo(c);
  if (!cur) return c.text("Só para administradores do núcleo", 403);
  const name = cleanName((await c.req.parseBody()).name);
  if (!name) return c.redirect(okTo("/nucleo", "Dê um nome ao núcleo"));
  await renameNucleo(c.env.DB, cur.id, name);
  return c.redirect(okTo("/nucleo", "Nome salvo"));
});

nucleos.post("/nucleo/convites", async (c) => {
  const cur = await adminNucleo(c);
  if (!cur) return c.text("Só para administradores do núcleo", 403);
  const role: NucleoRole = (await c.req.parseBody()).role === "admin" ? "admin" : "membro";
  await createInvite(c.env.DB, cur.id, c.get("user").id, role);
  return c.redirect(okTo("/nucleo", "Código gerado"));
});

nucleos.post("/nucleo/convites/:id/revogar", async (c) => {
  const cur = await adminNucleo(c);
  if (!cur) return c.text("Só para administradores do núcleo", 403);
  const id = parseId(c.req.param("id"));
  if (id === null) return c.notFound();
  await revokeInvite(c.env.DB, cur.id, id);
  return c.redirect(okTo("/nucleo", "Convite cancelado"));
});

nucleos.post("/nucleo/membros/:id/papel", async (c) => {
  const cur = await adminNucleo(c);
  if (!cur) return c.text("Só para administradores do núcleo", 403);
  const id = parseId(c.req.param("id"));
  if (id === null) return c.notFound();
  const role: NucleoRole = (await c.req.parseBody()).role === "admin" ? "admin" : "membro";
  const r = await setRole(c.env.DB, cur.id, id, role);
  if (r === "not_member") return c.notFound();
  return c.redirect(okTo("/nucleo", r === "last_admin" ? "O núcleo precisa de ao menos um administrador" : "Papel alterado"));
});

nucleos.post("/nucleo/membros/:id/remover", async (c) => {
  const cur = await adminNucleo(c);
  if (!cur) return c.text("Só para administradores do núcleo", 403);
  const id = parseId(c.req.param("id"));
  if (id === null) return c.notFound();
  if (id === c.get("user").id) return c.redirect(okTo("/nucleo", "Para sair, use “Sair deste núcleo”"));
  const r = await removeMember(c.env.DB, cur.id, id);
  if (r === "not_member") return c.notFound();
  return c.redirect(okTo("/nucleo", r === "last_admin" ? "O núcleo precisa de ao menos um administrador" : "Pessoa removida"));
});

nucleos.post("/nucleo/sair", async (c) => {
  const cur = await currentNucleo(c.env.DB, c.get("user").id);
  if (!cur) return c.redirect("/comecar");
  if (cur.role === "admin" && (await countAdmins(c.env.DB, cur.id)) <= 1) {
    return c.redirect(okTo("/nucleo", "Você é o único administrador: promova alguém antes de sair"));
  }
  await removeMember(c.env.DB, cur.id, c.get("user").id);
  return c.redirect(okTo("/mais", `Você saiu de “${cur.name}”`));
});
