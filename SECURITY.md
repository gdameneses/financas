# Security

This app holds household financial data, so it's built to keep strangers out completely, not merely to
"require a login". This file covers what each layer does, what it protects against, and the limitations
we know about and have accepted.

## Reporting a vulnerability

Please use GitHub's **private vulnerability reporting** (Security tab → *Report a vulnerability*) instead
of a public issue. Include the request(s) that reproduce it. Please test only against a copy you deploy
yourself, never against someone else's deployment.

## Threat model

- **In scope:** an anonymous internet visitor; someone who knows an admin's e-mail address; a user who
  is approved in one núcleo trying to read or change another núcleo's data; a *membro* trying to do
  *administrador* things; brute force against passwords, access codes and invite codes.
- **Out of scope:** a compromised Cloudflare account, a compromised admin device, and malicious users
  inside your own núcleo. A núcleo shares one ledger on purpose, so any member can edit any entry in it.

## Layers, in request order

Each layer is a middleware in `src/middleware.ts`, mounted in `src/index.tsx`.

| # | Layer | Rejects |
|---|---|---|
| 0 | HTTPS + access log | plain http (301 to https, except localhost). Every request is logged with IP, country, user agent, device, user and outcome |
| 1 | Cloudflare Access (optional, `REQUIRE_ACCESS=1`) | requests without a `cf-access-jwt-assertion` header |
| 2 | Device + IP | anything that isn't an **approved device**. Unapproved devices can only reach `/acesso`, and only from an allowlisted IP |
| 3 | Session | no valid session bound to *this* device, or a banned user |
| 4 | Núcleo | users with no núcleo (sent to `/comecar`) |
| 5 | Roles | *membro* on admin pages; non-app-admins on device, IP, user and log pages |

**Device approval.** A device is identified by a 256-bit random token in an `HttpOnly; Secure;
SameSite=Lax` cookie, and only its SHA-256 hash is stored. A new device asks for access and gets an
8-digit code, which an app admin reads in the app (or by e-mail) and hands over. The code lasts 30
minutes, five wrong guesses lock it, and each IP gets 3 requests per hour plus a global hourly cap. Codes
come from `crypto.getRandomValues`, and the attempt counter is incremented *before* the comparison, so
parallel guesses can't race past the limit.

**Bootstrap.** A device is approved without a code only when the database has zero approved devices
*and* zero users, and the e-mail is in `ADMIN_EMAILS`. Revoking every device later doesn't reopen
bootstrap.

**Admin e-mails.** `ADMIN_EMAILS` is a secret, never in the repo. An address on that list can register
only through bootstrap or an explicit admin approval with a confirmation tick. Redeeming a code never
grants it.

**Passwords.** PBKDF2-SHA256 with a per-user salt. Failed attempts are counted per e-mail, shared
between login and password change, and never reset by someone else's successful login. Changing a
password ends the user's other sessions.

**Sessions.** 256-bit tokens, stored hashed, bound to the device row, with a 90-day sliding expiry.
Revoking a device deletes its sessions, and banning a user deletes theirs and revokes their devices.

**Tenant isolation.** Every query in `src/db.ts` takes the núcleo id as its second argument, so leaving
it out fails to compile. Reads filter on it and writes are `WHERE id = ? AND nucleo_id = ?`. Another
núcleo's ids return **404, not 403**, so probing can't confirm a row exists. The `nucleo_id` columns are
nullable on purpose: a row inserted without a núcleo is invisible to everyone instead of landing in
núcleo 1. `test/nucleos.test.ts` covers pages, direct ids, planning caps, export, reports and alert
dismissal across two núcleos.

**Invite codes.** 8 digits, valid for 7 days, single use, revocable, with a fixed role. They are
rate-limited per IP bucket (10/hour) and globally (50/hour). An invite code does **not** approve a
device: whoever runs the deployment stays in charge of who reaches the app at all.

**Client IP.** Only `cf-connecting-ip` is trusted, because Cloudflare's edge always sets it.
`x-forwarded-for` is ignored. Rate-limit buckets group IPv6 addresses by /64.

## Known limitations (accepted)

- **PBKDF2 uses 25,000 iterations**, not OWASP's 600,000. Workers Free allows 10 ms of CPU per request,
  and the device gate carries most of the weight. On Workers Paid, raise `PBKDF2_ITERATIONS` in
  `src/auth/crypto.ts`.
- **Layer 1 only checks that the Access header exists**; it doesn't verify the JWT. That's safe only
  when the hostname is reachable *exclusively* through Cloudflare Access. Layers 2 and 3 still apply
  either way.
- **No CSRF tokens.** The app relies on `SameSite=Lax` cookies and on every user action that changes data being a POST form. (Loading
  the dashboard does write: it records alerts idempotently. It also refreshes the device's last-seen date.)
- **No Content-Security-Policy** yet.
- **Approved devices pass from any network.** When an approved device shows up from a new IP, that IP
  is added to the allowlist (logged as `ip_auto`) rather than blocked. Device approval is the real gate,
  and the IP list mostly records where devices connect from.
- **Access and invite codes are stored in clear text.** Admins have to read them in the app. They are
  short-lived, and only admins can reach those tables through the app.

## Operator checklist

- Set `ADMIN_EMAILS` with `wrangler secret put` (or `--secrets-file` on deploy). Never put it in `vars`.
- Keep `LIBERADO` at `"false"` in production.
- Put Cloudflare Access in front of the hostname and then set `REQUIRE_ACCESS` to `"1"`.
- Check *Mais → Acessos → Registro* now and then for `ip_denied` / `device_unknown` bursts.
