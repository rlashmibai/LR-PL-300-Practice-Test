// Minimal service worker: caches the app shell so the site is installable
// and works offline for a repeat visitor. Bump CACHE_NAME when app files change
// to force clients to pick up the new version.
const CACHE_NAME = "pl300-shell-v35";
const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./questions.json",
  "./manifest.json",
  "./get-certified-banner.webp",
  "./PL300-Data-Analyst-badge.webp",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      // cache.addAll() respects the browser's normal HTTP cache by default, which
      // can silently re-cache a stale response into the SW cache. {cache: "reload"}
      // forces each app-shell file to be fetched fresh from the network on install.
      .then((cache) =>
        Promise.all(APP_SHELL.map((url) => fetch(url, { cache: "reload" }).then((res) => cache.put(url, res))))
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network-first for questions.json (so new questions show up promptly),
// cache-first for everything else in the app shell.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return;

  if (url.pathname.endsWith("questions.json")) {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
