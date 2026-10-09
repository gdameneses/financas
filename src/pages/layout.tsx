import type { Child } from "hono/jsx";
import { html } from "hono/html";

type Props = {
  title: string;
  children: Child;
  /** Hide nav + FAB on gate pages (enroll/login). */
  bare?: boolean;
  active?: "home" | "tx" | "rel" | "mais";
  toast?: string;
};

export const Layout = ({ title, children, bare, active, toast }: Props) => (
  <html lang="pt-BR">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      <meta name="theme-color" content="#17181b" />
      <meta name="apple-mobile-web-app-capable" content="yes" />
      <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
      <title>{title} · Finanças</title>
      <link rel="manifest" href="/manifest.webmanifest" />
      <link rel="icon" href="/icons/icon.svg" type="image/svg+xml" />
      <link rel="apple-touch-icon" href="/icons/icon-192.png" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600&display=swap" />
      <link rel="stylesheet" href="/app.css" />
    </head>
    <body>
      {toast ? <div class="toast" id="toast">{toast}</div> : null}
      <main class={bare ? "bare" : ""}>{children}</main>
      {bare ? null : (
        <>
          <a class="fab" href="/nova" aria-label="Nova transação">
            +
          </a>
          <nav class="tabs">
            <a href="/" class={active === "home" ? "on" : ""}>
              Início
            </a>
            <a href="/transacoes" class={active === "tx" ? "on" : ""}>
              Lançamentos
            </a>
            <a href="/relatorios" class={active === "rel" ? "on" : ""}>
              Relatórios
            </a>
            <a href="/mais" class={active === "mais" ? "on" : ""}>
              Mais
            </a>
          </nav>
        </>
      )}
      <script src="/app.js" defer></script>
      {html`<script>
        if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js");
      </script>`}
    </body>
  </html>
);
