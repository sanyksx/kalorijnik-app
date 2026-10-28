/* Калорийник: работа без интернета и обновления.
   - Приложение всегда открывается мгновенно из памяти телефона (кэш), даже без связи.
   - Новая версия скачивается в фоне, когда сайт доступен. После этого страница
     показывает «Доступно обновление»; по нажатию новая версия включается.
   - Фото (/_blob/<id>) отдаются из IndexedDB телефона.
   - Шрифты Google кэшируются после первого открытия.
   ВАЖНО: при каждом выпуске менять VERSION — по нему телефон узнаёт об обновлении. */
const VERSION = "kalorijnik-2026-10-29c";
const SHELL = ["./", "index.html", "platform.js", "manifest.webmanifest", "icon-192.png", "icon-512.png", "icon-maskable-512.png"];
const FONTS = "kalorijnik-fonts";

self.addEventListener("install", e => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    await Promise.all(SHELL.map(async u => {
      const r = await fetch(new Request(u, { cache: "reload" }));
      if (!r.ok) throw new Error(u + " " + r.status);
      await c.put(u, r);
    }));
    // Первая установка — включаемся сразу. Обновление — ждём согласия на странице.
    if (!self.registration.active) await self.skipWaiting();
  })());
});

self.addEventListener("message", e => {
  if (e.data === "skip-waiting") self.skipWaiting();
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== VERSION && k !== FONTS).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

function blobFromIDB(id) {
  return new Promise(resolve => {
    const r = indexedDB.open("kalorijnik", 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains("docs")) d.createObjectStore("docs");
      if (!d.objectStoreNames.contains("blobs")) d.createObjectStore("blobs");
    };
    r.onerror = () => resolve(null);
    r.onsuccess = () => {
      try {
        const g = r.result.transaction("blobs", "readonly").objectStore("blobs").get(id);
        g.onsuccess = () => resolve(g.result || null);
        g.onerror = () => resolve(null);
      } catch (err) { resolve(null); }
    };
  });
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET" && req.method !== "HEAD") return;
  const url = new URL(req.url);

  // Фото из памяти телефона
  if (url.origin === location.origin && url.pathname.includes("/_blob/")) {
    const id = url.pathname.split("/_blob/").pop();
    e.respondWith(blobFromIDB(id).then(b => b
      ? new Response(req.method === "HEAD" ? null : b, { headers: { "Content-Type": b.type || "application/octet-stream", "Cache-Control": "no-store" } })
      : new Response("", { status: 404 })));
    return;
  }

  // Шрифты: из кэша, а если нет — скачать и запомнить
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    e.respondWith(caches.open(FONTS).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      try { const r = await fetch(req); if (r.ok || r.type === "opaque") c.put(req, r.clone()); return r; }
      catch (err) { return new Response("", { status: 504 }); }
    }));
    return;
  }

  if (url.origin !== location.origin) return;

  // Файлы приложения: сразу из кэша этой версии; чего нет в кэше — из сети
  e.respondWith((async () => {
    const c = await caches.open(VERSION);
    const hit = req.mode === "navigate"
      ? (await c.match("index.html")) || (await c.match("./"))
      : await c.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const r = await fetch(req);
      if (r.ok && SHELL.some(s => url.pathname.endsWith(s.replace("./", "/")))) c.put(req, r.clone());
      return r;
    } catch (err) {
      return new Response("", { status: 504 });
    }
  })());
});
