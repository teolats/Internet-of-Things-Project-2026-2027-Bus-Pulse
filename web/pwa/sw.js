/* BusPulse service worker: caches the app shell so the PWA opens offline.
   Live data still needs the network (MQTT over WebSocket is not cached). */
const CACHE = "buspulse-v1";
const SHELL = [
  "./", "index.html", "app.css", "app.js", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png",
  "../shared/config.js", "../shared/routes.js", "../shared/buspulse-data.js",
  "../shared/vendor/leaflet/leaflet.js", "../shared/vendor/leaflet/leaflet.css", "../shared/vendor/mqtt.min.js"
];
self.addEventListener("install", e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener("activate", e => e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;   // map tiles, broker: network only
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
    const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return res;
  })));
});
