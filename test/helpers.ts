import { env } from "cloudflare:test";
import app from "../src/index";
import { createNucleo } from "../src/nucleos";

/**
 * Deterministic clean slate: wipe every mutable table so tests don't depend on the plugin's
 * storage isolation. Categories are per núcleo now, so nothing is re-seeded here: use `fixture()`
 * or `createNucleo()` (which seeds the presets for that núcleo).
 */
export async function resetDb(): Promise<void> {
  await env.DB.batch([
    // Children before parents: several tables reference users, devices and núcleos.
    env.DB.prepare("DELETE FROM alerts"),
    env.DB.prepare("DELETE FROM access_log"),
    env.DB.prepare("DELETE FROM access_codes"),
    env.DB.prepare("DELETE FROM login_attempts"),
    env.DB.prepare("DELETE FROM invite_attempts"),
    env.DB.prepare("DELETE FROM nucleo_invites"),
    env.DB.prepare("DELETE FROM nucleo_members"),
    env.DB.prepare("DELETE FROM sessions"),
    env.DB.prepare("DELETE FROM allowed_ips"),
    env.DB.prepare("DELETE FROM budgets"),
    env.DB.prepare("DELETE FROM transactions"),
    env.DB.prepare("DELETE FROM categories"),
    env.DB.prepare("DELETE FROM devices"),
    env.DB.prepare("UPDATE users SET current_nucleo_id = NULL"),
    env.DB.prepare("DELETE FROM nucleos"),
    env.DB.prepare("DELETE FROM users"),
  ]);
}

/** A user who administers a freshly seeded núcleo (for unit tests that bypass HTTP). */
export async function fixture(email = "u@example.com", name = "Casa"): Promise<{ uid: number; nid: number }> {
  const r = await env.DB.prepare("INSERT INTO users (email, password_hash, salt, iterations) VALUES (?, 'x', 'y', 1)").bind(email).run();
  const uid = Number(r.meta.last_row_id);
  const nid = await createNucleo(env.DB, uid, name);
  return { uid, nid };
}

export async function categoryId(nid: number, name: string): Promise<number> {
  return (await env.DB.prepare("SELECT id FROM categories WHERE nucleo_id = ? AND name = ?").bind(nid, name).first<{ id: number }>())!.id;
}

export const ORIGIN = "https://finance.test";

// Cookie jar + fixed client IP: behaves like one browser on one network.
export class Browser {
  cookies = new Map<string, string>();
  constructor(public ip: string) {}
  async fetch(path: string, init: RequestInit = {}, extraEnv: Partial<typeof env> = {}) {
    const headers = new Headers(init.headers);
    headers.set("cf-connecting-ip", this.ip);
    headers.set("user-agent", "test/1.0");
    if (this.cookies.size) headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await app.request(ORIGIN + path, { ...init, headers, redirect: "manual" }, { ...env, ...extraEnv });
    for (const sc of res.headers.getSetCookie()) {
      const [pair, ...attrs] = sc.split(";");
      const [k, v] = pair.split("=");
      if (attrs.some((a) => /max-age=0/i.test(a))) this.cookies.delete(k.trim());
      else this.cookies.set(k.trim(), v);
    }
    return res;
  }
  form(path: string, data: Record<string, string>, extraEnv: Partial<typeof env> = {}) {
    return this.fetch(
      path,
      { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(data).toString() },
      extraEnv,
    );
  }
}

/** Latest live invite code for a núcleo (what the admin reads on the Núcleo page). */
export async function latestInvite(nid: number): Promise<string> {
  const row = await env.DB.prepare("SELECT code FROM nucleo_invites WHERE nucleo_id = ? AND used_at IS NULL ORDER BY id DESC LIMIT 1").bind(nid).first<{ code: string }>();
  return row!.code;
}

export async function nucleoIdByName(name: string): Promise<number> {
  return (await env.DB.prepare("SELECT id FROM nucleos WHERE name = ?").bind(name).first<{ id: number }>())!.id;
}
