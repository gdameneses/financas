# Finanças

Finance tracker for households ("núcleos"): pt-BR, BRL, mobile-first PWA, runs entirely on Cloudflare's
free tier (Workers + D1), gated by an admin-approved device list. Several núcleos share one deployment
and never see each other's data.

- Lançamentos de entrada/saída com categorias (presets deletáveis, crie as suas)
- Orçamento mensal por categoria com projeção
- Relatórios determinísticos (mensal, tendência 12 m, recorrentes, orçamento) em JSON e Markdown — para ler com o Claude Code
- Login + sessão de 90 dias, só em aparelhos liberados
- Núcleos: cada pessoa cria o seu ou entra no de alguém com um código de convite; uma pessoa pode estar em vários

```sh
npm install --legacy-peer-deps
npm run migrate:local && npm run dev
npm test
```

See `docs/SETUP.md` for deployment.
