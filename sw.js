// Offline support. The page is served from the cache so the app opens without a connection;
// the page asks for a fresh copy after it starts and offers a reload when one arrived.
// Fonts and Amap map tiles are cached as they are used.
const SHELL = "shell-v1", FONTS = "fonts-v1", TILES = "tiles-v1";
const INDEX = new URL("./", self.registration.scope).href;
const ASSETS = ["manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png", "apple-touch-icon.png"];
const MAX_TILES = 3000; // about 50 MB of tiles at most

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL)
    .then((c) => c.addAll([INDEX, ...ASSETS].map((u) => new Request(u, { cache: "reload" }))))
    .then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => ![SHELL, FONTS, TILES].includes(k)).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET") return;
  if (req.mode === "navigate" && url.origin === location.origin) e.respondWith(page(req));
  else if (url.origin === location.origin && ASSETS.some((a) => url.href === new URL(a, INDEX).href)) e.respondWith(cacheFirst(SHELL, req));
  else if (url.hostname === "fonts.googleapis.com") e.respondWith(staleWhileRevalidate(e, FONTS, req));
  else if (url.hostname === "fonts.gstatic.com") e.respondWith(cacheFirst(FONTS, req));
  else if (url.hostname.endsWith(".is.autonavi.com")) e.respondWith(tile(e));
});

// every page of the app is the one index.html
async function page(req) {
  const hit = await caches.match(INDEX, { cacheName: SHELL });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok && !res.redirected) (await caches.open(SHELL)).put(INDEX, res.clone());
  return res;
}
async function cacheFirst(name, req) {
  const cache = await caches.open(name), hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}
async function staleWhileRevalidate(e, name, req) {
  const cache = await caches.open(name), hit = await cache.match(req);
  const net = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res });
  if (!hit) return net;
  e.waitUntil(net.catch(() => {}));
  return hit;
}
// Tiles are fetched with CORS so the cached copy also serves the "save image" canvas, which needs CORS.
let tilePuts = 0;
async function tile(e) {
  const cache = await caches.open(TILES), key = e.request.url, hit = await cache.match(key);
  if (hit) return hit;
  let res;
  try { res = await fetch(key, { mode: "cors", credentials: "omit" }) } catch { return fetch(e.request) }
  if (res.ok) e.waitUntil(cache.put(key, res.clone()).then(() => ++tilePuts % 50 ? null : trimTiles(cache)));
  return res;
}
// drop the oldest tiles once the cache is over its limit
async function trimTiles(cache) {
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_TILES)).map((k) => cache.delete(k)));
}

// The page sends "check" after it starts and when it comes back online: fetch index.html,
// and if it differs from the cached copy, keep it and tell the page so it can offer a reload.
self.addEventListener("message", (e) => {
  if (e.data !== "check") return;
  e.waitUntil(refreshShell().then((changed) => { if (changed) e.source.postMessage("updated") }));
});
async function refreshShell() {
  const res = await fetch(INDEX, { cache: "no-cache" }).catch(() => null);
  if (!res || !res.ok || res.redirected) return false;
  const cache = await caches.open(SHELL), old = await cache.match(INDEX), fresh = await res.clone().text();
  if (old && await old.text() === fresh) return false;
  await cache.put(INDEX, res);
  return !!old;
}
