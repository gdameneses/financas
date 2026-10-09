# Finanças

Personal finance tracker: pt-BR, BRL, mobile-first PWA, runs entirely on Cloudflare's free tier
(Workers + D1), gated by Cloudflare Access plus an enrolled-device list.

- Lançamentos de entrada/saída com categorias (presets deletáveis, crie as suas)
- Orçamento mensal por categoria com projeção
- Relatórios determinísticos (mensal, tendência 12 m, recorrentes, orçamento) em JSON e Markdown — para ler com o Claude Code
- Login + sessão de 90 dias, só em aparelhos liberados

```sh
npm install --legacy-peer-deps
npm run migrate:local && npm run dev
npm test
```

See `docs/SETUP.md` for deployment.
