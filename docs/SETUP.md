# Setup

Everything below stays on free tiers: Workers Free, D1 Free, Cloudflare Zero Trust Free. No card.

## 1. Local

```sh
npm install --legacy-peer-deps   # vitest 4's optional peer graph crashes npm's resolver; this flag skips it
npm run migrate:local
echo 'ENROLL_SECRET=choose-a-long-random-string' > .dev.vars
npm run dev                      # http://localhost:8787
```

First visit → `/enroll` → paste the `ENROLL_SECRET` as the code → `/login` creates the account on first run.

To test from the phone on the same Wi-Fi: `npm run dev:lan` and open `http://<laptop-ip>:8787`.
(Cookies are set without `Secure` over plain http, so this works; production is https-only.)

## 2. Cloudflare account (personal)

```sh
npx wrangler login
npx wrangler d1 create finance
```

Copy the printed `database_id` into `wrangler.jsonc`, then:

```sh
npm run migrate:remote
npx wrangler secret put ENROLL_SECRET      # long random string; only needed until the first device is enrolled
npx wrangler deploy
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

## 4. Enroll devices

- First device: open the URL → Access emails you a PIN → `/enroll` → paste `ENROLL_SECRET` → create account.
- Each further device: on an enrolled device go to **Mais → Dispositivos → Gerar código**, type the 8-char code on the new device within 10 minutes.
- Lost a device: revoke it from the same page; its session dies immediately.

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
