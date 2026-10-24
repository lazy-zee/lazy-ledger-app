// Lazy Ledger service worker: makes the app installable and lets it open without a connection.
const CACHE = "lazy-ledger-v2"; // bump when icons or other fixed files change, so phones drop the old copies

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  const isStatic = req.url.includes("/_next/static/") || req.url.includes("/icons/");
  if (isStatic) {
    // Built files never change name, so the saved copy is always right.
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      })),
    );
    return;
  }
  // Pages: always ask for the newest copy (the host may hold an old one for a few minutes),
  // fall back to the saved copy when offline.
  event.respondWith(
    fetch(req, { cache: "no-cache" })
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match("/lazy-ledger-app/"))),
  );
});
