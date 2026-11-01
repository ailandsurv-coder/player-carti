// Service worker: aplicația offline + flux audio din Drive (cu token) sau din fișierele descărcate.
const VER = 'v1';
const APP_CACHE = 'carti-app-' + VER;
const AUDIO_CACHE = 'carti-audio-v1';
const DRIVE = 'https://www.googleapis.com/drive/v3/files/';
const BASE = new URL(self.registration.scope).pathname;
const SHELL = ['./', 'index.html', 'app.js', 'style.css', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(APP_CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('carti-app-') && k !== APP_CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET') return;
  if (url.pathname.startsWith(BASE + 'stream/')) { e.respondWith(stream(e.request, url)); return; }
  // aplicația: întâi rețeaua (actualizări), apoi cache-ul (offline)
  e.respondWith((async () => {
    try {
      const r = await fetch(e.request);
      if (r.ok) (await caches.open(APP_CACHE)).put(e.request, r.clone());
      return r;
    } catch {
      return (await caches.match(e.request, { ignoreSearch: true })) ||
             (await caches.match(BASE)) || Response.error();
    }
  })());
});

async function stream(req, url) {
  const id = url.pathname.split('/').pop();
  const mime = url.searchParams.get('m') || 'audio/mpeg';
  const range = req.headers.get('range');
  const hit = await (await caches.open(AUDIO_CACHE)).match(new URL(BASE + 'audio/' + id, location.origin).href);
  if (hit) return fromBlob(await hit.blob(), range, mime);

  for (let i = 0; i < 2; i++) {
    let token;
    try { token = await askToken(i > 0); } catch { return new Response('fara token', { status: 401 }); }
    const h = { Authorization: 'Bearer ' + token };
    if (range) h.Range = range;
    let r;
    try { r = await fetch(DRIVE + id + '?alt=media&supportsAllDrives=true', { headers: h }); }
    catch { return new Response('offline', { status: 503 }); }
    if (r.status === 401) continue;
    const hd = new Headers(r.headers);
    hd.set('Content-Type', mime);
    hd.set('Accept-Ranges', 'bytes');
    return new Response(r.body, { status: r.status, statusText: r.statusText, headers: hd });
  }
  return new Response('neautorizat', { status: 401 });
}

function fromBlob(blob, range, mime) {
  const size = blob.size;
  const m = range && /bytes=(\d*)-(\d*)/.exec(range);
  if (!m) return new Response(blob, { status: 200, headers: { 'Content-Type': mime, 'Content-Length': size, 'Accept-Ranges': 'bytes' } });
  let start, end;
  if (m[1] === '') { start = Math.max(0, size - +m[2]); end = size - 1; }
  else { start = +m[1]; end = m[2] === '' ? size - 1 : Math.min(+m[2], size - 1); }
  if (start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': mime, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${size}`,
    },
  });
}

// Tokenul Google stă în pagină; service worker-ul îl cere de acolo.
async function askToken(force) {
  const list = await self.clients.matchAll({ type: 'window' });
  for (const c of list) {
    try {
      return await new Promise((res, rej) => {
        const ch = new MessageChannel();
        const t = setTimeout(() => rej(new Error('timeout')), 60000);
        ch.port1.onmessage = ev => { clearTimeout(t); ev.data && ev.data.token ? res(ev.data.token) : rej(new Error('refuz')); };
        c.postMessage({ type: 'token', force }, [ch.port2]);
      });
    } catch { /* încearcă următoarea fereastră */ }
  }
  throw new Error('fara token');
}
