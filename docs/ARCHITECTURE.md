# Architecture

One Cloudflare Worker serves server-rendered HTML and a small JSON/Markdown API, backed by one D1
(SQLite) database. Static files (CSS, the enhancement JS, the service worker, icons, Chart.js) are served
by Workers Static Assets.

```
browser (PWA) ──https──▶ [Cloudflare Access, optional] ──▶ Worker (Hono)
                                                          ├─ middleware gates (src/middleware.ts)
                                                          ├─ pages: hono/jsx, server-rendered
                                                          ├─ /api: reports + export
                                                          └─ D1 via prepared statements (src/db.ts)
```

## Request pipeline

`src/index.tsx` defines the order, and the order is the security model:

1. `accessLog`: HTTPS redirect, serves static assets, resolves the client IP, and writes one
   `access_log` row after the response (through `waitUntil`).
2. `requireAccess`: Cloudflare Access header check when `REQUIRE_ACCESS=1`.
3. `requireIpAndDevice`: approved device, or an allowlisted IP for the `/acesso` request flow.
4. Gate pages (`/acesso`, `/login`) are mounted here, before a session is needed.
5. `requireSession`: device-bound session. Pages that don't need a núcleo (Mais, password, núcleos,
   access admin) are mounted next.
6. `requireNucleo`, then the ledger pages. `/api/*` also requires `requireNucleoAdmin`.

[SECURITY.md](../SECURITY.md) explains what each layer rejects.

## Data model

All amounts are **integer centavos** with an explicit `kind` (`in` / `out`). Amounts are never signed.

| Table | Purpose |
|---|---|
| `nucleos`, `nucleo_members`, `nucleo_invites`, `invite_attempts` | tenants, membership with role, invite codes and their rate limit |
| `categories` | per núcleo; `is_preset` only drives a badge; `pace` (`continuo`/`fixo`/`livre`) drives alert rules |
| `transactions` | per núcleo; `user_id` records who added each entry; a deleted category leaves `category_id` NULL |
| `budgets` | monthly cap per category |
| `alerts` | one row per category, month and level, storing the numbers at the moment it fired, plus a note and a dismissal |
| `users`, `sessions`, `login_attempts` | accounts, device-bound sessions, per-e-mail throttling |
| `devices`, `access_codes`, `allowed_ips`, `access_log` | the device gate, its codes, the IP list, the request log |

Migrations in `migrations/` run in order. `0005_nucleos.sql` turned the single-household app into a
multi-tenant one by moving all existing data into núcleo 1.

## Design choices worth knowing

- **Dates use America/São_Paulo**, not UTC, so an entry made late at night lands on the right day and
  month.
- **Budget projection** = spent ÷ days elapsed × days in the month.
- **Alert rules** depend on the category's `pace`. A *continuo* category alerts on pace (spent % ≥
  elapsed % + 15 points, and at least 25 % spent), at 80 % and at 100 %. A *fixo* category alerts only
  when it goes over the cap, since paying exactly the rent is the plan working. A *livre* category alerts
  at 80 % and 100 % only. `syncAlerts` is idempotent and runs on each dashboard load. A higher level
  dismisses lower ones, and levels never go back down.
- **Recurring detection** looks for the same normalised payee, an amount within ±5 %, at least 3
  occurrences, and a median gap of 28–33 days.
- **Reports are deterministic** (`src/reports/`). The app contains no model; the JSON/Markdown output
  exists to be read elsewhere.
- **The service worker caches only the static shell.** Pages carry auth state and are never cached, and
  static files are fetched network-first so a deploy never pairs old JS with new HTML.
- **Smart Placement** is on: D1 lives in one region, so running the Worker next to it turns a page's
  several queries into a single round trip from the user.
- **Free-tier fit:** Workers Free allows 10 ms of CPU per request. A login takes ≈3–5 ms (PBKDF2) and
  pages take under 2 ms.

## Tests

`npm test` runs vitest inside workerd against a local D1 (each test resets the tables itself rather than
trusting per-test storage isolation). The
suites cover the full access flow end to end through a cookie-jar `Browser` helper (`test/helpers.ts`),
isolation between núcleos, alert rules, report builders and IP/CIDR parsing.
