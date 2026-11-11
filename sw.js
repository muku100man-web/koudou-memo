/* オフラインでも開けるよう、アプリ本体をキャッシュする。更新時は CACHE の番号を上げる */
const CACHE = "koudou-memo-v1.0.1";
const FILES = ["./","index.html","style.css","app.js","manifest.webmanifest",
  "icons/apple-touch-icon.png","icons/icon-192.png","icons/icon-512.png","icons/icon-maskable-512.png","icons/favicon-32.png"];
self.addEventListener("install", e=>{ e.waitUntil(caches.open(CACHE).then(c=>c.addAll(FILES)).then(()=>self.skipWaiting())); });
self.addEventListener("activate", e=>{ e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())); });
self.addEventListener("fetch", e=>{
  const req = e.request; if(req.method!=="GET" || new URL(req.url).origin!==location.origin) return;
  // 通信できるときは最新を取り、できないときはキャッシュを使う
  e.respondWith(fetch(req).then(res=>{ const copy=res.clone(); if(res.ok) caches.open(CACHE).then(c=>c.put(req,copy)); return res; })
    .catch(()=>caches.match(req,{ignoreSearch:true}).then(r=>r||caches.match("index.html"))));
});
