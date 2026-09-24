// アプリ本体をキャッシュして、電波の弱い売場でも起動できるようにする
const CACHE = 'pop-scan-v10';
const FILES = ['./', './index.html', './zxing.min.js', './encoding.min.js', './xlsx.mini.min.js', './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png',
  './ocr/tesseract.min.js', './ocr/worker.min.js', './ocr/core/tesseract-core-simd-lstm.wasm.js', './ocr/core/tesseract-core-lstm.wasm.js', './ocr/lang/jpn.traineddata.gz', './ocr/lang/eng.traineddata.gz'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // API通信などはキャッシュしない
  // 本体は「ネット優先・つながらなければキャッシュ」で、更新がすぐ反映されるようにする
  e.respondWith(
    fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
  );
});
