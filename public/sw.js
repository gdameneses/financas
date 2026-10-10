// Service worker: makes the app installable and shows offline.html without network.
// Static files are NETWORK-FIRST (cache only as an offline fallback), so a deploy is never
// paired with a stale app.js/app.css on the next load. App pages are never cached (auth state).
const VERSION = "v9";
const SHELL = ["/app.css", "/app.js", "/vendor/chart.umd.min.js", "/manifest.webmanifest", "/icons/icon.svg", "/offline.html"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  if (SHELL.includes(url.pathname) || url.pathname.startsWith("/icons/") || url.pathname.startsWith("/vendor/")) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request)),
    );
    return;
  }
  if (e.request.mode === "navigate") {
    e.respondWith(fetch(e.request).catch(() => caches.match("/offline.html")));
  }
});
