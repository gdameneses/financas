# Setup

Everything below stays on free tiers: Workers Free, D1 Free, Cloudflare Zero Trust Free. No card.

## 1. Local

```sh
npm install --legacy-peer-deps   # vitest 4's optional peer graph crashes npm's resolver; this flag skips it
npm run migrate:local
echo 'ENROLL_SECRET=choose-a-long-random-string' > .dev.vars
npm run dev                      # http://localhost:8787
```

First visit → `/acesso` → enter an e-mail that is in `ADMIN_EMAILS` + a device name. While no device has
ever been approved, that request is approved on the spot (and its IP goes on the allowlist); then `/login`
creates the account. Every later device goes through the code flow (below).

To switch the IP + device gates off entirely (every browser is approved on first visit, login still
required), set `LIBERADO=true` in `.dev.vars`. Never in production.

To test from the phone on the same Wi-Fi: `npm run dev:lan` and open `http://<laptop-ip>:8787`.
(Cookies are set without `Secure` over plain http, so this works; production is https-only.)

## 2. Cloudflare account (personal)

The personal login lives in its own wrangler config dir so it never clashes with the Urlbox login on
the same machine. Prefix every wrangler command with it (or `export` it in the shell):

```sh
export XDG_CONFIG_HOME=$HOME/.config/cf-personal
npx wrangler login
npx wrangler d1 create finance
```

A brand-new account has no `workers.dev` subdomain yet; the first deploy prints a dashboard link
instead of a URL. Register one (dashboard → Workers & Pages, or
`PUT /accounts/<id>/workers/subdomain {"subdomain":"<name>"}`) and deploy again.

Copy the printed `database_id` into `wrangler.jsonc`, then:

```sh
npm run migrate:remote
npx wrangler deploy
```

Optional, to e-mail access codes to the admins (otherwise they are only shown in the app):
create a free Brevo account, verify a sender address (a Gmail works), create an API key, then

```sh
npx wrangler secret put BREVO_API_KEY
npx wrangler secret put EMAIL_FROM          # the verified sender address
```

Note the URL: `https://finance.<your-subdomain>.workers.dev`.

Then set `REQUIRE_ACCESS` to `"1"` in `wrangler.jsonc` **after** step 3 is done, and deploy again.
(With `REQUIRE_ACCESS=1` the Worker refuses any request that didn't come through Access.)

## 3. Cloudflare Access (the edge gate)

Zero Trust dashboard → **Access → Applications → Add an application → Self-hosted**:

- Application domain: `finance.<your-subdomain>.workers.dev`
- Session duration: 1 month (Access re-prompts for the email PIN after this; the app's own session is separate)
- Identity provider: **One-time PIN** only (Settings → Authentication, remove others)
- Policy: *Allow* · Include → **Emails** → your email only

Any other visitor now gets Cloudflare's login page and never reaches the Worker.

## 4. Devices, IPs and users

- Unknown IP or device → `/acesso` → the person enters e-mail + device name → an 8-digit code is created,
  shown to admins in **Mais → Acessos → Pedidos** and e-mailed (if Brevo is set up). The admin passes the
  code on; the person types it within 30 minutes → device approved, its IP allowed → `/login` creates the
  account for that e-mail.
- Admins can also approve/deny directly from *Pedidos*, revoke devices (*Aparelhos*), block/unblock users
  (*Usuários*), manage IPs and ranges (*IPs*, with "seu IP agora" pre-filled) and read every request in
  *Registro*.
- The IP list is mandatory: once it has one entry, any request from an unlisted IP is refused (logged as
  `ip_denied`) and must go through the code flow again. Phones on mobile data change IP often.

Add to home screen (Safari share → "Adicionar à Tela de Início"; Chrome → "Instalar app") for the PWA.

## 5. Reading reports with Claude Code

Every report is available as JSON and Markdown (Relatórios → ⬇ links), and `Mais → Exportar tudo` dumps
the whole database. Download the file and point Claude Code at it; the data is small enough to paste.

## Free-tier numbers that matter

| Limit | Free | This app |
|---|---|---|
| Workers requests | 100k/day | a few hundred |
| Workers CPU | 10 ms/request | login ≈ 3–5 ms (PBKDF2 25k iters), pages < 2 ms |
| D1 writes | 100k rows/day | tens |
| D1 storage | 5 GB | KB |
| Zero Trust users | 50 | 1 |
