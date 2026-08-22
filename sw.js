/* 首爾七日 — offline cache
   改版行程後把 VERSION 加一，使用者下次連網開啟就會自動更新。 */

const VERSION = "seoul-v103";

const SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
  "./apple-touch-icon.png",
  "./fonts/ChenYuluoyan-2.0-Thin.woff2"
];

/* 安裝：抓下行程本體。個別檔案失敗不讓整包安裝失敗。 */
self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(VERSION)
      .then(c => Promise.allSettled(SHELL.map(u => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

/* 啟用：清掉舊版快取 */
self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  /* 天氣、匯率、雲端同步：只走網路，斷網就讓它失敗，頁面會自行處理 */
  if (url.hostname === "api.open-meteo.com" ||
      url.hostname === "open.er-api.com" ||
      url.hostname === "script.google.com" ||
      url.hostname === "script.googleusercontent.com") return;

  /* 頁面本身：優先用網路拿最新版，斷網時回快取 */
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(VERSION).then(c => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then(r => r || caches.match("./index.html")))
    );
    return;
  }

  /* 字型等其他資源：先用快取，順便在背景補存 */
  e.respondWith(
    caches.match(req).then(hit => {
      if (hit) return hit;
      return fetch(req).then(res => {
        if (res.ok && (url.origin === location.origin || url.hostname.endsWith("gstatic.com") || url.hostname.endsWith("googleapis.com"))) {
          const copy = res.clone();
          caches.open(VERSION).then(c => c.put(req, copy));
        }
        return res;
      });
    })
  );
});
