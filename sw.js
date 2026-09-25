// 電波がなくても起動・読み取りできるよう、アプリ一式を端末に保存する
// ・アプリ本体(更新が多い)と、ライブラリ・文字認識データ(ほぼ変わらない・大きい)を別々に保存し、
//   更新のたびに大きなデータを取り直さないようにする
// ・起動は保存済みのデータを優先(キャッシュ優先)し、電波が弱い場所でも待たされないようにする
const APP_CACHE = 'pop-scan-app-v17';
const LIB_CACHE = 'pop-scan-lib-v1';
// 起動に欠かせないもの(これだけは必ず保存する)
const APP_FILES = ['./', './index.html'];
// あると良いもの(見つからなくても更新は止めない)
const APP_OPTIONAL = ['./manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png',
  './barlow-condensed-latin-600-normal.woff2', './barlow-condensed-latin-700-normal.woff2'];
const LIB_FILES = ['./zxing.min.js', './encoding.min.js', './xlsx.mini.min.js', './qrcode.js',
  './ocr/tesseract.min.js', './ocr/worker.min.js', './ocr/core/tesseract-core-simd-lstm.wasm.js', './ocr/core/tesseract-core-lstm.wasm.js',
  './ocr/lang/jpn.traineddata.gz', './ocr/lang/eng.traineddata.gz'];
const ALL = APP_FILES.concat(APP_OPTIONAL).map(f => [APP_CACHE, f]).concat(LIB_FILES.map(f => [LIB_CACHE, f]));

// アプリの設定「Wi-Fiのときだけ通信する」を読む(アプリ側が IndexedDB に書いたもの)
function netMode(){
  return new Promise(res => {
    try {
      const r = indexedDB.open('pop-scan', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => {
        try { const q = r.result.transaction('kv').objectStore('kv').get('netMode'); q.onsuccess = () => res(q.result || {}); q.onerror = () => res({}); }
        catch(e){ res({}); }
      };
      r.onerror = () => res({});
    } catch(e){ res({}); }
  });
}
// 裏での自動通信をしてよいか(Wi-Fiのみ設定のときは、Wi-Fiと確認できた場合だけ)
async function autoNetAllowed(){
  const m = await netMode();
  if (!m.wifiOnly) return true;
  const c = self.navigator && self.navigator.connection, t = c && c.type;
  return t === 'wifi' || t === 'ethernet';
}

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
    await precacheAll(null, false); // 失敗したファイルがあっても続行する
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
    // 画面(ページ)は常に './index.html' として保存・取り出しする('/pop-scan/' と '/pop-scan/index.html' を同じものとして扱う)
    const cached = isNav
      ? (await caches.match('./index.html') || await caches.match(req, { ignoreSearch: true }))
      : await caches.match(req, { ignoreSearch: true });
    const lib = LIB_FILES.some(f => url.pathname.endsWith(f.slice(1)));
    // ライブラリ・文字認識データは大きいので、保存済みなら取り直さない(モバイル通信量の節約)
    if (cached && lib) return cached;
    // アプリ本体は保存済みをすぐ返し、裏で最新版を取りに行く(次回の起動から反映)
    // 端末のHTTPキャッシュに古い版が残っていても必ずサーバーに確認する
    const refresh = () => fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }).then(async res => {
      if (res && res.ok){
        const cache = await caches.open(lib ? LIB_CACHE : APP_CACHE);
        await cache.put(isNav ? './index.html' : req, res.clone());
      }
      return res;
    });
    if (cached){
      // 保存済みがあるときの裏の更新は、通信してよい場合だけ行う
      e.waitUntil(autoNetAllowed().then(ok => ok ? refresh().catch(() => {}) : null));
      return cached;
    }
    try { return await refresh(); }
    catch(err){ return new Response('オフラインのため読み込めませんでした。電波のある場所で一度アプリを開いてください。', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }); }
  })());
});
