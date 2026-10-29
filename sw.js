// Lazy Ledger service worker: makes the app installable, opens it fast, and lets it open without a connection.
// docs/specs/fast-open.md has the rules.
const CACHE = "lazy-ledger-v3"; // bump when icons or other fixed files change, so phones drop the old copies
const BUILD = "j-q4STjjSvMisdRe9_du_"; // stamped with the build id by scripts/sw-precache.mjs, so every release installs anew
const SCOPE = "/lazy-ledger-app/";

// Installing a version saves all of its built files (out/precache.json), so a saved page of this version can
// still load every piece of its code after the host has replaced the files, and offline. Files saved for
// earlier versions stay. A file that fails is skipped; it is fetched when needed instead.
// Which files belong to which release is kept in the same cache, under two made-up addresses:
// BUILDS lists the releases in the order they installed, LIST_OF(id) holds one release's files.
const BUILDS = `${SCOPE}__builds.json`;
const LIST_OF = (id) => `${SCOPE}__builds/${id}.json`;
const json = (v) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
async function readJson(cache, url) {
  const hit = await cache.match(url);
  return hit ? hit.json() : null;
}

async function precache() {
  try {
    const res = await fetch(`${SCOPE}precache.json`, { cache: "no-cache" });
    if (!res.ok) return;
    const { files } = await res.json();
    const cache = await caches.open(CACHE);
    if (BUILD !== "dev") {
      await cache.put(LIST_OF(BUILD), json(files));
      const order = ((await readJson(cache, BUILDS)) || []).filter((b) => b !== BUILD);
      await cache.put(BUILDS, json([...order, BUILD]));
    }
    const have = new Set((await cache.keys()).map((r) => r.url));
    const missing = files.filter((f) => !have.has(new URL(f, self.location.origin).href));
    await Promise.allSettled(missing.map((f) => fetch(f).then((r) => (r.ok ? cache.put(f, r) : null))));
  } catch {
    /* no list (a local run) or no connection: files are saved as they are used */
  }
}

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(precache());
});
/**
 * Keeps the built files of this release and the one before it (a page of that one may still be open, or be
 * the saved page the next open shows) and deletes every other release's files. Only when both lists are
 * known: without them nothing is deleted. Icons and pages are not touched.
 */
async function prune() {
  if (BUILD === "dev") return;
  try {
    const cache = await caches.open(CACHE);
    const order = (await readJson(cache, BUILDS)) || [];
    const at = order.indexOf(BUILD);
    if (at < 0) return;
    const keep = order.slice(Math.max(0, at - 1), at + 1);
    const lists = await Promise.all(keep.map((b) => readJson(cache, LIST_OF(b))));
    if (lists.some((l) => !Array.isArray(l))) return;
    const wanted = new Set(lists.flat().map((f) => new URL(f, self.location.origin).href));
    const dropBuilds = order.filter((b) => !keep.includes(b));
    for (const r of await cache.keys()) {
      if (r.url.includes("/_next/static/") && !wanted.has(r.url)) await cache.delete(r);
    }
    for (const b of dropBuilds) await cache.delete(LIST_OF(b));
    await cache.put(BUILDS, json(keep));
  } catch {
    /* nothing deleted: the next release tries again */
  }
}

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(prune)
      .then(() => self.clients.claim()),
  );
});

/** Tells the open pages a newer version is saved, so the app can reload itself quietly (src/lib/fresh.ts). */
function tellUpdate() {
  return self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((all) => all.forEach((c) => c.postMessage({ type: "ll-update", build: BUILD })));
}

/**
 * Asks the host for the newest copy of a page (it may hold an old one for a few minutes) and saves it, under its
 * address without the ?part. With `old` (the saved copy just opened), a different newest copy means an update.
 */
function fetchAndSave(req, old, event) {
  return fetch(req, { cache: "no-cache" }).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      const u = new URL(req.url);
      caches.open(CACHE).then((c) => c.put(u.origin + u.pathname, copy));
      if (old && req.mode === "navigate") {
        event.waitUntil(Promise.all([old.text(), res.clone().text()]).then(([a, b]) => (a !== b ? tellUpdate() : null)).catch(() => {}));
      }
    }
    return res;
  });
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  const isStatic = req.url.includes("/_next/static/") || req.url.includes("/icons/");
  if (isStatic) {
    // Built files never change name, so the saved copy is always right.
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })),
    );
    return;
  }
  // Pages: the saved copy at once, so the app opens without waiting for the network, and the newest copy
  // is fetched in the background for next time; if it is newer, the page is told (an update is ready).
  // No saved copy yet: the network. Offline with no copy: the Home page.
  // A page's copy serves any ?id=... (the wallet page is one file for every wallet).
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      const fresh = fetchAndSave(req, hit ? hit.clone() : null, event);
      if (hit) {
        event.waitUntil(fresh.catch(() => {}));
        return hit;
      }
      return fresh.catch(() => caches.match(SCOPE));
    }),
  );
});
