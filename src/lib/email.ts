// Transactional e-mail to admins via Brevo (free tier, no domain needed: the sender is a
// verified address). When BREVO_API_KEY is unset nothing is sent; the code still shows in-app.
import type { Bindings } from "../env";

export function adminEmails(env: Bindings): string[] {
  return (env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export async function emailAdmins(env: Bindings, subject: string, text: string): Promise<boolean> {
  if (!env.BREVO_API_KEY || !env.EMAIL_FROM) return false;
  const to = adminEmails(env).map((email) => ({ email }));
  if (!to.length) return false;
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": env.BREVO_API_KEY, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ sender: { email: env.EMAIL_FROM, name: "Finanças" }, to, subject, textContent: text }),
  });
  if (!res.ok) console.error("brevo", res.status, await res.text());
  return res.ok;
}
