/* Калорийник — локальная платформа для телефона.
   Страница писалась для Claude и обращается к нему через window.claude.use(…).
   Здесь те же вызовы реализованы на самом телефоне:
     db        — данные в IndexedDB (как облачная база, но в памяти телефона)
     assets    — фото в IndexedDB, показываются по адресу /_blob/<id> через sw.js
     downloads — сохранение файлов (копия, CSV)
     user      — один локальный пользователь
     sample    — ИИ пока выключен (null): страница сама переходит на разбор по базе
   Когда появится синхронизация, заменяется только db (или блок Store в index.html). */
(function () {
  "use strict";
  window.KALOR_PLATFORM = "local";

  const DB_NAME = "kalorijnik", DB_VER = 1;
  let dbp = null;
  function idb() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, DB_VER);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains("docs")) d.createObjectStore("docs");
        if (!d.objectStoreNames.contains("blobs")) d.createObjectStore("blobs");
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function tx(store, mode, fn) {
    const d = await idb();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode), s = t.objectStore(store);
      let out;
      Promise.resolve(fn(s, v => (out = v))).catch(rej);
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  }
  const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const clone = v => (v == null ? v : JSON.parse(JSON.stringify(v)));

  /* ---------- db: документы по путям «коллекция/документ» ---------- */
  const listeners = new Map(); // путь коллекции → Set(fn)
  function notify(colPath) {
    const set = listeners.get(colPath);
    if (set) set.forEach(fn => { try { fn(); } catch (e) {} });
  }
  async function listCol(path) {
    const pre = path + "/";
    return tx("docs", "readonly", async (s, done) => {
      const range = IDBKeyRange.bound(pre, pre + "￿");
      const keys = await req(s.getAllKeys(range));
      const vals = await req(s.getAll(range));
      const out = [];
      keys.forEach((k, i) => { const id = k.slice(pre.length); if (!id.includes("/")) out.push({ id, v: vals[i] }); });
      done(out);
    });
  }
  const snapDoc = (id, v) => ({ id, exists: v !== undefined, data: () => clone(v) });
  function docRef(colPath, id) {
    const key = colPath + "/" + id;
    return {
      id, path: key,
      async get() { const v = await tx("docs", "readonly", async (s, done) => done(await req(s.get(key)))); return snapDoc(id, v); },
      async set(data) { await tx("docs", "readwrite", s => { s.put(clone(data), key); }); notify(colPath); },
      async update(data) {
        await tx("docs", "readwrite", async s => { const cur = (await req(s.get(key))) || {}; s.put(Object.assign({}, cur, clone(data)), key); });
        notify(colPath);
      },
      async delete() { await tx("docs", "readwrite", s => { s.delete(key); }); notify(colPath); },
      collection: sub => colRef(key + "/" + sub)
    };
  }
  function query(colPath, lim) {
    const run = async () => { let rows = await listCol(colPath); if (lim) rows = rows.slice(0, lim); return { size: rows.length, empty: !rows.length, docs: rows.map(r => snapDoc(r.id, r.v)) }; };
    return {
      where() { return query(colPath, lim); },
      orderBy() { return query(colPath, lim); },
      limit(n) { return query(colPath, n); },
      get: run,
      onSnapshot(next, err) {
        let alive = true;
        const fire = () => run().then(s => { if (alive) next(s); }, e => err && err(e));
        let set = listeners.get(colPath); if (!set) listeners.set(colPath, (set = new Set()));
        set.add(fire); setTimeout(fire, 0);
        return () => { alive = false; set.delete(fire); };
      }
    };
  }
  function colRef(path) {
    return Object.assign(query(path), { path, doc: id => docRef(path, id || Math.random().toString(36).slice(2)) });
  }
  const db = {
    collection: colRef,
    doc(path) { const i = path.lastIndexOf("/"); return docRef(path.slice(0, i), path.slice(i + 1)); }
  };

  /* ---------- assets: фото в IndexedDB, адрес /_blob/<id> обслуживает sw.js ---------- */
  const OK_TYPES = /^(image\/|video\/|application\/pdf|text\/|application\/json)/;
  const assets = {
    async upload(blob, opts) {
      const type = (opts && opts.type) || blob.type || "application/octet-stream";
      if (!OK_TYPES.test(type)) { const e = new Error("Тип файла не подходит"); e.code = "invalid_type"; throw e; }
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      const b = blob.type === type ? blob : new Blob([blob], { type });
      await tx("blobs", "readwrite", s => { s.put(b, id); });
      return { id, url: blobUrl(id), sizeBytes: b.size, contentType: type };
    },
    async list() {
      const keys = await tx("blobs", "readonly", async (s, done) => done(await req(s.getAllKeys())));
      return { assets: keys.map(id => ({ id, url: blobUrl(id) })), usage: {} };
    },
    async delete(idOrUrl) { const id = String(idOrUrl).split("/").pop(); await tx("blobs", "readwrite", s => { s.delete(id); }); }
  };
  function blobUrl(id) { return new URL("_blob/" + id, document.baseURI).pathname; }

  /* ---------- downloads: сохранение файла ---------- */
  const downloads = {
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = filename || "file";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    }
  };

  /* ---------- user: один владелец телефона ---------- */
  const user = {
    async id() { return "local"; },
    async me() { return { id: "local", name: "" }; },
    isOwner() { return true; }, canEdit() { return true; },
    async can() { return true; },
    async profiles() { return {}; }
  };

  const NS = { db, assets, downloads, user, sample: null };
  window.claude = Object.freeze({ use: async name => (name in NS ? NS[name] : null) });

  /* Просим браузер не стирать данные при нехватке места */
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}

  /* Работа без интернета, установка на телефон и обновления */
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    let shown = false, reloading = false;
    function offerUpdate(worker) {
      if (shown || !worker) return; shown = true;
      const bar = document.createElement("div");
      bar.id = "updbar"; bar.setAttribute("role", "status");
      bar.style.cssText = "position:fixed;left:50%;transform:translateX(-50%);top:calc(10px + env(safe-area-inset-top,0px));z-index:41;display:flex;align-items:center;gap:12px;max-width:calc(100% - 32px);padding:10px 10px 10px 16px;border-radius:14px;background:var(--fg,#1B221D);color:var(--bg,#F1F3EC);box-shadow:0 8px 28px rgba(0,0,0,.28);font:600 14px/1.3 var(--f-body,system-ui,sans-serif)";
      bar.innerHTML = '<span>Доступно обновление</span><button type="button" style="border:0;border-radius:10px;padding:8px 14px;font:inherit;font-weight:700;background:var(--accent,#2D7552);color:var(--accent-fg,#fff);cursor:pointer">Обновить</button>';
      bar.querySelector("button").addEventListener("click", () => { bar.querySelector("button").textContent = "…"; worker.postMessage("skip-waiting"); });
      document.body.appendChild(bar);
    }
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloading || !shown) return; reloading = true; location.reload();
    });
    window.addEventListener("load", async () => {
      try {
        const reg = await navigator.serviceWorker.register("sw.js", { updateViaCache: "none" });
        const watch = w => { if (!w) return; w.addEventListener("statechange", () => { if (w.state === "installed" && navigator.serviceWorker.controller) offerUpdate(w); }); };
        if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
        watch(reg.installing);
        reg.addEventListener("updatefound", () => watch(reg.installing));
        // Проверять обновления при каждом возвращении в приложение (не чаще раза в 10 минут)
        let last = Date.now();
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible" && Date.now() - last > 600000) { last = Date.now(); reg.update().catch(() => {}); }
        });
      } catch (e) {}
    });
  }
})();
