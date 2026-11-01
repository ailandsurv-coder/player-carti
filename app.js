'use strict';
// Cărți audio din Google Drive — PWA. Tokenul OAuth stă doar în acest browser.

const DEFAULT_CLIENT_ID = '915598264659-pke077r19enfbp4q4q99lq50720kv080.apps.googleusercontent.com';
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const DRIVE = 'https://www.googleapis.com/drive/v3/';
const AUDIO_CACHE = 'carti-audio-v1';
const FOLDER = 'application/vnd.google-apps.folder';
const SHORTCUT = 'application/vnd.google-apps.shortcut';
const AUDIO_EXT = /\.(mp3|m4a|m4b|aac|ogg|oga|opus|wav|flac|webm|mp4)$/i;
const MIME_BY_EXT = { mp3: 'audio/mpeg', m4a: 'audio/mp4', m4b: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac',
  ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac', webm: 'audio/webm' };
const SPEEDS = [0.8, 1, 1.1, 1.25, 1.5, 1.75, 2];
const SLEEPS = [['Oprit', 0], ['15 min', 15], ['30 min', 30], ['45 min', 45], ['60 min', 60], ['Final capitol', -1]];
const coll = new Intl.Collator('ro', { numeric: true, sensitivity: 'base' });

const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* fără stocare */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* fără stocare */ } },
};

const ROOT = { id: 'root', name: 'Drive-ul meu' };
const S = {
  clientId: ls.get('clientId', '') || DEFAULT_CLIENT_ID,
  token: ls.get('tok', null),            // {v, exp}
  loggedIn: ls.get('loggedIn', false),
  path: ls.get('path', [ROOT]),
  items: [],
  loading: false,
  book: ls.get('book', null),            // {id, name, files:[{id,name,size,mime}]}
  idx: ls.get('idx', -1),
  speed: ls.get('speed', 1),
  autoDl: ls.get('autoDl', true),
  sleepAt: 0, sleepEnd: false, sleepSel: 0,
  dl: {},                                // id -> {loaded,total}
  cached: new Set(),
};
const au = $('#au');
let pendingSeek = 0;

/* ---------------- utilitare ---------------- */
function fmt(t) {
  if (!isFinite(t) || t < 0) t = 0;
  t = Math.floor(t);
  const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}
function mb(b) { return b ? (b / 1048576).toFixed(b > 1e8 ? 0 : 1) + ' MB' : ''; }
function stripExt(n) { return n.replace(/\.[^.]+$/, ''); }
function mimeOf(f) {
  const ext = (f.name.split('.').pop() || '').toLowerCase();
  return MIME_BY_EXT[ext] || (f.mime && f.mime.startsWith('audio/') ? f.mime : 'audio/mpeg');
}
let toastT;
function toast(msg, ms = 3500) {
  const el = $('#toast'); el.textContent = msg; el.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { el.hidden = true; }, ms);
}
function cur() { return S.book && S.book.files[S.idx]; }

/* ---------------- autentificare Google ---------------- */
let tokenClient = null, waiters = [], reqAt = 0;
function tokenValid() { return S.token && Date.now() < S.token.exp - 60e3; }
function initGIS() {
  if (tokenClient || !S.clientId || !(window.google && google.accounts && google.accounts.oauth2)) return;
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: S.clientId,
    scope: SCOPE,
    callback: r => {
      if (r.error) return flush(new Error(r.error_description || r.error));
      S.token = { v: r.access_token, exp: Date.now() + r.expires_in * 1000 };
      S.loggedIn = true;
      ls.set('tok', S.token); ls.set('loggedIn', true);
      flush(null);
    },
    error_callback: e => flush(new Error(
      e.type === 'popup_closed' ? 'Fereastra Google a fost închisă.' :
      e.type === 'popup_failed_to_open' ? 'Fereastra Google a fost blocată.' : (e.message || e.type))),
  });
}
function flush(err) {
  const w = waiters; waiters = [];
  w.forEach(x => (err ? x.rej(err) : x.res(S.token.v)));
  if (err) showBanner(err.message + ' Atinge pentru reconectare.');
  else { hideBanner(); if (routeNeedsRender) { routeNeedsRender = false; route(); } }
}
// Trebuie apelată sincron din handler-ul de atingere, ca fereastra Google să nu fie blocată.
function getToken(force) {
  if (!force && tokenValid()) return Promise.resolve(S.token.v);
  initGIS();
  if (!tokenClient) return Promise.reject(new Error('Serviciul Google nu s-a încărcat (verifică internetul).'));
  if (waiters.length && Date.now() - reqAt > 90e3) flush(new Error('Timp expirat.'));
  return new Promise((res, rej) => {
    waiters.push({ res, rej });
    if (waiters.length === 1) { reqAt = Date.now(); tokenClient.requestAccessToken({ prompt: '' }); }
  });
}
function showBanner(msg) { $('#bannerTxt').textContent = msg; $('#banner').hidden = false; }
function hideBanner() { $('#banner').hidden = true; }

async function api(path, params = {}) {
  const u = new URL(DRIVE + path);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  for (let i = 0; i < 2; i++) {
    const t = await getToken(i > 0);
    const r = await fetch(u, { headers: { Authorization: 'Bearer ' + t } });
    if (r.status === 401) { S.token = null; continue; }
    if (!r.ok) throw new Error('Drive ' + r.status + ': ' + (await r.text()).slice(0, 200));
    return r.json();
  }
  throw new Error('Autentificare eșuată.');
}

/* ---------------- Drive ---------------- */
function norm(f) {
  let id = f.id, mt = f.mimeType;
  if (mt === SHORTCUT && f.shortcutDetails) { id = f.shortcutDetails.targetId; mt = f.shortcutDetails.targetMimeType || ''; }
  if (mt === FOLDER) return { id, name: f.name, folder: true };
  if (mt.startsWith('audio/') || AUDIO_EXT.test(f.name)) return { id, name: f.name, size: +f.size || 0, mime: mt };
  return null;
}
async function listFolder(id) {
  const q = id === 'shared' ? 'sharedWithMe=true and trashed=false' : `'${id}' in parents and trashed=false`;
  const out = [];
  let pageToken;
  do {
    const d = await api('files', {
      q, pageSize: 1000, pageToken, supportsAllDrives: true, includeItemsFromAllDrives: true,
      fields: 'nextPageToken,files(id,name,mimeType,size,shortcutDetails)',
    });
    out.push(...d.files);
    pageToken = d.nextPageToken;
  } while (pageToken);
  return out.map(norm).filter(Boolean)
    .sort((a, b) => (b.folder ? 1 : 0) - (a.folder ? 1 : 0) || coll.compare(a.name, b.name));
}
async function openFolder(path) {
  S.path = path; ls.set('path', path);
  const id = path[path.length - 1].id;
  S.items = ls.get('ls:' + id, null) || [];
  S.loading = true; renderLib();
  try {
    S.items = await listFolder(id);
    ls.set('ls:' + id, S.items);
  } catch (e) {
    if (!S.items.length) toast(e.message, 6000);
    else toast('Nu pot actualiza lista (' + e.message + ') — arăt lista salvată.');
  }
  S.loading = false; renderLib();
}

/* ---------------- descărcări (offline) ---------------- */
function audioKey(id) { return new URL('audio/' + id, location.href).href; }
async function refreshCached() {
  try {
    const keys = await (await caches.open(AUDIO_CACHE)).keys();
    S.cached = new Set(keys.map(k => k.url.split('/').pop()));
  } catch { S.cached = new Set(); }
}
const dlQueue = [];
let dlBusy = false;
function queueDl(files) {
  for (const f of files) if (f && !S.cached.has(f.id) && !S.dl[f.id] && !dlQueue.some(x => x.id === f.id)) dlQueue.push(f);
  if (!dlBusy) dlWorker();
  renderAll();
}
async function dlWorker() {
  dlBusy = true;
  while (dlQueue.length) {
    const f = dlQueue.shift();
    if (S.cached.has(f.id)) continue;
    try { await download(f); } catch (e) { toast('Descărcare eșuată: ' + stripExt(f.name) + ' (' + e.message + ')'); }
  }
  dlBusy = false;
}
async function download(f) {
  const st = S.dl[f.id] = { loaded: 0, total: f.size || 0 };
  const cache = await caches.open(AUDIO_CACHE);
  try {
    let r;
    for (let i = 0; i < 2; i++) {
      const t = await getToken(i > 0);
      r = await fetch(DRIVE + 'files/' + f.id + '?alt=media&supportsAllDrives=true', { headers: { Authorization: 'Bearer ' + t } });
      if (r.status !== 401) break;
      S.token = null;
    }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    st.total = +r.headers.get('content-length') || st.total;
    const [a, b] = r.body.tee();
    const hd = { 'Content-Type': mimeOf(f) };
    if (st.total) hd['Content-Length'] = String(st.total);
    const put = cache.put(audioKey(f.id), new Response(a, { headers: hd }));
    const rd = b.getReader();
    let last = 0;
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      st.loaded += value.length;
      if (Date.now() - last > 700) { last = Date.now(); renderAll(); }
    }
    await put;
    S.cached.add(f.id);
  } catch (e) {
    await cache.delete(audioKey(f.id)).catch(() => {});
    throw e;
  } finally {
    delete S.dl[f.id];
    renderAll();
  }
}
async function deleteBookDownloads(files) {
  const cache = await caches.open(AUDIO_CACHE);
  for (const f of files) { await cache.delete(audioKey(f.id)); S.cached.delete(f.id); }
  renderAll(); toast('Descărcările cărții au fost șterse.');
}
function dlState(f) {
  if (S.cached.has(f.id)) return '⬇✓';
  const d = S.dl[f.id];
  if (d) return d.total ? Math.floor(100 * d.loaded / d.total) + '%' : mb(d.loaded);
  if (dlQueue.some(x => x.id === f.id)) return '⏳';
  return '';
}

/* ---------------- player ---------------- */
function startBook(folder, files, idx) {
  S.book = { id: folder.id, name: folder.name, files: files.map(({ id, name, size, mime }) => ({ id, name, size, mime })) };
  ls.set('book', S.book);
  playIdx(idx);
}
function chapterStart(f) { return ls.get('done:' + f.id, false) ? 0 : ls.get('pos:' + f.id, 0); }
function playIdx(i, at) {
  const f = S.book && S.book.files[i];
  if (!f) return;
  if (S.idx !== i) savePos();
  S.idx = i; ls.set('idx', i);
  if (ls.get('done:' + f.id, false) && at == null) { ls.del('done:' + f.id); ls.del('pos:' + f.id); }
  pendingSeek = at != null ? at : chapterStart(f);
  au.src = 'stream/' + f.id + '?m=' + encodeURIComponent(mimeOf(f)) + (pendingSeek ? '#t=' + pendingSeek.toFixed(1) : '');
  au.defaultPlaybackRate = au.playbackRate = S.speed;
  au.play().catch(e => { if (e.name !== 'AbortError') toast('Nu pot reda: ' + e.message); });
  mediaMeta();
  if (S.autoDl) queueDl([f, S.book.files[i + 1]]);
  renderAll();
}
function togglePlay() {
  if (!cur()) return;
  if (!au.src || au.error) {
    // reluare după repornirea aplicației: dacă trebuie token, îl cerem acum (în gestul utilizatorului)
    if (!S.cached.has(cur().id) && !tokenValid()) getToken().catch(() => {});
    playIdx(S.idx);
  } else if (au.paused) au.play().catch(e => toast('Nu pot reda: ' + e.message));
  else au.pause();
}
function skip(d) { if (au.src) au.currentTime = Math.max(0, Math.min((au.duration || 1e9) - 0.5, au.currentTime + d)); }
function nextChap(d) {
  if (!S.book) return;
  const i = S.idx + d;
  if (i >= 0 && i < S.book.files.length) playIdx(i, 0);
  else if (d < 0) au.currentTime = 0;
}
let lastSave = 0;
function savePos() {
  const f = cur();
  if (!f || !au.src || !isFinite(au.currentTime) || au.currentTime < 1) return;
  ls.set('pos:' + f.id, Math.max(0, au.currentTime - 2));
  if (isFinite(au.duration)) ls.set('dur:' + f.id, au.duration);
  ls.set('lastAt', Date.now());
}
function setSleep(v) {
  S.sleepSel = v;
  S.sleepEnd = v === -1;
  S.sleepAt = v > 0 ? Date.now() + v * 60e3 : 0;
  renderPlayer();
}

au.addEventListener('loadedmetadata', () => {
  if (pendingSeek && Math.abs(au.currentTime - pendingSeek) > 2) au.currentTime = Math.min(pendingSeek, au.duration - 1);
  pendingSeek = 0;
  au.playbackRate = S.speed;
  if (cur()) ls.set('dur:' + cur().id, au.duration);
});
au.addEventListener('timeupdate', () => {
  if (Date.now() - lastSave > 4000) { lastSave = Date.now(); savePos(); }
  if (S.sleepAt && Date.now() >= S.sleepAt) { au.pause(); setSleep(0); toast('Temporizatorul de somn a oprit redarea.'); }
  renderTime();
});
au.addEventListener('play', () => { hideErr(); renderAll(); });
au.addEventListener('pause', () => { savePos(); renderAll(); });
au.addEventListener('ended', () => {
  const f = cur();
  if (f) { ls.set('done:' + f.id, true); ls.del('pos:' + f.id); }
  if (S.sleepEnd) { setSleep(0); toast('Capitol terminat — redare oprită (somn).'); renderAll(); return; }
  if (S.book && S.idx + 1 < S.book.files.length) playIdx(S.idx + 1, 0);
  else { toast('Ai terminat cartea!'); renderAll(); }
});
au.addEventListener('error', () => {
  const f = cur();
  if (!f) return;
  const msg = !navigator.onLine && !S.cached.has(f.id)
    ? 'Capitolul nu e descărcat și nu ai internet.'
    : 'Nu pot încărca capitolul. Dacă sesiunea Google a expirat, atinge „Reconectează”.';
  $('#pState').textContent = msg;
  if (!tokenValid()) showBanner('Sesiunea Google a expirat. Atinge pentru reconectare.');
  renderAll();
});
function hideErr() { $('#pState').textContent = ''; }

/* ---------------- Media Session (ecran blocat, căști) ---------------- */
function mediaMeta() {
  if (!('mediaSession' in navigator) || !cur()) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: stripExt(cur().name), artist: S.book.name,
    album: `Capitolul ${S.idx + 1} / ${S.book.files.length}`,
    artwork: [{ src: 'icon-512.png', sizes: '512x512', type: 'image/png' }],
  });
}
if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession, h = (a, f) => { try { ms.setActionHandler(a, f); } catch { /* nesuportat */ } };
  h('play', () => togglePlay());
  h('pause', () => au.pause());
  h('seekbackward', d => skip(-(d.seekOffset || 15)));
  h('seekforward', d => skip(d.seekOffset || 30));
  h('previoustrack', () => nextChap(-1));
  h('nexttrack', () => nextChap(1));
  h('seekto', d => { au.currentTime = d.seekTime; });
}
let lastPos = 0;
function positionState() {
  if (!('mediaSession' in navigator) || !isFinite(au.duration) || Date.now() - lastPos < 2000) return;
  lastPos = Date.now();
  try { navigator.mediaSession.setPositionState({ duration: au.duration, playbackRate: au.playbackRate, position: Math.min(au.currentTime, au.duration) }); } catch { /* ignor */ }
}

/* ---------------- randare ---------------- */
function chapterMeta(f) {
  const done = ls.get('done:' + f.id, false), pos = ls.get('pos:' + f.id, 0), dur = ls.get('dur:' + f.id, 0);
  return { done, pos, dur, pct: done ? 100 : dur ? Math.min(100, 100 * pos / dur) : 0 };
}
function chapterRow(f, i, playing) {
  const m = chapterMeta(f), dl = dlState(f);
  const ic = playing ? (au.src && !au.paused ? '🔊' : '▶') : m.done ? '✓' : '♪';
  const sub = [m.dur ? fmt(m.dur) : mb(f.size), m.pos && !m.done ? 'ai rămas la ' + fmt(m.pos) : ''].filter(Boolean).join(' · ');
  return `<div class="it${playing ? ' cur' : ''}" data-i="${i}">
    <span class="ic">${ic}</span>
    <div class="nm">${esc(stripExt(f.name))}<div class="meta">${esc(sub)}</div>
      ${m.pct ? `<div class="pbar"><i style="width:${m.pct}%"></i></div>` : ''}</div>
    <span class="st">${dl}</span></div>`;
}
function bookSummary(files) {
  let done = 0, firstOpen = -1;
  files.forEach((f, i) => { if (ls.get('done:' + f.id, false)) done++; else if (firstOpen < 0) firstOpen = i; });
  return { done, firstOpen };
}
function renderLib() {
  const path = S.path, here = path[path.length - 1];
  $('#crumbs').innerHTML = path.map((p, i) => `<a href="#lib" data-c="${i}">${esc(p.name)}</a>`).join('<span>›</span>');
  const folders = S.items.filter(x => x.folder), audios = S.items.filter(x => !x.folder);
  let h = '';
  if (here.id === 'root') h += `<div class="it" data-f="shared"><span class="ic">👥</span><div class="nm">Partajate cu mine</div></div>`;
  h += folders.map(f => `<div class="it" data-f="${esc(f.id)}"><span class="ic">📁</span><div class="nm">${esc(f.name)}</div><span class="st">›</span></div>`).join('');
  if (audios.length) {
    const isCur = S.book && S.book.id === here.id;
    const sm = bookSummary(audios);
    const resumeI = isCur ? S.idx : (sm.firstOpen < 0 ? 0 : sm.firstOpen);
    const rf = audios[resumeI], rp = chapterStart(rf);
    const allDl = audios.every(f => S.cached.has(f.id)), anyDl = audios.some(f => S.cached.has(f.id));
    h += `<div class="card book">
      <h2>${esc(here.name)}</h2>
      <div class="muted">${audios.length} fișiere audio · ascultate ${sm.done}/${audios.length}</div>
      <button class="primary big" data-act="resume" data-i="${resumeI}">▶ ${rp > 5 || resumeI > 0 ? 'Continuă: ' + esc(stripExt(rf.name)) + (rp > 5 ? ' (' + fmt(rp) + ')' : '') : 'Ascultă de la început'}</button>
      <div class="btns">
        ${allDl ? '<span class="muted">✓ Toată cartea e descărcată (merge offline)</span>' : '<button data-act="dlall">⬇ Descarcă toată cartea</button>'}
        ${anyDl ? '<button data-act="dldel">Șterge descărcările</button>' : ''}
      </div></div>`;
    h += audios.map((f, i) => chapterRow(f, i, isCur && i === S.idx)).join('');
  }
  if (!h || (here.id !== 'root' && !folders.length && !audios.length))
    h += `<p class="muted center">${S.loading ? 'Se încarcă…' : 'Folder gol (sau fără fișiere audio).'}</p>`;
  else if (S.loading) h = `<p class="muted center">Se actualizează…</p>` + h;
  $('#list').innerHTML = h;

  // „Continuă" rapid când cartea curentă e în alt folder
  const f = cur();
  $('#resume').innerHTML = f && S.book.id !== here.id
    ? `<div class="card book"><div class="muted">Ultima carte</div><h2>${esc(S.book.name)}</h2>
       <button class="primary" data-act="toplayer">▶ ${esc(stripExt(f.name))} (${fmt(chapterStart(f))})</button></div>` : '';
}
function renderPlayer() {
  const f = cur();
  if (!f) { $('#pChap').textContent = 'Nicio carte pornită'; $('#pList').innerHTML = ''; return; }
  $('#pBook').textContent = S.book.name + ` · ${S.idx + 1}/${S.book.files.length}`;
  $('#pChap').textContent = stripExt(f.name);
  $('#bPlay').textContent = au.src && !au.paused ? '⏸' : '▶';
  $('#speeds').innerHTML = SPEEDS.map(s => `<button data-s="${s}" class="${s === S.speed ? 'on' : ''}">${s}×</button>`).join('');
  const left = S.sleepAt ? ' · ' + Math.ceil((S.sleepAt - Date.now()) / 60e3) + ' min' : '';
  $('#sleeps').innerHTML = SLEEPS.map(([l, v]) => `<button data-z="${v}" class="${v === S.sleepSel ? 'on' : ''}">${l}${v === S.sleepSel && v > 0 ? left : ''}</button>`).join('');
  $('#pList').innerHTML = S.book.files.map((x, i) => chapterRow(x, i, i === S.idx)).join('');
  renderTime();
}
let seeking = false;
function renderTime() {
  const f = cur();
  const d = isFinite(au.duration) ? au.duration : (f ? ls.get('dur:' + f.id, 0) : 0);
  const t = au.src ? au.currentTime : (f ? chapterStart(f) : 0);
  if (!seeking) $('#seek').value = d ? Math.round(1000 * t / d) : 0;
  $('#tCur').textContent = fmt(t);
  $('#tLeft').textContent = '-' + fmt((d - t) / (S.speed || 1));
  $('#mBar').style.width = d ? (100 * t / d) + '%' : '0';
  positionState();
}
function renderMini() {
  const f = cur(), onPlayer = location.hash === '#player';
  $('#mini').hidden = !f || onPlayer || !$('#vSetup').hidden || !$('#vLogin').hidden;
  if (!f) return;
  $('#mChap').textContent = stripExt(f.name);
  $('#mBook').textContent = S.book.name;
  $('#mPlay').textContent = au.src && !au.paused ? '⏸' : '▶';
}
function renderAll() {
  if (!$('#vLib').hidden) renderLib();
  if (!$('#vPlayer').hidden) renderPlayer();
  renderMini();
}
async function renderSettings() {
  $('#optAutoDl').checked = S.autoDl;
  $('#cidTxt').textContent = S.clientId || '—';
  $('#usage').textContent = '…';
  try {
    let n = 0;
    const c = await caches.open(AUDIO_CACHE);
    for (const k of await c.keys()) { const r = await c.match(k); n += +r.headers.get('content-length') || 0; }
    $('#usage').textContent = mb(n) || '0 MB';
  } catch { $('#usage').textContent = '?'; }
}

/* ---------------- navigare ---------------- */
let routeNeedsRender = false;
function show(id, title, back) {
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== id;
  $('#title').textContent = title;
  $('#btnBack').hidden = !back;
}
function route() {
  if (!S.clientId) { show('vSetup', 'Configurare', false); $('#inClientId').value = ''; renderMini(); return; }
  if (!S.loggedIn) { show('vLogin', 'Cărți audio', false); renderMini(); return; }
  const h = location.hash;
  if (h === '#player') { show('vPlayer', 'Ascult', true); renderPlayer(); }
  else if (h === '#settings') { show('vSettings', 'Setări', true); renderSettings(); }
  else { show('vLib', 'Cărți audio', false); renderLib(); }
  renderMini();
}
window.addEventListener('hashchange', route);

/* ---------------- evenimente ---------------- */
$('#originTxt').textContent = location.origin;
$('#btnSaveClient').onclick = () => {
  const v = $('#inClientId').value.trim();
  if (!/\.apps\.googleusercontent\.com$/.test(v)) { toast('Client ID-ul trebuie să se termine în .apps.googleusercontent.com'); return; }
  S.clientId = v; ls.set('clientId', v); tokenClient = null; route();
};
$('#btnLogin').onclick = () => {
  $('#loginErr').textContent = '';
  getToken(true).then(() => { location.hash = '#lib'; route(); openFolder(S.path); })
    .catch(e => { $('#loginErr').textContent = e.message; });
};
$('#bannerBtn').onclick = () => {
  getToken(true).then(() => {
    hideBanner();
    if (au.error && cur()) playIdx(S.idx, ls.get('pos:' + cur().id, 0));
    if (!$('#vLib').hidden) openFolder(S.path);
    if (dlQueue.length && !dlBusy) dlWorker();
  }).catch(() => {});
};
$('#btnBack').onclick = () => { if (history.length > 1) history.back(); else location.hash = '#lib'; };
$('#btnSettings').onclick = () => { location.hash = '#settings'; };

$('#crumbs').onclick = e => {
  const a = e.target.closest('[data-c]');
  if (!a) return;
  e.preventDefault();
  openFolder(S.path.slice(0, +a.dataset.c + 1));
};
$('#list').onclick = e => {
  const here = S.path[S.path.length - 1], audios = S.items.filter(x => !x.folder);
  const act = e.target.closest('[data-act]');
  if (act) {
    const a = act.dataset.act;
    if (a === 'resume') {
      if (S.book && S.book.id === here.id && au.src && !au.error) { if (au.paused) au.play(); }
      else { if (!tokenValid()) getToken().catch(() => {}); startBook(here, audios, +act.dataset.i); }
      location.hash = '#player';
    } else if (a === 'dlall') { if (!tokenValid()) getToken().catch(() => {}); queueDl(audios); toast('Descarc ' + audios.length + ' fișiere…'); }
    else if (a === 'dldel') deleteBookDownloads(audios);
    return;
  }
  const fo = e.target.closest('[data-f]');
  if (fo) {
    const id = fo.dataset.f;
    const name = id === 'shared' ? 'Partajate cu mine' : S.items.find(x => x.id === id).name;
    openFolder([...S.path, { id, name }]);
    return;
  }
  const ch = e.target.closest('[data-i]');
  if (ch) {
    const i = +ch.dataset.i;
    if (S.book && S.book.id === here.id && i === S.idx && au.src && !au.error) togglePlay();
    else { if (!tokenValid() && !S.cached.has(audios[i].id)) getToken().catch(() => {}); startBook(here, audios, i); }
  }
};
$('#resume').onclick = e => {
  if (!e.target.closest('[data-act=toplayer]')) return;
  if (!au.src || au.paused) togglePlay();
  location.hash = '#player';
};
$('#pList').onclick = e => {
  const ch = e.target.closest('[data-i]');
  if (!ch) return;
  const i = +ch.dataset.i;
  if (i === S.idx && au.src && !au.error) togglePlay();
  else { if (!tokenValid() && !S.cached.has(S.book.files[i].id)) getToken().catch(() => {}); playIdx(i); }
};
$('#bPlay').onclick = togglePlay;
$('#mPlay').onclick = e => { e.stopPropagation(); togglePlay(); };
$('#mini').onclick = () => { location.hash = '#player'; };
$('#bBack').onclick = () => skip(-15);
$('#bFwd').onclick = () => skip(30);
$('#bPrev').onclick = () => nextChap(-1);
$('#bNext').onclick = () => nextChap(1);
$('#seek').oninput = () => {
  seeking = true;
  const d = isFinite(au.duration) ? au.duration : 0;
  $('#tCur').textContent = fmt(d * $('#seek').value / 1000);
};
$('#seek').onchange = () => {
  seeking = false;
  if (au.src && isFinite(au.duration)) au.currentTime = au.duration * $('#seek').value / 1000;
};
$('#speeds').onclick = e => {
  const b = e.target.closest('[data-s]');
  if (!b) return;
  S.speed = +b.dataset.s; ls.set('speed', S.speed);
  au.defaultPlaybackRate = au.playbackRate = S.speed;
  renderPlayer();
};
$('#sleeps').onclick = e => {
  const b = e.target.closest('[data-z]');
  if (b) setSleep(+b.dataset.z);
};
$('#optAutoDl').onchange = e => { S.autoDl = e.target.checked; ls.set('autoDl', S.autoDl); };
$('#btnClearDl').onclick = async () => {
  if (!confirm('Ștergi toate fișierele descărcate? Pozițiile de ascultare rămân.')) return;
  await caches.delete(AUDIO_CACHE); await refreshCached(); renderSettings(); toast('Descărcări șterse.');
};
$('#btnChangeClient').onclick = () => { ls.del('clientId'); S.clientId = ''; tokenClient = null; route(); };
$('#btnLogout').onclick = () => {
  if (S.token && window.google && google.accounts) google.accounts.oauth2.revoke(S.token.v, () => {});
  S.token = null; S.loggedIn = false; ls.del('tok'); ls.del('loggedIn');
  location.hash = ''; route();
};
document.addEventListener('visibilitychange', () => { if (document.hidden) savePos(); else renderAll(); });
window.addEventListener('pagehide', savePos);
setInterval(() => { if (S.sleepAt && !$('#vPlayer').hidden) renderPlayer(); }, 30e3);

/* ---------------- service worker: îi dăm tokenul când îl cere ---------------- */
async function setupSW() {
  if (!('serviceWorker' in navigator)) { toast('Browserul nu suportă service worker — folosește Chrome.'); return; }
  navigator.serviceWorker.addEventListener('message', e => {
    if (!e.data || e.data.type !== 'token' || !e.ports[0]) return;
    getToken(e.data.force).then(t => e.ports[0].postMessage({ token: t }), () => e.ports[0].postMessage({}));
  });
  await navigator.serviceWorker.register('sw.js');
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    // prima instalare: așteptăm ca service worker-ul să preia pagina (fără el nu merge fluxul audio)
    await new Promise(res => {
      navigator.serviceWorker.addEventListener('controllerchange', res, { once: true });
      setTimeout(res, 3000);
    });
    if (!navigator.serviceWorker.controller) location.reload();
  }
}

/* ---------------- pornire ---------------- */
(async function start() {
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  route();
  await setupSW();
  await refreshCached();
  // GIS se încarcă asincron
  const t0 = Date.now();
  (function waitGis() {
    if (window.google && google.accounts && google.accounts.oauth2) initGIS();
    else if (Date.now() - t0 < 20000) setTimeout(waitGis, 200);
  })();
  if (S.clientId && S.loggedIn) {
    if (tokenValid()) openFolder(S.path);
    else {
      S.items = ls.get('ls:' + S.path[S.path.length - 1].id, []);
      routeNeedsRender = true;
      renderAll();
      showBanner('Atinge pentru reconectarea la Google Drive.');
    }
  }
})();
