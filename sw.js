// 電波がなくても起動・読み取りできるよう、アプリ一式を端末に保存する
// ・アプリ本体(更新が多い)と、ライブラリ・文字認識データ(ほぼ変わらない・大きい)を別々に保存し、
//   更新のたびに大きなデータを取り直さないようにする
// ・起動は保存済みのデータを優先(キャッシュ優先)し、電波が弱い場所でも待たされないようにする
const APP_CACHE = 'pop-scan-app-v13';
const LIB_CACHE = 'pop-scan-lib-v1';
const APP_FILES = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];
const LIB_FILES = ['./zxing.min.js', './encoding.min.js', './xlsx.mini.min.js', './qrcode.js',
  './ocr/tesseract.min.js', './ocr/worker.min.js', './ocr/core/tesseract-core-simd-lstm.wasm.js', './ocr/core/tesseract-core-lstm.wasm.js',
  './ocr/lang/jpn.traineddata.gz', './ocr/lang/eng.traineddata.gz'];
const ALL = APP_FILES.map(f => [APP_CACHE, f]).concat(LIB_FILES.map(f => [LIB_CACHE, f]));

async function cacheOne(cacheName, file, force){
  const cache = await caches.open(cacheName);
  if (!force && await cache.match(file)) return true;
  const res = await fetch(new Request(file, { cache: 'reload' }));
  if (!res.ok) throw new Error(file + ' ' + res.status);
  await cache.put(file, res);
  return true;
}
async function precacheAll(report, force){
  let done = 0, failed = [];
  for (const [c, f] of ALL){
    try { await cacheOne(c, f, force && c === APP_CACHE); } catch(e){ failed.push(f); }
    done++; if (report) report({ type: 'progress', done, total: ALL.length });
  }
  return failed;
}

self.addEventListener('install', e => {
  // 本体は必須、ライブラリは1つ失敗しても入れ替えを止めない(後で「オフライン用データを保存」で取り直せる)
  e.waitUntil((async () => {
    const app = await caches.open(APP_CACHE);
    await app.addAll(APP_FILES.map(f => new Request(f, { cache: 'reload' })));
    await precacheAll(null, false);
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('pop-scan') && k !== APP_CACHE && k !== LIB_CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('message', e => {
  const port = e.ports && e.ports[0];
  if (!port) return;
  if (e.data && e.data.type === 'precache'){
    e.waitUntil(precacheAll(m => port.postMessage(m), false).then(failed => port.postMessage({ type: 'done', failed })));
  } else if (e.data && e.data.type === 'check'){
    e.waitUntil((async () => {
      const missing = [];
      for (const [c, f] of ALL){ const cache = await caches.open(c); if (!(await cache.match(f))) missing.push(f); }
      port.postMessage({ type: 'check', missing, total: ALL.length });
    })());
  }
});

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith((async () => {
    const isNav = req.mode === 'navigate';
    const cached = await caches.match(req, { ignoreSearch: true }) || (isNav ? await caches.match('./index.html') : null);
    const lib = LIB_FILES.some(f => url.pathname.endsWith(f.slice(1)));
    // ライブラリ・文字認識データは大きいので、保存済みなら取り直さない(モバイル通信量の節約)
    if (cached && lib) return cached;
    // アプリ本体は保存済みをすぐ返し、裏で最新版を取りに行く(次回の起動から反映)
    const refresh = fetch(req).then(async res => {
      if (res && res.ok){
        const cache = await caches.open(lib ? LIB_CACHE : APP_CACHE);
        await cache.put(isNav ? './index.html' : req, res.clone());
      }
      return res;
    });
    if (cached){ e.waitUntil(refresh.catch(() => {})); return cached; }
    try { return await refresh; }
    catch(err){ return new Response('オフラインのため読み込めませんでした。電波のある場所で一度アプリを開いてください。', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }); }
  })());
});
