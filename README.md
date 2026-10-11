# Finanças

A small, self-hosted household finance tracker. Brazilian Portuguese UI, amounts in BRL, installable on a
phone as a PWA. It runs entirely on Cloudflare's free tier (Workers + D1) with no credit card, no paid API
keys and no LLM inside the app.

Several households ("núcleos") can share one deployment without ever seeing each other's data. Getting in
takes two steps: an admin approves your device, then you log in with a password.

*Controle financeiro para casas e famílias: lançamentos rápidos pelo celular, planejamento mensal por
categoria com avisos de ritmo, e relatórios em JSON/Markdown para ler com o assistente que você quiser.*

## Features

- **Quick add.** Type the payee, then the amount, then pick a category, all from the keyboard. Each entry
  shows who added it.
- **Categories.** 18 presets (Moradia, Mercado, Transporte, …) that you can delete, plus any you create.
  Deleting a category moves its entries to "Sem categoria"; it never deletes money.
- **Planejamento.** A monthly cap per category and a "real × planejado" chart with a tick for where you
  should be today. Alerts fire on pace, at 80 % and at 100 %, and each category type (continuous, fixed,
  bursty) gets its own rules.
- **Dashboard.** Month balance, active alerts, the last 7 days, and a breakdown by category.
- **Deterministic reports.** Monthly summary, 12-month trend, recurring-payment detection and budget
  status, each as JSON and Markdown. They're meant to be downloaded and read by you or an AI assistant
  outside the app.
- **Núcleos (tenants).** Create your own or join one with an 8-digit invite code. Roles are
  *administrador* and *membro*, and one person can belong to several.
- **Access control.** Device approval with 8-digit codes, an IP allowlist for unapproved devices,
  device-bound 90-day sessions, bans, and a log of every request. See [SECURITY.md](SECURITY.md).

## Stack

[Hono](https://hono.dev) with server-rendered `hono/jsx` pages, plain JS for interactivity, Cloudflare
D1 (SQLite) through raw prepared statements, a self-hosted [Chart.js](https://www.chartjs.org), and
[Phosphor](https://phosphoricons.com) icons inlined as an SVG sprite. There is no frontend bundler and no
ORM. Tests use `@cloudflare/vitest-plugin`, which runs them inside the real Workers runtime.

## Quick start (local)

```sh
npm install --legacy-peer-deps      # npm's peer resolver crashes on vitest 4's optional peers without it
cp .dev.vars.example .dev.vars      # put your own e-mail in ADMIN_EMAILS
npm run migrate:local
npm run dev                         # http://localhost:8787
```

Open the app and request access with the e-mail you put in `ADMIN_EMAILS`. On an empty database, that
first request is approved on the spot. Next, `/login` creates your account and `/comecar` sets up your
first núcleo.

```sh
npm test            # 40 tests across auth, núcleo isolation, alerts, reports and IP handling
npm run typecheck
```

## Deploying your own copy

See [docs/SETUP.md](docs/SETUP.md). In short: create a D1 database, put its id in `wrangler.jsonc`, run
the migrations remotely, set `ADMIN_EMAILS` as a secret, and deploy. Cloudflare Access in front of the
Worker is optional but recommended.

## Documentation

- [docs/SETUP.md](docs/SETUP.md): local dev, deployment, Cloudflare Access, devices and núcleos
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): request pipeline, data model, key design choices
- [SECURITY.md](SECURITY.md): threat model, what each layer protects, known limitations, how to report

## Project layout

```
src/index.tsx        app wiring: middleware order and route mounting
src/middleware.ts    the gate layers (https, Access, IP + device, session, núcleo, roles)
src/auth/            device tokens, sessions, password hashing
src/db.ts            every D1 query; each one takes the núcleo id right after the db
src/routes/          pages and the /api (reports, export)
src/reports/         deterministic report builders
src/alerts.ts        budget alert rules
migrations/          D1 schema, applied in order
public/              static assets, service worker, vendored Chart.js
test/                vitest suites running in workerd
```

## License

[MIT](LICENSE). Third-party notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
