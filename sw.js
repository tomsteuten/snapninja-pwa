// Service worker — network-first for the app shell so GitHub Pages updates
// are picked up on the next open. Falls back to cache when offline.
const CACHE = "snapninja-v2";
const SHELL = ["./", "./index.html", "./app.js", "./manifest.webmanifest"];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (url.hostname.indexOf("script.google") !== -1) return; // never touch API calls
  if (e.request.method !== "GET") return;

  // Network-first: try the network, update cache on success, fall back to cache offline
  e.respondWith(
    fetch(e.request)
      .then(resp => {
        const copy = resp.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return resp;
      })
      .catch(() => caches.match(e.request))
  );
});
