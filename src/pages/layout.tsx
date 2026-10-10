import type { Child } from "hono/jsx";
import { html, raw } from "hono/html";
import { SPRITE } from "../sprite";
import { Icon } from "./bits";

type Props = {
  title: string;
  children: Child;
  /** Hide nav + add button on gate pages and full-screen forms. */
  bare?: boolean;
  active?: "home" | "tx" | "plan" | "mais";
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
      {html`<script>
        // Slide direction for the page transition + "just saved" flag, decided before first paint.
        (function () {
          try {
            var TABS = ["/", "/transacoes", "/planejamento", "/mais"];
            var from = sessionStorage.getItem("fromTab"), here = TABS.indexOf(location.pathname), dir = "forward";
            if (from !== null && here >= 0 && Number(from) >= 0) dir = here > Number(from) ? "forward" : here < Number(from) ? "back" : "same";
            document.documentElement.dataset.dir = dir;
            sessionStorage.setItem("fromTab", String(here));
            if (location.search.indexOf("ok=") >= 0) document.documentElement.classList.add("just-saved");
          } catch (e) {}
        })();
      </script>`}
    </head>
    <body>
      {raw(SPRITE)}
      {toast ? <div class="toast" id="toast">{toast}</div> : null}
      <main class={bare ? "bare" : ""}>{children}</main>
      {bare ? null : (
        <>
          <a class="fab" href="/nova" aria-label="Novo lançamento">
            <Icon name="plus" />
          </a>
          <nav class="tabs">
            <a href="/" class={active === "home" ? "on" : ""}>
              Início
            </a>
            <a href="/transacoes" class={active === "tx" ? "on" : ""}>
              Lançamentos
            </a>
            <a href="/planejamento" class={active === "plan" ? "on" : ""}>
              Planejamento
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
      {bare
        ? null
        : html`<script type="speculationrules">
        {"prerender":[{"urls":["/","/transacoes","/planejamento","/mais","/nova"],"eagerness":"moderate"}]}
      </script>`}
    </body>
  </html>
);
