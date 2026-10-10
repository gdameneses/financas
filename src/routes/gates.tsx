import { Hono } from "hono";
import type { AppEnv, Device } from "../env";
import { Layout } from "../pages/layout";
import { redeemAccessCode, requestAccess } from "../auth/device";
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
import { adminEmails } from "../lib/email";

export const gates = new Hono<AppEnv>();

type Reason = "ip_denied" | "device_unknown" | "device_pending" | "device_denied" | string;

const RequestForm = ({ device, error }: { device: Device | null; error?: string }) => {
  const approved = device?.status === "approved";
  return (
    <form method="post" action="/acesso" class="stack">
      <input type="hidden" name="op" value="request" />
      {error ? <p class="err">{error}</p> : null}
      <label>
        Seu e-mail
        <input name="email" type="email" autocomplete="email" required value={device?.requested_email ?? ""} readonly={approved} />
      </label>
      <label>
        Nome deste aparelho
        <input name="name" placeholder="celular da Ana" required maxlength={40} value={device?.name ?? ""} readonly={approved} />
      </label>
      <button type="submit" class="btn primary">
        {approved ? "Pedir liberação desta rede" : "Pedir acesso"}
      </button>
    </form>
  );
};

const CodeForm = ({ error }: { error?: string }) => (
  <form method="post" action="/acesso" class="stack">
    <input type="hidden" name="op" value="code" />
    {error ? <p class="err">{error}</p> : null}
    <label>
      Código de 8 dígitos
      <input name="code" inputmode="numeric" pattern="[0-9 ]*" autocomplete="one-time-code" maxlength={9} required autofocus class="code" />
    </label>
    <button type="submit" class="btn primary">
      Entrar com o código
    </button>
  </form>
);

const AccessPage = ({ reason, device, ip, error, step }: { reason: Reason; device: Device | null; ip: string; error?: string; step: "request" | "code" }) => {
  const title = reason === "ip_denied" ? "Rede não autorizada" : reason === "device_pending" ? "Aguardando liberação" : "Aparelho não autorizado";
  return (
    <Layout title={title} bare>
      <div class="gate">
        <h1>{title}</h1>
        {step === "code" ? (
          <>
            <p class="muted">Um código foi enviado aos administradores. Peça a eles e digite aqui em até 30 minutos.</p>
            <CodeForm error={error} />
            <details>
              <summary>Pedir de novo</summary>
              <RequestForm device={device} />
            </details>
          </>
        ) : (
          <>
            <p class="muted">
              {reason === "ip_denied" ? `Este endereço (${ip}) não está na lista permitida.` : "Este aparelho ainda não foi liberado."} Peça acesso: um
              administrador recebe um código e passa para você.
            </p>
            <RequestForm device={device} error={error} />
            {reason === "device_denied" ? <p class="muted">Este aparelho foi negado ou revogado. Um novo pedido precisa ser aprovado de novo.</p> : null}
          </>
        )}
      </div>
    </Layout>
  );
};

async function hasLiveCode(db: D1Database, deviceId: number): Promise<boolean> {
  const r = await db
    .prepare("SELECT COUNT(*) AS n FROM access_codes WHERE device_id = ? AND used_at IS NULL AND expires_at > datetime('now') AND attempts < 5")
    .bind(deviceId)
    .first<{ n: number }>();
  return (r?.n ?? 0) > 0;
}

const canRedeem = (d: Device | null) => !!d && (d.status === "pending" || d.status === "approved");

gates.get("/acesso", async (c) => {
  const device = c.get("device") ?? null;
  const reason = c.get("outcome") ?? "device_unknown";
  const step = canRedeem(device) && (await hasLiveCode(c.env.DB, device!.id)) ? "code" : "request";
  return c.html(<AccessPage reason={reason} device={device} ip={c.get("ip")} step={step} />);
});

gates.post("/acesso", async (c) => {
  const device = c.get("device") ?? null;
  const reason = c.get("outcome") ?? "device_unknown";
  const form = await c.req.parseBody();
  const ip = c.get("ip");

  if (form.op === "code") {
    if (!device) return c.redirect("/acesso");
    const result = await redeemAccessCode(c.env.DB, device, String(form.code ?? ""));
    if (result === "ok") return c.redirect("/login");
    const msg = result === "wrong" ? "Código incorreto." : result === "locked" ? "Muitas tentativas: peça um código novo." : "Código expirado: peça um código novo.";
    return c.html(<AccessPage reason={reason} device={device} ip={ip} step={result === "wrong" ? "code" : "request"} error={msg} />, 400);
  }

  // An approved device asking for a new network keeps its own e-mail and name.
  const email = device?.status === "approved" ? device.requested_email : String(form.email ?? "").trim().toLowerCase();
  const name = device?.status === "approved" ? device.name : String(form.name ?? "").trim().slice(0, 40);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !name) {
    return c.html(<AccessPage reason={reason} device={device} ip={ip} step="request" error="Informe um e-mail válido e um nome." />, 400);
  }
  const r = await requestAccess(c, device, email, name, ip);
  if (r.kind === "approved") return c.redirect("/login");
  if (r.kind === "rate_limited") {
    return c.html(<AccessPage reason={reason} device={device} ip={ip} step="request" error="Limite de pedidos atingido. Tente em uma hora." />, 429);
  }
  return c.html(<AccessPage reason={r.device.status === "approved" ? reason : "device_pending"} device={r.device} ip={ip} step="code" />);
});

const LoginPage = ({ error, register, email }: { error?: string; register: boolean; email: string }) => (
  <Layout title={register ? "Criar conta" : "Entrar"} bare>
    <div class="gate">
      <h1>{register ? "Criar sua conta" : "Entrar"}</h1>
      {register ? <p class="muted">Este aparelho foi liberado para {email}. Defina a senha que você usará daqui em diante.</p> : null}
      {error ? <p class="err">{error}</p> : null}
      <form method="post" action="/login" class="stack">
        <label>
          E-mail
          <input name="email" type="email" autocomplete="username" required value={email} readonly={register} />
        </label>
        <label>
          Senha
          <input name="password" type="password" autocomplete={register ? "new-password" : "current-password"} required minlength={8} />
        </label>
        <button type="submit" class="btn primary">
          {register ? "Criar conta" : "Entrar"}
        </button>
      </form>
    </div>
  </Layout>
);

async function userByEmail(db: D1Database, email: string) {
  return db
    .prepare("SELECT id, password_hash, salt, iterations, banned_at FROM users WHERE email = ?")
    .bind(email)
    .first<{ id: number; password_hash: string; salt: string; iterations: number; banned_at: string | null }>();
}

/**
 * Who may create an account on this device: only the e-mail it was approved for. For an ADMIN
 * e-mail, additionally only when the device was approved by bootstrap (empty system) or by an
 * admin's explicit click, never through a code typed by the requester, so a stranger cannot
 * claim an admin address that has no account yet.
 */
async function registrationEmail(c: { env: AppEnv["Bindings"] }, db: D1Database, device: Device): Promise<string | null> {
  const email = device.requested_email;
  if (!email || (await userByEmail(db, email))) return null;
  if (adminEmails(c.env).includes(email) && device.approved_by === null) {
    const users = await db.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
    if ((users?.n ?? 0) > 0) return null;
  }
  return email;
}

gates.get("/login", async (c) => {
  const device = c.get("device");
  const s = await findSession(c, sessionTokenFromRequest(c), device.id);
  if (s && !s.banned) return c.redirect("/");
  const reg = await registrationEmail(c, c.env.DB, device);
  return c.html(<LoginPage register={reg !== null} email={reg ?? device.requested_email} />);
});

gates.post("/login", async (c) => {
  const device = c.get("device");
  const db = c.env.DB;
  const form = await c.req.parseBody();
  const password = String(form.password ?? "");
  const email = String(form.email ?? "").trim().toLowerCase();
  const existing = await userByEmail(db, email);

  if (!existing) {
    const reg = await registrationEmail(c, db, device);
    if (!reg || email !== reg) return c.html(<LoginPage register={false} email={email} error="E-mail ou senha incorretos." />, 401);
    if (password.length < 8) return c.html(<LoginPage register email={email} error="Senha com ao menos 8 caracteres." />, 400);
    const h = await hashPassword(password);
    const r = await db
      .prepare("INSERT INTO users (email, password_hash, salt, iterations) VALUES (?, ?, ?, ?)")
      .bind(email, h.hash, h.salt, h.iterations)
      .run();
    await createSession(c, Number(r.meta.last_row_id), device.id);
    return c.redirect("/");
  }

  if (await loginRateLimited(db, email)) {
    return c.html(<LoginPage register={false} email={email} error="Muitas tentativas. Aguarde 15 minutos." />, 429);
  }
  const ok = await verifyPassword(password, { hash: existing.password_hash, salt: existing.salt, iterations: existing.iterations });
  if (!ok) {
    await recordLoginAttempt(db, email);
    return c.html(<LoginPage register={false} email={email} error="E-mail ou senha incorretos." />, 401);
  }
  if (existing.banned_at) {
    c.set("outcome", "banned");
    return c.html(<LoginPage register={false} email={email} error="Esta conta foi bloqueada." />, 403);
  }
  await clearLoginAttempts(db, email);
  await createSession(c, existing.id, device.id);
  return c.redirect("/");
});

gates.post("/logout", async (c) => {
  const device = c.get("device");
  const s = await findSession(c, sessionTokenFromRequest(c), device.id);
  if (s) await destroySession(c, s.sessionId);
  return c.redirect("/login");
});
