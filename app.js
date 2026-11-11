'use strict';
/* =====================================================================
   Cari Defter — müşteri cari hesap takibi (dolar bazlı)
   Tüm veriler telefonda (IndexedDB) saklanır. Tutarlar sent (1/100 $)
   cinsinden tam sayı olarak tutulur; kuruş/sent hatası olmaz.
   ===================================================================== */
const APP_VERSION = '1.1.0';
const CUR = '$';
const LS_KEY = 'cari-defter-state';
const METHODS = ['Nakit', 'Sanal'];
const METHOD_LABEL = { 'Nakit': 'Nakit', 'Sanal': 'Sanal (Mail Order)' };

/* ---------------- Yardımcılar ---------------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf2 = new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nfq = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 3 });
const nf4 = new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 4 });

function money(c) { return nf2.format((c || 0) / 100) + ' ' + CUR; }
function moneyPlain(c) { return nf2.format((c || 0) / 100); }
function tl(k) { return nf2.format((k || 0) / 100) + ' TL'; }
function qtyStr(q) { return nfq.format(q); }

/* "1.250,50" / "1250,5" / "1250.5" / "1.250" → sayı */
function parseNum(str) {
  if (str == null) return NaN;
  let s = String(str).trim().replace(/\s|\$|₺|TL|USD/gi, '');
  if (!s) return NaN;
  let neg = false;
  if (s[0] === '-') { neg = true; s = s.slice(1); }
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  if (!/^\d*\.?\d*$/.test(s) || s === '.' || s === '') return NaN;
  const n = parseFloat(s);
  return isNaN(n) ? NaN : (neg ? -n : n);
}
function parseMoney(str) { const n = parseNum(str); return isFinite(n) ? Math.round(n * 100) : NaN; }
function parseQty(str) { const n = parseNum(str); return isFinite(n) ? Math.round(n * 1000) / 1000 : NaN; }

const FOLD = { 'ç': 'c', 'ğ': 'g', 'ı': 'i', 'ö': 'o', 'ş': 's', 'ü': 'u', 'â': 'a', 'î': 'i', 'û': 'u' };
function fold(s) { return String(s || '').toLocaleLowerCase('tr').replace(/[çğıöşüâîû]/g, c => FOLD[c]).trim(); }
const nameCmp = (a, b) => a.name.localeCompare(b.name, 'tr');

function pad(n) { return String(n).padStart(2, '0'); }
function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function today() { return ymd(new Date()); }
function addDays(s, n) { const [y, m, d] = s.split('-').map(Number); return ymd(new Date(y, m - 1, d + n)); }
function fmtDate(s) { if (!s) return ''; const [y, m, d] = s.split('-'); return d + '.' + m + '.' + y; }
function fmtDateTime(ms) { const d = new Date(ms); return fmtDate(ymd(d)) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

/* ---------------- Depolama (IndexedDB + yedek olarak localStorage) ---------------- */
let dbP = null;
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('cari-defter-db', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function kvGet(key) {
  const db = await (dbP = dbP || idb());
  return new Promise((res, rej) => {
    const q = db.transaction('kv', 'readonly').objectStore('kv').get(key);
    q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
  });
}
async function kvSet(key, val) {
  const db = await (dbP = dbP || idb());
  return new Promise((res, rej) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(val, key);
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error);
  });
}

function emptyState() {
  return {
    version: 1, currency: 'USD',
    customers: [], products: [], tx: [], trash: [],
    settings: { kdvDefault: false, kdvRate: 20, showArchived: false, sort: 'name', signature: '' },
    meta: { created: Date.now(), lastChange: 0, lastBackup: 0 }
  };
}
function normalize(s) {
  const e = emptyState();
  if (!s || typeof s !== 'object') return e;
  return {
    ...e, ...s,
    customers: Array.isArray(s.customers) ? s.customers : [],
    products: Array.isArray(s.products) ? s.products : [],
    tx: Array.isArray(s.tx) ? s.tx : [],
    trash: Array.isArray(s.trash) ? s.trash : [],
    settings: { ...e.settings, ...(s.settings || {}) },
    meta: { ...e.meta, ...(s.meta || {}) }
  };
}

let state = emptyState();
let saveChain = Promise.resolve();

async function loadState() {
  let a = null, b = null;
  try { const j = await kvGet('state'); if (j) a = JSON.parse(j); } catch (e) { console.error(e); }
  try { const j = localStorage.getItem(LS_KEY); if (j) b = JSON.parse(j); } catch (e) { console.error(e); }
  let pick = a || b;
  if (a && b && (b.meta && b.meta.lastChange || 0) > (a.meta && a.meta.lastChange || 0)) pick = b;
  state = normalize(pick);
}

/* touch=false → yedek/ayar gibi veri dışı değişiklikler */
function persist(touch = true) {
  if (touch) state.meta.lastChange = Date.now();
  const json = JSON.stringify(state);
  try { localStorage.setItem(LS_KEY, json); } catch (e) { /* yer yoksa IndexedDB yeterli */ }
  const p = saveChain.then(() => kvSet('state', json));
  saveChain = p.catch(() => {});
  return p.catch(e => {
    alertBox('<b>Kayıt hatası!</b> Veriler telefona kaydedilemedi. Lütfen hemen yedek alın.<br><small>' + esc(e && e.message || e) + '</small>');
    throw e;
  });
}

/* ---------------- Hesaplamalar ---------------- */
const TYPE_LABEL = { sale: 'Satış', payment: 'Tahsilat', return: 'İade', opening: 'Devir' };
const KIND_TYPE = { sale: 'sale', return: 'return', pay: 'payment', opening: 'opening' };
const TYPE_KIND = { sale: 'sale', return: 'return', payment: 'pay', opening: 'opening' };
const sign = t => (t.type === 'payment' || t.type === 'return') ? -1 : 1;
const delta = t => sign(t) * t.total;
const custById = id => state.customers.find(c => c.id === id);
const prodById = id => state.products.find(p => p.id === id);

function txCmp(a, b) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  const ra = a.type === 'opening' ? 0 : 1, rb = b.type === 'opening' ? 0 : 1;
  if (ra !== rb) return ra - rb;
  return (a.createdAt || 0) - (b.createdAt || 0);
}
function balances() {
  const m = new Map();
  for (const t of state.tx) m.set(t.customerId, (m.get(t.customerId) || 0) + delta(t));
  return m;
}
function balanceOf(cid, exceptTx) {
  let b = 0;
  for (const t of state.tx) if (t.customerId === cid && t.id !== exceptTx) b += delta(t);
  return b;
}
function ledger(cid) {
  const list = state.tx.filter(t => t.customerId === cid).sort(txCmp);
  let b = 0;
  return list.map(t => { const before = b; b += delta(t); return { t, before, after: b }; });
}
/* Müşteriye her ürünün en son satış fiyatı */
function lastPriceMap(cid, exceptTx) {
  const m = new Map();
  const list = state.tx.filter(t => t.customerId === cid && t.type === 'sale' && t.id !== exceptTx).sort(txCmp);
  for (const t of list) for (const l of (t.lines || [])) m.set(l.productId, { price: l.price, date: t.date });
  return m;
}
function needsBackup() { return state.tx.length > 0 && state.meta.lastChange > state.meta.lastBackup; }
function linesSummary(t) {
  return (t.lines || []).map(l => l.name + ' ×' + qtyStr(l.qty)).join(', ');
}
function rate(t) { return (t.tl && t.total) ? t.tl / t.total : 0; }
function payDetail(t) {
  let s = METHOD_LABEL[t.method] || t.method || '';
  if (t.tl) s += ' · ' + tl(t.tl) + ' (kur ' + nf4.format(rate(t)) + ')';
  return s;
}

/* ---------------- Yönlendirme ---------------- */
let curBack = '';
const scrollMem = {};
const ui = { cq: '', prq: '', pq: '', pickIndex: -1, txLimit: 100, txLimitFor: null, stmRange: '30', stmCid: null, saving: false };
let draft = null;

function routeParts() { return location.hash.replace(/^#\/?/, '').split('/').filter(Boolean); }
function depth() { return (history.state && history.state.d) || 0; }
function go(path) {
  scrollMem[location.hash] = window.scrollY;
  history.pushState({ d: depth() + 1 }, '', '#/' + path);
  render(); window.scrollTo(0, 0);
}
function replace(path) {
  history.replaceState({ d: depth() }, '', '#/' + path);
  render(); window.scrollTo(0, 0);
}
function back(fallback) {
  if (depth() > 0) history.back();
  else replace(fallback || '');
}
window.addEventListener('popstate', () => {
  closeModal(true);
  render();
  window.scrollTo(0, scrollMem[location.hash] || 0);
});

function render() {
  const p = routeParts();
  let v;
  if (p[0] === 'c' && p[1] === 'new') v = viewCustomerForm(null);
  else if (p[0] === 'c' && p[2] === 'edit') v = viewCustomerForm(p[1]);
  else if (p[0] === 'c' && KIND_TYPE[p[2]]) v = viewTxForm(p[2], p[1], p[3]);
  else if (p[0] === 'c' && p[1]) v = viewCustomer(p[1]);
  else if (p[0] === 't' && p[1]) v = viewTx(p[1]);
  else if (p[0] === 'products') v = viewProducts();
  else if (p[0] === 'p' && p[1]) v = viewProductForm(p[1] === 'new' ? null : p[1]);
  else if (p[0] === 'daily') v = viewDaily(p[1]);
  else if (p[0] === 'settings') v = viewSettings();
  else if (p[0] === 'trash') v = viewTrash();
  else v = viewCustomers();
  $('#app').innerHTML = v.html;
  if (v.after) v.after();
}

/* ---------------- Ortak parçalar ---------------- */
const ICONS = {
  customers: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/><circle cx="17" cy="9" r="2.8"/><path d="M16.5 14.6c2.6.2 4.4 1.9 5 5.4"/></svg>',
  daily: '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
  products: '<svg viewBox="0 0 24 24"><path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5z"/><path d="M3.5 7.5 12 12l8.5-4.5M12 12v9"/></svg>',
  settings: '<svg viewBox="0 0 24 24"><path d="M4 7h9M19 7h1M4 17h3M13 17h7"/><circle cx="16" cy="7" r="2.5"/><circle cx="10" cy="17" r="2.5"/></svg>'
};
function tabbar(active) {
  const tabs = [['customers', '', 'Müşteriler'], ['daily', 'daily', 'Günlük'], ['products', 'products', 'Ürünler'], ['settings', 'settings', 'Ayarlar']];
  return '<nav class="tabbar">' + tabs.map(([k, to, label]) =>
    `<button class="tab ${k === active ? 'on' : ''}" data-act="tab" data-to="${to}">${ICONS[k]}<span>${label}</span></button>`).join('') + '</nav>';
}
function page(o) {
  curBack = o.back;
  const backBtn = o.back !== undefined
    ? `<button class="hbtn back" data-act="${o.backAct || 'back'}"><svg viewBox="0 0 24 24" class="chev"><path d="M15 5l-7 7 7 7"/></svg>${esc(o.backLabel || 'Geri')}</button>` : '';
  return `<header class="top"><div class="top-in"><div class="tl">${backBtn}</div><h1>${esc(o.title)}</h1><div class="tr">${o.right || ''}</div></div></header>
  <main class="content${o.tabs ? ' has-tabs' : ''}">${o.body}</main>${o.tabs ? tabbar(o.tabs) : ''}`;
}
function notFound() {
  return { html: page({ title: 'Bulunamadı', back: '', body: '<div class="empty">Kayıt bulunamadı. Silinmiş olabilir.</div>' }) };
}
function balClass(b) { return b < 0 ? 'neg' : b === 0 ? 'zero' : ''; }
function signedMoney(t) {
  const d = delta(t);
  return (d >= 0 ? '+' : '−') + money(Math.abs(d));
}

/* ---------------- Müşteri listesi ---------------- */
function viewCustomers() {
  const bal = balances();
  const active = state.customers.filter(c => !c.archived);
  let total = 0; for (const v of bal.values()) total += v;
  const banner = needsBackup()
    ? `<button class="banner" data-act="backup"><span>⚠︎ Son yedekten sonra yeni kayıt var</span><b>Yedek Al</b></button>` : '';
  const sort = state.settings.sort;
  const body = `${banner}
    <div class="hero"><div class="hero-l">Toplam Alacak</div><div class="hero-v">${money(total)}</div><div class="hero-s">${active.length} müşteri</div></div>
    <div class="searchbar">
      <input type="search" id="cq" placeholder="Müşteri ara" value="${esc(ui.cq)}" data-bind="cq" autocomplete="off" autocorrect="off">
      <select data-bind="sort" aria-label="Sıralama">
        <option value="name" ${sort === 'name' ? 'selected' : ''}>A-Z</option>
        <option value="balance" ${sort === 'balance' ? 'selected' : ''}>Bakiye</option>
        <option value="recent" ${sort === 'recent' ? 'selected' : ''}>Son işlem</option>
      </select>
    </div>
    <div id="clist">${customerListHtml(bal)}</div>`;
  return { html: page({ title: 'Müşteriler', right: '<button class="hbtn strong" data-act="go" data-to="c/new">+ Yeni</button>', body, tabs: 'customers' }) };
}
function customerListHtml(bal) {
  const q = fold(ui.cq);
  const last = new Map();
  for (const t of state.tx) { const v = t.date + (t.createdAt || 0); if (!last.has(t.customerId) || last.get(t.customerId) < v) last.set(t.customerId, v); }
  let list = state.customers.filter(c => (!c.archived || state.settings.showArchived) &&
    (!q || fold(c.name + ' ' + (c.code || '') + ' ' + (c.phone || '') + ' ' + (c.address || '')).includes(q)));
  const s = state.settings.sort;
  if (s === 'balance') list.sort((a, b) => (bal.get(b.id) || 0) - (bal.get(a.id) || 0) || nameCmp(a, b));
  else if (s === 'recent') list.sort((a, b) => String(last.get(b.id) || '').localeCompare(String(last.get(a.id) || '')) || nameCmp(a, b));
  else list.sort(nameCmp);
  if (!list.length) {
    return state.customers.length
      ? '<div class="empty">Aramaya uyan müşteri yok.</div>'
      : '<div class="empty">Henüz müşteri yok.<br><button class="btn primary" data-act="go" data-to="c/new">+ İlk müşteriyi ekle</button></div>';
  }
  return '<div class="list">' + list.map(c => {
    const b = bal.get(c.id) || 0;
    const l = last.get(c.id);
    const sub = [c.code ? 'Kod ' + c.code : '', c.address, l ?'Son işlem ' + fmtDate(String(l).slice(0, 10)) : ''].filter(Boolean).join(' · ');
    return `<button class="row" data-act="go" data-to="c/${c.id}">
      <div class="rl"><div class="rn">${esc(c.name)}${c.archived ? ' <span class="badge b-opening">Pasif</span>' : ''}</div>${sub ? `<div class="rs">${esc(sub)}</div>` : ''}</div>
      <div class="rb ${balClass(b)}">${money(b)}</div></button>`;
  }).join('') + '</div>';
}

/* ---------------- Müşteri detay ---------------- */
function viewCustomer(cid) {
  const c = custById(cid);
  if (!c) return notFound();
  if (ui.txLimitFor !== cid) { ui.txLimitFor = cid; ui.txLimit = 100; }
  const led = ledger(cid);
  const bal = led.length ? led[led.length - 1].after : 0;
  const rows = led.slice().reverse();
  const shown = rows.slice(0, ui.txLimit);
  const listHtml = shown.length ? '<div class="list">' + shown.map(e => txRowHtml(e)).join('') + '</div>'
    + (rows.length > shown.length ? `<button class="btn outline" data-act="more">Daha eski ${rows.length - shown.length} işlemi göster</button>` : '')
    : '<div class="empty small">Henüz işlem yok.</div>';
  const body = `
    <div class="card balcard">
      <div class="lbl">Güncel Bakiye</div>
      <div class="big ${balClass(bal)}">${money(bal)}</div>
      ${bal < 0 ? '<div class="tag">Müşteri alacaklı (fazla ödeme)</div>' : ''}
      ${c.code ? `<div class="sub">Kart kodu: ${esc(c.code)}</div>` : ''}
      ${c.phone ? `<a class="sub link" href="tel:${esc(c.phone.replace(/\s/g, ''))}">${esc(c.phone)}</a>` : ''}
      ${c.address ? `<div class="sub">${esc(c.address)}</div>` : ''}
      ${c.note ? `<div class="sub">${esc(c.note)}</div>` : ''}
    </div>
    <div class="actions">
      <button class="act a-sale" data-act="go" data-to="c/${cid}/sale"><b>+</b>Satış</button>
      <button class="act a-pay" data-act="go" data-to="c/${cid}/pay"><b>−</b>Tahsilat</button>
      <button class="act a-ret" data-act="go" data-to="c/${cid}/return"><b>↩</b>İade</button>
      <button class="act a-stm" data-act="statement" data-id="${cid}"><b>≡</b>Ekstre</button>
    </div>
    <h2 class="sec">Hareketler</h2>
    ${listHtml}
    <button class="linkbtn" data-act="go" data-to="c/${cid}/opening">Devir / bakiye düzeltme ekle</button>`;
  return { html: page({ title: c.name, back: '', backLabel: 'Müşteriler', right: `<button class="hbtn" data-act="go" data-to="c/${cid}/edit">Düzenle</button>`, body }) };
}
function txRowHtml(e, showCustomer) {
  const t = e.t;
  let desc = '';
  if (t.type === 'sale' || t.type === 'return') desc = linesSummary(t);
  else if (t.type === 'payment') desc = payDetail(t);
  else desc = t.total < 0 ? 'Devir (müşteri alacaklı)' : 'Devir bakiyesi';
  const c = showCustomer ? custById(t.customerId) : null;
  return `<button class="txrow" data-act="go" data-to="t/${t.id}">
    <div class="txl">
      <div class="txt"><span class="badge b-${t.type}">${TYPE_LABEL[t.type]}</span><span class="muted">${fmtDate(t.date)}</span></div>
      ${c ? `<div class="txc">${esc(c.name)}</div>` : ''}
      <div class="txd">${esc(desc)}</div>
      ${t.note ? `<div class="txn">${esc(t.note)}</div>` : ''}
    </div>
    <div class="txr"><div class="amt am-${t.type}">${signedMoney(t)}</div>${e.after !== undefined ? `<div class="after">Bakiye ${money(e.after)}</div>` : ''}</div>
  </button>`;
}

/* ---------------- İşlem detay ---------------- */
function viewTx(tid) {
  const t = state.tx.find(x => x.id === tid);
  if (!t) return notFound();
  const c = custById(t.customerId);
  const led = ledger(t.customerId);
  const e = led.find(x => x.t.id === tid);
  let detail = '';
  if (t.type === 'sale' || t.type === 'return') {
    detail = '<div class="card"><div class="lines-view">' + t.lines.map(l =>
      `<div class="lv"><div class="lvn">${esc(l.name)}</div><div class="lvq">${qtyStr(l.qty)} adet × ${money(l.price)}</div><div class="lvt">${money(l.total)}</div></div>`).join('') + '</div>'
      + (t.kdvRate > 0 ? `<div class="sr"><span>Ara toplam</span><span>${money(t.subtotal)}</span></div><div class="sr"><span>KDV %${nfq.format(t.kdvRate)}</span><span>${money(t.kdvAmount)}</span></div>` : '')
      + `<div class="sr tot"><span>Toplam</span><span>${money(t.total)}</span></div></div>`;
  } else if (t.type === 'payment') {
    detail = `<div class="card"><div class="sr"><span>Ödeme şekli</span><span>${esc(METHOD_LABEL[t.method] || t.method)}</span></div>
      ${t.tl ? `<div class="sr"><span>Alınan TL</span><span>${tl(t.tl)}</span></div><div class="sr"><span>Kur</span><span>${nf4.format(rate(t))}</span></div>` : ''}
      <div class="sr tot"><span>Tahsilat</span><span>${money(t.total)}</span></div></div>`;
  } else {
    detail = `<div class="card"><div class="sr tot"><span>${t.total < 0 ? 'Devir (müşteri alacaklı)' : 'Devir (müşteri borçlu)'}</span><span>${money(Math.abs(t.total))}</span></div></div>`;
  }
  const body = `
    <div class="card">
      <div class="txt"><span class="badge b-${t.type}">${TYPE_LABEL[t.type]}</span><span>${fmtDate(t.date)}</span></div>
      <button class="custlink" data-act="go" data-to="c/${t.customerId}">${esc(c ? c.name : '?')} ›</button>
    </div>
    ${detail}
    ${t.note ? `<div class="card"><div class="lbl">Açıklama</div><div class="note">${esc(t.note)}</div></div>` : ''}
    <div class="card">
      <div class="sr"><span>Önceki bakiye</span><span>${money(e.before)}</span></div>
      <div class="sr"><span>Bu işlem</span><span>${signedMoney(t)}</span></div>
      <div class="sr new"><span>İşlem sonrası bakiye</span><span>${money(e.after)}</span></div>
    </div>
    <div class="btnrow">
      ${c && c.phone ? `<button class="btn wa" data-act="waTx" data-id="${t.id}">WhatsApp'a gönder</button>` : ''}
      <button class="btn outline" data-act="shareTx" data-id="${t.id}">Paylaş</button>
    </div>
    <div class="btnrow">
      <button class="btn outline" data-act="go" data-to="c/${t.customerId}/${TYPE_KIND[t.type]}/${t.id}">Düzenle</button>
      <button class="btn danger-o" data-act="delTx" data-id="${t.id}">Sil</button>
    </div>
    <p class="help center">Kayıt: ${fmtDateTime(t.createdAt)}${t.updatedAt ? ' · Son düzenleme: ' + fmtDateTime(t.updatedAt) : ''}</p>`;
  return { html: page({ title: TYPE_LABEL[t.type], back: 'c/' + t.customerId, body }) };
}

/* ---------------- Satış / İade / Tahsilat / Devir formu ---------------- */
function initDraft(kind, cid, txid) {
  const key = kind + '|' + cid + '|' + (txid || '');
  if (draft && draft.key === key) return draft;
  const s = state.settings;
  const d = { key, kind, cid, txid: txid || null, isNew: !txid, date: today(), lines: [], kdv: !!s.kdvDefault, kdvRate: nfq.format(s.kdvRate), amount: '', tlAmount: '', method: 'Nakit', dir: 'debit', note: '', dirty: false };
  if (txid) {
    const t = state.tx.find(x => x.id === txid);
    d.date = t.date; d.note = t.note || '';
    if (t.lines) {
      d.lines = t.lines.map(l => ({ productId: l.productId, name: l.name, qty: qtyStr(l.qty), price: moneyPlain(l.price) }));
      d.kdv = t.kdvRate > 0; if (t.kdvRate > 0) d.kdvRate = nfq.format(t.kdvRate);
    } else {
      d.amount = moneyPlain(Math.abs(t.total));
      d.method = t.method || 'Nakit';
      d.tlAmount = t.tl ? moneyPlain(t.tl) : '';
      d.dir = t.total < 0 ? 'credit' : 'debit';
    }
  }
  draft = d;
  return d;
}
function draftCalc(d) {
  let sub = 0;
  const lines = d.lines.map(l => {
    const q = parseQty(l.qty), p = parseMoney(l.price);
    const lt = (isFinite(q) && isFinite(p)) ? Math.round(q * p) : NaN;
    if (isFinite(lt)) sub += lt;
    return { q, p, lt };
  });
  const r = d.kdv ? parseNum(d.kdvRate) : 0;
  const kdvAmt = d.kdv && isFinite(r) ? Math.round(sub * r / 100) : 0;
  return { lines, sub, rate: r, kdvAmt, total: sub + kdvAmt };
}
function viewTxForm(kind, cid, txid) {
  const c = custById(cid);
  if (!c) return notFound();
  if (txid) { const t = state.tx.find(x => x.id === txid); if (!t || TYPE_KIND[t.type] !== kind || t.customerId !== cid) return notFound(); }
  const d = initDraft(kind, cid, txid);
  const titles = { sale: 'Satış', return: 'İade', pay: 'Tahsilat', opening: 'Devir Bakiyesi' };
  const base = balanceOf(cid, txid);
  let inner = '';
  if (kind === 'sale' || kind === 'return') inner = saleFormHtml(d, c);
  else if (kind === 'pay') inner = payFormHtml(d);
  else inner = openingFormHtml(d);
  const noteLabel = kind === 'pay' ? 'Açıklama' : 'Not / açıklama';
  const notePh = kind === 'pay' ? 'Örn: 5000 TL nakit alındı' : 'İsteğe bağlı';
  const body = `
    <div class="custmini"><b>${esc(c.name)}</b><span>Mevcut bakiye: ${money(base)}</span></div>
    <div class="field"><label>Tarih</label><input type="date" value="${d.date}" data-bind="d_date"></div>
    ${inner}
    <div class="field"><label>${noteLabel}</label><textarea rows="2" data-bind="d_note" placeholder="${notePh}">${esc(d.note)}</textarea></div>
    <div id="sum" class="card sum">${sumHtml(d, base)}</div>
    <button class="btn primary big" data-act="saveTx">${txid ? 'Değişiklikleri Kaydet' : 'Kaydet'}</button>`;
  return {
    html: page({ title: (txid ? 'Düzenle: ' : '') + titles[kind], back: txid ? 't/' + txid : 'c/' + cid, backAct: 'formback', backLabel: 'Vazgeç', right: '<button class="hbtn strong" data-act="saveTx">Kaydet</button>', body }),
    after() {
      if ((kind === 'sale' || kind === 'return') && d.isNew && !d.autoPicked && d.lines.length === 0) { d.autoPicked = true; openPicker(-1); }
      else if ((kind === 'pay' || kind === 'opening') && d.isNew && !d.focused) { d.focused = true; const el = $('#amt'); if (el) el.focus(); }
    }
  };
}
function saleFormHtml(d, c) {
  const k = draftCalc(d);
  const lp = lastPriceMap(c.id, d.txid);
  const lines = d.lines.map((l, i) => {
    const h = lp.get(l.productId);
    const lt = k.lines[i].lt;
    return `<div class="line card">
      <div class="lh"><button class="pickbtn" data-act="pick" data-i="${i}"><span>${esc(l.name)}</span><small>değiştir</small></button><button class="xbtn" data-act="delline" data-i="${i}" aria-label="Kaldır">✕</button></div>
      <div class="lg">
        <div class="field sm"><label>Adet</label><input id="q-${i}" inputmode="decimal" value="${esc(l.qty)}" data-bind="d_qty" data-i="${i}" placeholder="0" autocomplete="off"></div>
        <div class="field sm"><label>Birim fiyat (${CUR})</label><input id="p-${i}" inputmode="decimal" value="${esc(l.price)}" data-bind="d_price" data-i="${i}" placeholder="0,00" autocomplete="off"></div>
        <div class="lt"><label>Tutar</label><b id="lt-${i}">${isFinite(lt) ? money(lt) : '—'}</b></div>
      </div>
      ${h ? `<div class="hint">Bu müşteriye son fiyat: ${money(h.price)} · ${fmtDate(h.date)}</div>` : ''}
    </div>`;
  }).join('');
  return `<div class="lines">${lines || '<div class="empty small">Henüz ürün eklenmedi.</div>'}</div>
    <button class="btn outline" data-act="addline">+ Ürün ekle</button>
    <div class="card kdv">
      <label class="switch"><input type="checkbox" ${d.kdv ? 'checked' : ''} data-bind="d_kdv"><span class="sl"></span><span>KDV ekle</span></label>
      <div class="kdvrate ${d.kdv ? '' : 'hide'}"><span>Oran %</span><input inputmode="decimal" value="${esc(d.kdvRate)}" data-bind="d_kdvRate"></div>
    </div>`;
}
function payFormHtml(d) {
  return `<div class="field"><label>Tahsilat tutarı (${CUR})</label><input id="amt" class="bigin" inputmode="decimal" value="${esc(d.amount)}" data-bind="d_amount" placeholder="0,00" autocomplete="off"></div>
    <div class="field"><label>Ödeme şekli</label><div class="seg2">${METHODS.map(m =>
      `<button class="segb ${d.method === m ? 'on' : ''}" data-act="method" data-v="${m}">${METHOD_LABEL[m]}</button>`).join('')}</div></div>
    <div class="field"><label>Alınan TL tutarı (isteğe bağlı)</label><input id="tla" inputmode="decimal" value="${esc(d.tlAmount)}" data-bind="d_tl" placeholder="Örn: 5.000" autocomplete="off">
      <div class="hint" id="kur">${kurText(d)}</div></div>`;
}
function kurText(d) {
  const a = parseMoney(d.amount), t = parseMoney(d.tlAmount);
  if (a > 0 && t > 0) return 'Kur: 1 ' + CUR + ' = ' + nf4.format(t / a) + ' TL';
  return 'Doldurursanız kur otomatik hesaplanır ve kayda yazılır.';
}
function openingFormHtml(d) {
  return `<div class="field"><label>Tutar (${CUR})</label><input id="amt" class="bigin" inputmode="decimal" value="${esc(d.amount)}" data-bind="d_amount" placeholder="0,00" autocomplete="off"></div>
    <div class="field"><div class="seg2">
      <label class="segb ${d.dir !== 'credit' ? 'on' : ''}"><input type="radio" name="dir" value="debit" ${d.dir !== 'credit' ? 'checked' : ''} data-bind="d_dir">Müşteri borçlu</label>
      <label class="segb ${d.dir === 'credit' ? 'on' : ''}"><input type="radio" name="dir" value="credit" ${d.dir === 'credit' ? 'checked' : ''} data-bind="d_dir">Müşteri alacaklı</label>
    </div></div>
    <p class="help">Müşteri borçlu: size ödemesi gereken tutar (normal durum). Müşteri alacaklı: fazla ödeme yapmış, siz ona borçlusunuz.</p>`;
}
function sumHtml(d, base) {
  const type = KIND_TYPE[d.kind];
  let total = 0, rows = '';
  if (type === 'sale' || type === 'return') {
    const k = draftCalc(d);
    total = k.total;
    if (d.kdv) rows += `<div class="sr"><span>Ara toplam</span><span>${money(k.sub)}</span></div><div class="sr"><span>KDV %${isFinite(k.rate) ? nfq.format(k.rate) : '?'}</span><span>${money(k.kdvAmt)}</span></div>`;
    rows += `<div class="sr tot"><span>${type === 'sale' ? 'Satış toplamı' : 'İade toplamı'}</span><span>${money(total)}</span></div>`;
  } else if (type === 'payment') {
    total = parseMoney(d.amount); if (!isFinite(total)) total = 0;
    rows += `<div class="sr tot"><span>Tahsilat</span><span>${money(total)}</span></div>`;
  } else {
    const a = parseMoney(d.amount);
    total = isFinite(a) ? (d.dir === 'credit' ? -a : a) : 0;
    rows += `<div class="sr tot"><span>Devir</span><span>${money(total)}</span></div>`;
  }
  const dlt = (type === 'payment' || type === 'return') ? -total : total;
  rows += `<div class="sr"><span>Eski bakiye</span><span>${money(base)}</span></div><div class="sr new"><span>Yeni bakiye</span><span>${money(base + dlt)}</span></div>`;
  return rows;
}
function refreshSum() {
  if (!draft) return;
  const el = $('#sum'); if (el) el.innerHTML = sumHtml(draft, balanceOf(draft.cid, draft.txid));
  if (draft.kind === 'sale' || draft.kind === 'return') {
    const k = draftCalc(draft);
    k.lines.forEach((x, i) => { const b = $('#lt-' + i); if (b) b.textContent = isFinite(x.lt) ? money(x.lt) : '—'; });
  }
  const kur = $('#kur'); if (kur) kur.textContent = kurText(draft);
}

async function saveTx() {
  if (ui.saving || !draft) return;
  const d = draft;
  const type = KIND_TYPE[d.kind];
  if (!custById(d.cid)) return alertBox('Müşteri bulunamadı.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) return alertBox('Geçerli bir tarih seçin.');
  let tx = { type, customerId: d.cid, date: d.date, note: d.note.trim() };
  if (type === 'sale' || type === 'return') {
    if (!d.lines.length) return alertBox('En az bir ürün ekleyin.');
    const k = draftCalc(d);
    for (let i = 0; i < d.lines.length; i++) {
      const l = d.lines[i], x = k.lines[i];
      if (!(x.q > 0)) return alertBox(`“${esc(l.name)}” için geçerli bir adet girin.`);
      if (!(x.p >= 0)) return alertBox(`“${esc(l.name)}” için geçerli bir birim fiyat girin.`);
    }
    if (d.kdv && !(k.rate >= 0 && k.rate <= 100)) return alertBox('KDV oranı geçersiz.');
    if (!(k.total > 0)) return alertBox('Toplam tutar sıfır olamaz.');
    Object.assign(tx, {
      lines: d.lines.map((l, i) => ({ productId: l.productId, name: l.name, qty: k.lines[i].q, price: k.lines[i].p, total: k.lines[i].lt })),
      subtotal: k.sub, kdvRate: d.kdv ? k.rate : 0, kdvAmount: k.kdvAmt, total: k.total
    });
  } else {
    const a = parseMoney(d.amount);
    if (!(a > 0)) return alertBox('Geçerli bir tutar girin.');
    if (type === 'payment') {
      tx.total = a; tx.method = d.method;
      if (d.tlAmount.trim()) {
        const t = parseMoney(d.tlAmount);
        if (!(t > 0)) return alertBox('Alınan TL tutarı geçersiz. Boş bırakabilir veya düzeltebilirsiniz.');
        tx.tl = t;
      }
    } else tx.total = d.dir === 'credit' ? -a : a;
  }
  if (Math.abs(tx.total) >= 10000000 && !(await confirmBox(`Tutar çok yüksek: <b>${money(Math.abs(tx.total))}</b><br>Doğru mu?`, { ok: 'Evet, doğru' }))) return;
  ui.saving = true;
  try {
    const now = Date.now();
    if (d.txid) {
      const i = state.tx.findIndex(t => t.id === d.txid);
      const old = state.tx[i];
      tx = { ...tx, id: old.id, createdAt: old.createdAt, updatedAt: now };
      state.tx[i] = tx;
    } else {
      tx.id = uid(); tx.createdAt = now;
      state.tx.push(tx);
    }
    await persist();
    draft = null;
    toast(`Kaydedildi · Yeni bakiye: ${money(balanceOf(d.cid))}`);
    back(d.txid ? 't/' + d.txid : 'c/' + d.cid);
  } finally { ui.saving = false; }
}

/* ---------------- Ürün seçici ---------------- */
function openPicker(index) {
  ui.pickIndex = index; ui.pq = '';
  openModal(`<div class="picker">
    <div class="ph"><input type="search" id="pq" placeholder="Ürün ara veya yeni ürün adı yaz" data-bind="pq" autocomplete="off" autocorrect="off"><button class="hbtn" data-act="mclose">Kapat</button></div>
    <div id="plist" class="plist">${pickerList()}</div></div>`, { full: true });
  const el = $('#pq'); if (el) el.focus();
}
function pickerList() {
  const q = fold(ui.pq);
  const lp = draft ? lastPriceMap(draft.cid, draft.txid) : new Map();
  const ps = state.products.filter(p => !p.archived && (!q || fold(p.name).includes(q))).sort(nameCmp);
  let html = '';
  const typed = ui.pq.trim();
  if (typed && !state.products.some(p => fold(p.name) === q)) html += `<button class="prow add" data-act="pickadd">+ Yeni ürün ekle: “${esc(typed)}”</button>`;
  html += ps.map(p => {
    const h = lp.get(p.id);
    const info = h ? 'Son: ' + money(h.price) : (p.price != null ? money(p.price) : '');
    return `<button class="prow" data-act="pickp" data-id="${p.id}"><span>${esc(p.name)}</span><span class="muted">${info}</span></button>`;
  }).join('');
  if (!html) html = '<div class="empty small">Ürün listesi boş. Yukarıya ürün adını yazıp ekleyebilirsiniz.</div>';
  return html;
}
function pickProduct(p) {
  const d = draft; if (!d) return;
  const h = lastPriceMap(d.cid, d.txid).get(p.id);
  const price = h ? moneyPlain(h.price) : (p.price != null ? moneyPlain(p.price) : '');
  let idx = ui.pickIndex;
  if (idx >= 0 && d.lines[idx]) Object.assign(d.lines[idx], { productId: p.id, name: p.name, price });
  else { d.lines.push({ productId: p.id, name: p.name, qty: '', price }); idx = d.lines.length - 1; }
  d.dirty = true;
  closeModal();
  render();
  const el = $('#q-' + idx);
  if (el) { el.focus(); el.scrollIntoView({ block: 'center' }); }
}

/* ---------------- Ekstre ---------------- */
function rangeStart(r) {
  const t = today();
  if (r === 'month') return t.slice(0, 8) + '01';
  if (r === '30') return addDays(t, -30);
  if (r === '90') return addDays(t, -90);
  return null;
}
function statementText(cid, r) {
  const c = custById(cid);
  const led = ledger(cid);
  const from = rangeStart(r);
  const before = from ? led.filter(x => x.t.date < from) : [];
  const inR = from ? led.filter(x => x.t.date >= from) : led;
  const opening = before.length ? before[before.length - 1].after : 0;
  const final = led.length ? led[led.length - 1].after : 0;
  const L = ['*HESAP EKSTRESİ*', c.name, from ? fmtDate(from) + ' - ' + fmtDate(today()) : 'Tüm hareketler', ''];
  if (from) L.push('Devreden bakiye: ' + money(opening), '');
  if (!inR.length) L.push('(Bu dönemde işlem yok)');
  for (const e of inR) {
    const t = e.t;
    L.push(fmtDate(t.date) + ' ' + TYPE_LABEL[t.type] + ': ' + signedMoney(t));
    if (t.lines) for (const l of t.lines) L.push('   ' + l.name + ' ' + qtyStr(l.qty) + ' × ' + money(l.price));
    if (t.type === 'payment') L.push('   ' + payDetail(t));
    if (t.note) L.push('   ' + t.note);
    L.push('   Bakiye: ' + money(e.after));
  }
  L.push('', '*Güncel bakiye: ' + money(final) + '*');
  if (state.settings.signature) L.push('', state.settings.signature);
  return L.join('\n');
}
function openStatement(cid) {
  ui.stmCid = cid;
  const c = custById(cid);
  const ranges = [['month', 'Bu ay'], ['30', 'Son 30 gün'], ['90', 'Son 90 gün'], ['all', 'Tümü']];
  openModal(`<div class="dlg stm">
    <h3>Hesap Ekstresi</h3>
    <div class="chips">${ranges.map(([k, l]) => `<button class="chip ${ui.stmRange === k ? 'on' : ''}" data-act="stmRange" data-v="${k}">${l}</button>`).join('')}</div>
    <pre id="stmText" class="pre">${esc(statementText(cid, ui.stmRange))}</pre>
    <div class="btnrow">${c.phone ? '<button class="btn wa" data-act="stmWa">WhatsApp</button>' : ''}<button class="btn outline" data-act="stmShare">Paylaş</button><button class="btn outline" data-act="stmCopy">Kopyala</button></div>
    <button class="btn ghost" data-act="mclose">Kapat</button>
  </div>`);
}

/* ---------------- Paylaşım ---------------- */
function txText(t) {
  const c = custById(t.customerId);
  const led = ledger(t.customerId);
  const i = led.findIndex(x => x.t.id === t.id);
  const e = led[i];
  const isLast = i === led.length - 1;
  const titles = { sale: 'SATIŞ FİŞİ', return: 'İADE FİŞİ', payment: 'TAHSİLAT MAKBUZU', opening: 'DEVİR BAKİYESİ' };
  const L = ['*' + titles[t.type] + '*', c ? c.name : '', 'Tarih: ' + fmtDate(t.date), ''];
  if (t.lines) {
    for (const l of t.lines) L.push(l.name, '   ' + qtyStr(l.qty) + ' adet × ' + money(l.price) + ' = ' + money(l.total));
    L.push('');
    if (t.kdvRate > 0) L.push('Ara toplam: ' + money(t.subtotal), 'KDV %' + nfq.format(t.kdvRate) + ': ' + money(t.kdvAmount));
    L.push('*Toplam: ' + money(t.total) + '*');
  } else if (t.type === 'payment') {
    L.push('Tahsilat: *' + money(t.total) + '*', 'Ödeme şekli: ' + (METHOD_LABEL[t.method] || t.method));
    if (t.tl) L.push('Alınan: ' + tl(t.tl) + ' (kur ' + nf4.format(rate(t)) + ')');
  } else {
    L.push('Devir: ' + money(t.total));
  }
  if (t.note) L.push('Açıklama: ' + t.note);
  L.push('', 'Önceki bakiye: ' + money(e.before), '*' + (isLast ? 'Güncel bakiye' : 'İşlem sonrası bakiye') + ': ' + money(e.after) + '*');
  if (state.settings.signature) L.push('', state.settings.signature);
  return L.join('\n');
}
function waPhone(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 10 && d[0] === '5') d = '90' + d;
  else if (d.length === 11 && d[0] === '0') d = '9' + d;
  return d;
}
function sendWhatsApp(phone, text) {
  const ph = waPhone(phone);
  location.href = 'whatsapp://send?' + (ph ? 'phone=' + ph + '&' : '') + 'text=' + encodeURIComponent(text);
}
async function shareText(text) {
  if (navigator.share) {
    try { await navigator.share({ text }); return; }
    catch (e) { if (e && e.name === 'AbortError') return; }
  }
  copyText(text);
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Panoya kopyalandı'); }
  catch (e) { alertBox('Kopyalanamadı.'); }
}

/* ---------------- Müşteri formu ---------------- */
function viewCustomerForm(cid) {
  const c = cid ? custById(cid) : null;
  if (cid && !c) return notFound();
  const v = c || { name: '', phone: '', address: '', note: '' };
  let extra = '';
  if (!c) {
    extra = `<div class="card">
      <div class="lbl">Devir bakiyesi (varsa)</div>
      <div class="field"><input id="f-open" inputmode="decimal" placeholder="0,00 ${CUR}" autocomplete="off"></div>
      <div class="field"><div class="seg2">
        <label class="segb on"><input type="radio" name="fdir" value="debit" checked data-bind="segradio">Müşteri borçlu</label>
        <label class="segb"><input type="radio" name="fdir" value="credit" data-bind="segradio">Müşteri alacaklı</label>
      </div></div>
      <div class="field"><label>Devir tarihi</label><input type="date" id="f-odate" value="${today()}"></div>
    </div>`;
  } else {
    const b = balanceOf(c.id);
    const hasTx = state.tx.some(t => t.customerId === c.id);
    extra = `<div class="card">
      ${c.archived
        ? '<button class="btn outline" data-act="unarchiveCust">Müşteriyi tekrar aktif yap</button>'
        : `<button class="btn outline" data-act="archiveCust" ${b !== 0 ? 'disabled' : ''}>Müşteriyi pasife al</button>
           ${b !== 0 ? '<p class="help">Pasife almak için bakiyenin 0 olması gerekir.</p>' : '<p class="help">Pasif müşteriler listede gizlenir, kayıtları silinmez.</p>'}`}
      ${!hasTx ? '<button class="btn danger-o" data-act="delCust">Müşteriyi sil</button>' : ''}
    </div>`;
  }
  const body = `
    <div class="field"><label>Müşteri adı *</label><input id="f-name" value="${esc(v.name)}" autocomplete="off" autocapitalize="words"></div>
    <div class="field"><label>Kart kodu</label><input id="f-code" value="${esc(v.code || '')}" autocomplete="off" placeholder="İsteğe bağlı"></div>
    <div class="field"><label>Telefon</label><input id="f-phone" type="tel" value="${esc(v.phone)}" placeholder="05xx xxx xx xx" autocomplete="off"></div>
    <div class="field"><label>Adres / bölge</label><input id="f-addr" value="${esc(v.address)}" autocomplete="off"></div>
    <div class="field"><label>Not</label><textarea id="f-note" rows="2">${esc(v.note)}</textarea></div>
    ${extra}
    <button class="btn primary big" data-act="saveCust">Kaydet</button>`;
  return {
    html: page({ title: c ? 'Müşteri Düzenle' : 'Yeni Müşteri', back: c ? 'c/' + c.id : '', backLabel: 'Vazgeç', right: '<button class="hbtn strong" data-act="saveCust">Kaydet</button>', body }),
    after() { if (!c) { const el = $('#f-name'); if (el) el.focus(); } }
  };
}
async function saveCust() {
  const p = routeParts();
  const id = p[1] === 'new' ? null : p[1];
  const name = $('#f-name').value.trim().replace(/\s+/g, ' ');
  if (!name) return alertBox('Müşteri adı boş olamaz.');
  const dup = state.customers.find(c => c.id !== id && fold(c.name) === fold(name));
  if (dup && !(await confirmBox(`“${esc(dup.name)}” adında bir müşteri zaten var. Yine de kaydedilsin mi?`, { ok: 'Kaydet' }))) return;
  const code = $('#f-code').value.trim(), phone = $('#f-phone').value.trim(), address = $('#f-addr').value.trim(), note = $('#f-note').value.trim();
  const now = Date.now();
  if (id) {
    const c = custById(id);
    Object.assign(c, { name, code, phone, address, note, updatedAt: now });
    await persist();
    toast('Kaydedildi');
    back('c/' + id);
  } else {
    let open = 0;
    const raw = $('#f-open').value.trim();
    if (raw) {
      const a = parseMoney(raw);
      if (!(a >= 0)) return alertBox('Devir bakiyesi geçersiz.');
      open = ($('input[name=fdir]:checked') || {}).value === 'credit' ? -a : a;
    }
    const date = $('#f-odate').value || today();
    const c = { id: uid(), name, code, phone, address, note, createdAt: now };
    state.customers.push(c);
    if (open) state.tx.push({ id: uid(), type: 'opening', customerId: c.id, date, note: '', total: open, createdAt: now });
    await persist();
    toast('Müşteri eklendi');
    replace('c/' + c.id);
  }
}

/* ---------------- Ürünler ---------------- */
function viewProducts() {
  const body = `
    <div class="searchbar"><input type="search" placeholder="Ürün ara" value="${esc(ui.prq)}" data-bind="prq" autocomplete="off" autocorrect="off"></div>
    <div id="prlist">${productListHtml()}</div>`;
  return { html: page({ title: 'Ürünler', right: '<button class="hbtn strong" data-act="go" data-to="p/new">+ Yeni</button>', body, tabs: 'products' }) };
}
function productListHtml() {
  const q = fold(ui.prq);
  const list = state.products.filter(p => !q || fold(p.name).includes(q)).sort((a, b) => (a.archived ? 1 : 0) - (b.archived ? 1 : 0) || nameCmp(a, b));
  if (!list.length) return state.products.length ? '<div class="empty">Aramaya uyan ürün yok.</div>'
    : '<div class="empty">Henüz ürün yok.<br><button class="btn primary" data-act="go" data-to="p/new">+ Ürün ekle</button></div>';
  return '<div class="list">' + list.map(p => `<button class="row" data-act="go" data-to="p/${p.id}">
    <div class="rl"><div class="rn">${esc(p.name)}${p.archived ? ' <span class="badge b-opening">Pasif</span>' : ''}</div></div>
    <div class="rb zero">${p.price != null ? money(p.price) : ''}</div></button>`).join('') + '</div>';
}
function viewProductForm(pid) {
  const p = pid ? prodById(pid) : null;
  if (pid && !p) return notFound();
  const used = p && state.tx.some(t => (t.lines || []).some(l => l.productId === p.id));
  const body = `
    <div class="field"><label>Ürün adı *</label><input id="f-pname" value="${esc(p ? p.name : '')}" autocomplete="off"></div>
    <div class="field"><label>Varsayılan fiyat (${CUR}, isteğe bağlı)</label><input id="f-pprice" inputmode="decimal" value="${p && p.price != null ? moneyPlain(p.price) : ''}" placeholder="Boş bırakılabilir" autocomplete="off">
      <p class="help">Satışta önce o müşteriye verdiğiniz son fiyat gelir. Müşteriye hiç satılmadıysa bu fiyat gelir.</p></div>
    ${p ? `<div class="card">
      ${p.archived ? '<button class="btn outline" data-act="toggleProd">Ürünü tekrar aktif yap</button>' : '<button class="btn outline" data-act="toggleProd">Ürünü pasife al</button><p class="help">Pasif ürünler satış ekranında çıkmaz, eski kayıtlar korunur.</p>'}
      ${!used ? '<button class="btn danger-o" data-act="delProd">Ürünü sil</button>' : ''}
    </div>` : ''}
    <button class="btn primary big" data-act="saveProd">Kaydet</button>`;
  return {
    html: page({ title: p ? 'Ürün Düzenle' : 'Yeni Ürün', back: 'products', backLabel: 'Vazgeç', right: '<button class="hbtn strong" data-act="saveProd">Kaydet</button>', body }),
    after() { if (!p) { const el = $('#f-pname'); if (el) el.focus(); } }
  };
}
async function saveProd() {
  const p = routeParts();
  const id = p[1] === 'new' ? null : p[1];
  const name = $('#f-pname').value.trim().replace(/\s+/g, ' ');
  if (!name) return alertBox('Ürün adı boş olamaz.');
  const raw = $('#f-pprice').value.trim();
  let price = null;
  if (raw) { price = parseMoney(raw); if (!(price >= 0)) return alertBox('Fiyat geçersiz.'); }
  const dup = state.products.find(x => x.id !== id && fold(x.name) === fold(name));
  if (dup) return alertBox(`“${esc(dup.name)}” adında bir ürün zaten var.`);
  if (id) Object.assign(prodById(id), { name, price, updatedAt: Date.now() });
  else state.products.push({ id: uid(), name, price, createdAt: Date.now() });
  await persist();
  toast('Kaydedildi');
  back('products');
}

/* ---------------- Günlük rapor ---------------- */
function viewDaily(date) {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) date = today();
  const list = state.tx.filter(t => t.date === date).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const s = dailyTotals(list);
  const prodHtml = s.products.length ? '<div class="card"><div class="lbl">Satılan ürünler</div>' + s.products.map(p =>
    `<div class="sr"><span>${esc(p.name)}</span><span>${qtyStr(p.qty)} adet</span></div>`).join('') + '</div>' : '';
  const methodRows = METHODS.map(m => s.pay[m] ? `<div class="sr sm"><span>· ${METHOD_LABEL[m]}</span><span>${money(s.pay[m])}${s.payTl[m] ? ' / ' + tl(s.payTl[m]) : ''}</span></div>` : '').join('');
  const body = `
    <div class="daynav">
      <button class="hbtn" data-act="dayGo" data-to="${addDays(date, -1)}">‹ Önceki</button>
      <input type="date" value="${date}" data-bind="dailyDate">
      <button class="hbtn" data-act="dayGo" data-to="${addDays(date, 1)}">Sonraki ›</button>
    </div>
    <div class="card">
      <div class="sr"><span>Satış</span><span class="am-sale">${money(s.sale)}</span></div>
      ${s.ret ? `<div class="sr"><span>İade</span><span class="am-return">${money(s.ret)}</span></div>` : ''}
      <div class="sr"><span>Tahsilat</span><span class="am-payment">${money(s.payTotal)}</span></div>
      ${methodRows}
      <div class="sr tot"><span>İşlem sayısı</span><span>${list.length}</span></div>
    </div>
    ${prodHtml}
    <h2 class="sec">İşlemler</h2>
    ${list.length ? '<div class="list">' + list.map(t => txRowHtml({ t }, true)).join('') + '</div>' : '<div class="empty small">Bu tarihte işlem yok.</div>'}
    ${list.length ? '<button class="btn outline" data-act="dailyShare" data-d="' + date + '">Gün sonu raporunu paylaş</button>' : ''}`;
  return { html: page({ title: date === today() ? 'Bugün' : fmtDate(date), body, tabs: 'daily' }) };
}
function dailyTotals(list) {
  const s = { sale: 0, ret: 0, payTotal: 0, pay: {}, payTl: {}, products: [] };
  const pm = new Map();
  for (const t of list) {
    if (t.type === 'sale' || t.type === 'return') {
      if (t.type === 'sale') s.sale += t.total; else s.ret += t.total;
      for (const l of t.lines) {
        const k = l.productId || l.name;
        const cur = pm.get(k) || { name: l.name, qty: 0 };
        cur.qty += (t.type === 'sale' ? 1 : -1) * l.qty;
        pm.set(k, cur);
      }
    } else if (t.type === 'payment') {
      s.payTotal += t.total;
      s.pay[t.method] = (s.pay[t.method] || 0) + t.total;
      if (t.tl) s.payTl[t.method] = (s.payTl[t.method] || 0) + t.tl;
    }
  }
  s.products = [...pm.values()].filter(p => p.qty !== 0).sort((a, b) => a.name.localeCompare(b.name, 'tr'));
  return s;
}
function dailyText(date) {
  const list = state.tx.filter(t => t.date === date).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const s = dailyTotals(list);
  const L = ['*GÜN SONU RAPORU*', fmtDate(date), '', 'Satış: ' + money(s.sale)];
  if (s.ret) L.push('İade: ' + money(s.ret));
  L.push('Tahsilat: ' + money(s.payTotal));
  for (const m of METHODS) if (s.pay[m]) L.push('   ' + METHOD_LABEL[m] + ': ' + money(s.pay[m]) + (s.payTl[m] ? ' / ' + tl(s.payTl[m]) : ''));
  L.push('', '*İşlemler*');
  for (const t of list) {
    const c = custById(t.customerId);
    L.push((c ? c.name : '?') + ' - ' + TYPE_LABEL[t.type] + ': ' + signedMoney(t) + (t.note ? ' (' + t.note + ')' : ''));
  }
  if (s.products.length) { L.push('', '*Satılan ürünler*'); for (const p of s.products) L.push(p.name + ': ' + qtyStr(p.qty) + ' adet'); }
  return L.join('\n');
}

/* ---------------- Ayarlar ---------------- */
function viewSettings() {
  const s = state.settings, m = state.meta;
  const body = `
    <h2 class="sec">Yedekleme</h2>
    <div class="card">
      <div class="sr"><span>Son yedek</span><span class="${needsBackup() ? 'warn' : ''}">${m.lastBackup ? fmtDateTime(m.lastBackup) : 'Hiç alınmadı'}</span></div>
      ${needsBackup() ? '<p class="help warn">Son yedekten sonra yeni kayıtlar var.</p>' : ''}
      <button class="btn primary" data-act="backup">Yedek Al (Excel + yedek dosyası)</button>
      <p class="help">Açılan menüde <b>“Dosyalara Kaydet”</b> → <b>iCloud Drive</b> → <b>Cari Defter</b> klasörünü seçin. Bilgisayarınızda Windows için iCloud kuruluysa dosyalar otomatik olarak bilgisayara iner. Excel dosyası okumak, <b>.json</b> dosyası geri yüklemek içindir.</p>
      <button class="btn outline" data-act="restore">Yedekten Geri Yükle</button>
      <input type="file" id="rf" data-bind="restoreFile" hidden>
    </div>
    <h2 class="sec">Satış</h2>
    <div class="card">
      <label class="switch"><input type="checkbox" ${s.kdvDefault ? 'checked' : ''} data-bind="setKdv"><span class="sl"></span><span>Yeni satışlarda KDV ekli gelsin</span></label>
      <div class="field inline"><label>KDV oranı %</label><input inputmode="decimal" value="${esc(nfq.format(s.kdvRate))}" data-bind="setKdvRate"></div>
    </div>
    <h2 class="sec">Paylaşım</h2>
    <div class="card">
      <div class="field"><label>Fiş ve ekstrelerin altına yazılacak imza</label><input value="${esc(s.signature)}" data-bind="setSig" placeholder="Örn: Ahmet Yılmaz - 0532 000 00 00"></div>
    </div>
    <h2 class="sec">Görünüm</h2>
    <div class="card">
      <label class="switch"><input type="checkbox" ${s.showArchived ? 'checked' : ''} data-bind="setArch"><span class="sl"></span><span>Pasif müşterileri listede göster</span></label>
    </div>
    <h2 class="sec">Veriler</h2>
    <div class="card">
      <div class="sr"><span>Müşteri</span><span>${state.customers.length}</span></div>
      <div class="sr"><span>Ürün</span><span>${state.products.length}</span></div>
      <div class="sr"><span>İşlem</span><span>${state.tx.length}</span></div>
      <div class="sr"><span>Kalıcı depolama</span><span id="persistInfo">…</span></div>
      <button class="btn outline" data-act="go" data-to="trash">Silinen işlemler (${state.trash.length})</button>
      <p class="help warn"><b>Önemli:</b> Ana ekrandaki Cari Defter simgesini silerseniz telefondaki veriler de silinir. Düzenli yedek alın.</p>
      <button class="btn danger-o" data-act="wipe">Tüm verileri sil</button>
    </div>
    <p class="help center">Cari Defter v${APP_VERSION} · Para birimi: Dolar (${CUR})</p>`;
  return {
    html: page({ title: 'Ayarlar', body, tabs: 'settings' }),
    after() {
      const el = $('#persistInfo');
      if (navigator.storage && navigator.storage.persisted) navigator.storage.persisted().then(p => { el.textContent = p ? 'Açık' : 'Tarayıcıya bağlı'; }).catch(() => { el.textContent = '?'; });
      else el.textContent = '?';
    }
  };
}
function viewTrash() {
  const body = state.trash.length ? '<div class="list">' + state.trash.map(t => {
    const c = custById(t.customerId);
    return `<div class="row static"><div class="rl"><div class="rn">${esc(c ? c.name : '(silinmiş müşteri)')}</div>
      <div class="rs">${TYPE_LABEL[t.type]} · ${fmtDate(t.date)} · ${signedMoney(t)}</div><div class="rs">Silinme: ${fmtDateTime(t.deletedAt)}</div></div>
      ${c ? `<button class="btn small outline" data-act="trashRestore" data-id="${t.id}">Geri al</button>` : ''}</div>`;
  }).join('') + '</div>' : '<div class="empty">Silinen işlem yok.</div>';
  return { html: page({ title: 'Silinen İşlemler', back: 'settings', body: body + '<p class="help center">Son 300 silinen işlem saklanır.</p>' }) };
}

/* ---------------- Excel (xlsx) üretici — harici kütüphane yok ---------------- */
const XL = (() => {
  const enc = new TextEncoder();
  const T = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; T[n] = c >>> 0; }
  const crc32 = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = T[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  function zip(files) {
    const parts = [], central = [];
    let off = 0;
    const now = new Date();
    const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    for (const f of files) {
      const nm = enc.encode(f.name), d = enc.encode(f.data), crc = crc32(d);
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
      h.setUint16(10, time, true); h.setUint16(12, date, true); h.setUint32(14, crc, true);
      h.setUint32(18, d.length, true); h.setUint32(22, d.length, true); h.setUint16(26, nm.length, true); h.setUint16(28, 0, true);
      parts.push(new Uint8Array(h.buffer), nm, d);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
      c.setUint16(12, time, true); c.setUint16(14, date, true); c.setUint32(16, crc, true);
      c.setUint32(20, d.length, true); c.setUint32(24, d.length, true); c.setUint16(28, nm.length, true);
      c.setUint32(42, off, true);
      central.push(new Uint8Array(c.buffer), nm);
      off += 30 + nm.length + d.length;
    }
    const cd = central.reduce((s, a) => s + a.length, 0);
    const e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
    e.setUint32(12, cd, true); e.setUint32(16, off, true);
    return new Blob([...parts, ...central, new Uint8Array(e.buffer)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }
  const x = s => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const colName = i => { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
  const serial = s => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d) / 86400000 + 25569; };
  function sheetXml(sh) {
    let rows = '<row r="1">' + sh.cols.map((c, i) => `<c r="${colName(i)}1" t="inlineStr" s="3"><is><t>${x(c.h)}</t></is></c>`).join('') + '</row>';
    sh.rows.forEach((r, ri) => {
      const rn = ri + 2;
      rows += `<row r="${rn}">` + r.map((v, i) => {
        if (v === null || v === undefined || v === '') return '';
        const ref = colName(i) + rn, t = sh.cols[i].t;
        if (t === 'm') return `<c r="${ref}" s="1"><v>${v / 100}</v></c>`;
        if (t === 'd') return `<c r="${ref}" s="2"><v>${serial(v)}</v></c>`;
        if (t === 'n') return `<c r="${ref}"><v>${v}</v></c>`;
        return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${x(v)}</t></is></c>`;
      }).join('') + '</row>';
    });
    const cols = '<cols>' + sh.cols.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.w || 14}" customWidth="1"/>`).join('') + '</cols>';
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>${cols}<sheetData>${rows}</sheetData></worksheet>`;
  }
  function workbook(sheets) {
    const NS = 'http://schemas.openxmlformats.org';
    const files = [
      { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="${NS}/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>` },
      { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${NS}/package/2006/relationships"><Relationship Id="rId1" Type="${NS}/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
      { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${NS}/spreadsheetml/2006/main" xmlns:r="${NS}/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${x(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>` },
      { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${NS}/package/2006/relationships">${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="${NS}/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="${NS}/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
      { name: 'xl/styles.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="${NS}/spreadsheetml/2006/main"><numFmts count="3"><numFmt numFmtId="164" formatCode="#,##0.00"/><numFmt numFmtId="165" formatCode="dd.mm.yyyy"/><numFmt numFmtId="166" formatCode="#,##0.####"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>` }
    ];
    sheets.forEach((s, i) => files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) }));
    return zip(files);
  }
  return { workbook };
})();

function buildXlsx() {
  const bal = balances();
  const cust = [...state.customers].sort(nameCmp);
  const lastDate = new Map();
  for (const t of state.tx) if (!lastDate.has(t.customerId) || lastDate.get(t.customerId) < t.date) lastDate.set(t.customerId, t.date);
  let total = 0;
  const cRows = cust.map(c => { const b = bal.get(c.id) || 0; total += b; return [c.code || '', c.name, c.phone || '', c.address || '', c.note || '', b, lastDate.get(c.id) || '', c.archived ? 'Pasif' : 'Aktif']; });
  cRows.push(['', 'TOPLAM', '', '', '', total, '', '']);
  const hRows = [], dRows = [];
  for (const c of cust) {
    for (const e of ledger(c.id)) {
      const t = e.t, d = delta(t);
      let desc = '';
      if (t.lines) desc = linesSummary(t);
      else if (t.type === 'opening') desc = 'Devir bakiyesi';
      hRows.push([t.date, c.name, TYPE_LABEL[t.type], desc, d > 0 ? d : null, d < 0 ? -d : null, e.after,
        t.type === 'payment' ? (METHOD_LABEL[t.method] || t.method) : '', t.tl || null, t.tl ? Math.round(rate(t) * 10000) / 10000 : null, t.note || '']);
      if (t.lines) for (const l of t.lines) dRows.push([t.date, c.name, TYPE_LABEL[t.type], l.name, l.qty, l.price, l.total, t.kdvRate || null]);
    }
  }
  const pRows = [...state.products].sort(nameCmp).map(p => [p.name, p.price, p.archived ? 'Pasif' : 'Aktif']);
  return XL.workbook([
    { name: 'Cariler', cols: [{ h: 'Kart kodu', w: 14 }, { h: 'Müşteri', w: 32 }, { h: 'Telefon', w: 16 }, { h: 'Adres', w: 30 }, { h: 'Not', w: 24 }, { h: 'Bakiye ($)', t: 'm', w: 16 }, { h: 'Son işlem', t: 'd', w: 12 }, { h: 'Durum', w: 9 }], rows: cRows },
    { name: 'Hareketler', cols: [{ h: 'Tarih', t: 'd', w: 12 }, { h: 'Müşteri', w: 28 }, { h: 'İşlem', w: 10 }, { h: 'Ürünler', w: 44 }, { h: 'Borç ($)', t: 'm', w: 14 }, { h: 'Alacak ($)', t: 'm', w: 14 }, { h: 'Bakiye ($)', t: 'm', w: 14 }, { h: 'Ödeme şekli', w: 18 }, { h: 'Alınan TL', t: 'm', w: 14 }, { h: 'Kur', t: 'n', w: 10 }, { h: 'Açıklama', w: 36 }], rows: hRows },
    { name: 'Satış Detayı', cols: [{ h: 'Tarih', t: 'd', w: 12 }, { h: 'Müşteri', w: 28 }, { h: 'İşlem', w: 10 }, { h: 'Ürün', w: 32 }, { h: 'Adet', t: 'n', w: 9 }, { h: 'Birim fiyat ($)', t: 'm', w: 15 }, { h: 'Tutar ($)', t: 'm', w: 14 }, { h: 'KDV %', t: 'n', w: 8 }], rows: dRows },
    { name: 'Ürünler', cols: [{ h: 'Ürün', w: 36 }, { h: 'Varsayılan fiyat ($)', t: 'm', w: 18 }, { h: 'Durum', w: 9 }], rows: pRows }
  ]);
}

/* ---------------- Yedek al / geri yükle ---------------- */
function stamp() { const d = new Date(); return ymd(d) + '_' + pad(d.getHours()) + pad(d.getMinutes()); }
async function doBackup() {
  const st = stamp();
  const xlsx = buildXlsx();
  const json = new Blob([JSON.stringify({ app: 'cari-defter', format: 1, exportedAt: new Date().toISOString(), state })], { type: 'application/json' });
  const files = [
    new File([xlsx], `CariDefter_${st}.xlsx`, { type: xlsx.type }),
    new File([json], `CariDefter_yedek_${st}.json`, { type: 'application/json' })
  ];
  let ok = false;
  if (navigator.canShare && navigator.canShare({ files })) {
    try { await navigator.share({ files }); ok = true; }
    catch (e) { if (e && e.name === 'AbortError') return; ok = downloadFiles(files); }
  } else ok = downloadFiles(files);
  if (ok) {
    state.meta.lastBackup = Date.now();
    await persist(false);
    toast('Yedek alındı');
    render();
  }
}
function downloadFiles(files) {
  for (const f of files) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(f); a.download = f.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }
  return true;
}
async function restoreFromFile(file) {
  let obj;
  try { obj = JSON.parse(await file.text()); }
  catch (e) { return alertBox('Dosya okunamadı. Doğru yedek dosyasını (<b>.json</b>) seçtiğinizden emin olun.'); }
  const s = obj && obj.app === 'cari-defter' ? obj.state : null;
  if (!s || !Array.isArray(s.customers) || !Array.isArray(s.tx)) return alertBox('Bu dosya geçerli bir Cari Defter yedeği değil.');
  const when = obj.exportedAt ? fmtDateTime(Date.parse(obj.exportedAt)) : '?';
  const ok = await confirmBox(`Yedek tarihi: <b>${esc(when)}</b><br>${s.customers.length} müşteri, ${(s.products || []).length} ürün, ${s.tx.length} işlem.<br><br><b>Telefondaki mevcut verilerin yerine bu yedek yüklenecek.</b> Devam edilsin mi?`, { ok: 'Yükle', danger: true });
  if (!ok) return;
  try { await kvSet('state-before-restore', JSON.stringify(state)); } catch (e) { /* yoksay */ }
  state = normalize(s);
  state.meta.lastChange = Date.now();
  state.meta.lastBackup = state.meta.lastChange;
  await persist(false);
  draft = null;
  toast('Yedek yüklendi');
  replace('');
}

/* ---------------- Modal / bildirim ---------------- */
let modalResolve = null;
function openModal(html, opt = {}) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="mback" data-act="mclose"></div><div class="sheet ${opt.full ? 'full' : ''}">${html}</div>`;
  root.classList.add('open');
  document.body.classList.add('noscroll');
}
function closeModal(silent) {
  const root = $('#modal-root');
  if (!root.classList.contains('open')) return;
  root.classList.remove('open'); root.innerHTML = '';
  document.body.classList.remove('noscroll');
  if (modalResolve) { const r = modalResolve; modalResolve = null; r(false); }
}
function confirmBox(msg, o = {}) {
  return new Promise(res => {
    openModal(`<div class="dlg"><div class="dmsg">${msg}</div><div class="btnrow">
      <button class="btn outline" data-act="mres" data-v="0">${esc(o.cancel || 'Vazgeç')}</button>
      <button class="btn ${o.danger ? 'danger' : 'primary'}" data-act="mres" data-v="1">${esc(o.ok || 'Tamam')}</button></div></div>`);
    modalResolve = res;
  });
}
function alertBox(msg) {
  return new Promise(res => {
    openModal(`<div class="dlg"><div class="dmsg">${msg}</div><button class="btn primary" data-act="mres" data-v="1">Tamam</button></div>`);
    modalResolve = res;
  });
}
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

/* ---------------- Tıklama işlemleri ---------------- */
const actions = {
  go: el => go(el.dataset.to),
  tab: el => { history.replaceState({ d: 0 }, '', '#/' + el.dataset.to); render(); window.scrollTo(0, 0); },
  back: () => back(curBack),
  formback: async () => {
    if (draft && draft.dirty && !(await confirmBox('Kaydedilmemiş bilgiler silinsin mi?', { ok: 'Evet, çık', danger: true }))) return;
    draft = null; back(curBack);
  },
  more: () => { ui.txLimit += 200; render(); },
  backup: () => doBackup(),
  restore: () => $('#rf').click(),
  statement: el => openStatement(el.dataset.id),
  stmRange: el => { ui.stmRange = el.dataset.v; $$('.stm .chip').forEach(b => b.classList.toggle('on', b.dataset.v === ui.stmRange)); $('#stmText').textContent = statementText(ui.stmCid, ui.stmRange); },
  stmWa: () => sendWhatsApp(custById(ui.stmCid).phone, statementText(ui.stmCid, ui.stmRange)),
  stmShare: () => shareText(statementText(ui.stmCid, ui.stmRange)),
  stmCopy: () => copyText(statementText(ui.stmCid, ui.stmRange)),
  mclose: () => closeModal(),
  mres: el => { const r = modalResolve; modalResolve = null; closeModal(); if (r) r(el.dataset.v === '1'); },
  pick: el => openPicker(+el.dataset.i),
  addline: () => openPicker(-1),
  delline: el => { draft.lines.splice(+el.dataset.i, 1); draft.dirty = true; render(); },
  pickp: el => pickProduct(prodById(el.dataset.id)),
  pickadd: async () => {
    const name = ui.pq.trim().replace(/\s+/g, ' ');
    if (!name) return;
    const p = { id: uid(), name, price: null, createdAt: Date.now() };
    state.products.push(p);
    pickProduct(p); // önce senkron: iPhone'da klavyenin adet alanında açılması için
    await persist();
  },
  method: el => { draft.method = el.dataset.v; draft.dirty = true; $$('.seg2 .segb').forEach(b => b.classList.toggle('on', b.dataset.v === draft.method)); },
  saveTx: () => saveTx(),
  delTx: async el => {
    const t = state.tx.find(x => x.id === el.dataset.id);
    if (!t) return;
    if (!(await confirmBox(`Bu ${TYPE_LABEL[t.type].toLocaleLowerCase('tr')} işlemi (${money(Math.abs(t.total))}) silinsin mi?<br><small>Bakiye yeniden hesaplanır. Silinen işlemler Ayarlar › Silinen işlemler bölümünden geri alınabilir.</small>`, { ok: 'Sil', danger: true }))) return;
    state.tx = state.tx.filter(x => x.id !== t.id);
    state.trash.unshift({ ...t, deletedAt: Date.now() });
    state.trash = state.trash.slice(0, 300);
    await persist();
    toast('İşlem silindi');
    back('c/' + t.customerId);
  },
  shareTx: el => shareText(txText(state.tx.find(x => x.id === el.dataset.id))),
  waTx: el => { const t = state.tx.find(x => x.id === el.dataset.id); sendWhatsApp(custById(t.customerId).phone, txText(t)); },
  saveCust: () => saveCust(),
  archiveCust: async () => { const c = custById(routeParts()[1]); if (balanceOf(c.id) !== 0) return; c.archived = true; await persist(); toast('Pasife alındı'); replace(''); },
  unarchiveCust: async () => { const c = custById(routeParts()[1]); c.archived = false; await persist(); toast('Aktif edildi'); back('c/' + c.id); },
  delCust: async () => {
    const c = custById(routeParts()[1]);
    if (state.tx.some(t => t.customerId === c.id)) return;
    if (!(await confirmBox(`“${esc(c.name)}” silinsin mi?`, { ok: 'Sil', danger: true }))) return;
    state.customers = state.customers.filter(x => x.id !== c.id);
    await persist(); toast('Müşteri silindi'); replace('');
  },
  saveProd: () => saveProd(),
  toggleProd: async () => { const p = prodById(routeParts()[1]); p.archived = !p.archived; await persist(); toast(p.archived ? 'Pasife alındı' : 'Aktif edildi'); render(); },
  delProd: async () => {
    const p = prodById(routeParts()[1]);
    if (!(await confirmBox(`“${esc(p.name)}” silinsin mi?`, { ok: 'Sil', danger: true }))) return;
    state.products = state.products.filter(x => x.id !== p.id);
    await persist(); toast('Ürün silindi'); back('products');
  },
  dayGo: el => { history.replaceState({ d: depth() }, '', '#/daily/' + el.dataset.to); render(); },
  dailyShare: el => shareText(dailyText(el.dataset.d)),
  trashRestore: async el => {
    const i = state.trash.findIndex(t => t.id === el.dataset.id);
    if (i < 0) return;
    const t = { ...state.trash[i] }; delete t.deletedAt;
    state.trash.splice(i, 1);
    state.tx.push(t);
    await persist(); toast('İşlem geri alındı'); render();
  },
  wipe: async () => {
    if (!(await confirmBox('<b>Tüm müşteriler, ürünler ve işlemler silinecek.</b><br>Bu işlemden önce yedek aldığınızdan emin olun.', { ok: 'Devam', danger: true }))) return;
    const typed = prompt('Onaylamak için SİL yazın:');
    if (!typed || fold(typed) !== 'sil') return toast('İptal edildi');
    try { await kvSet('state-before-wipe', JSON.stringify(state)); } catch (e) { /* yoksay */ }
    state = emptyState();
    await persist(false);
    draft = null;
    toast('Tüm veriler silindi');
    replace('');
  }
};
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.act];
  if (!fn) return;
  e.preventDefault();
  Promise.resolve(fn(el, e)).catch(err => console.error(err));
});

/* ---------------- Giriş alanları ---------------- */
const binds = {
  cq: el => { ui.cq = el.value; $('#clist').innerHTML = customerListHtml(balances()); },
  sort: async el => { state.settings.sort = el.value; await persist(false); $('#clist').innerHTML = customerListHtml(balances()); },
  prq: el => { ui.prq = el.value; $('#prlist').innerHTML = productListHtml(); },
  pq: el => { ui.pq = el.value; $('#plist').innerHTML = pickerList(); },
  d_date: el => { draft.date = el.value; draft.dirty = true; },
  d_note: el => { draft.note = el.value; draft.dirty = true; },
  d_qty: el => { draft.lines[+el.dataset.i].qty = el.value; draft.dirty = true; refreshSum(); },
  d_price: el => { draft.lines[+el.dataset.i].price = el.value; draft.dirty = true; refreshSum(); },
  d_kdv: el => { draft.kdv = el.checked; draft.dirty = true; $('.kdvrate').classList.toggle('hide', !el.checked); refreshSum(); },
  d_kdvRate: el => { draft.kdvRate = el.value; draft.dirty = true; refreshSum(); },
  d_amount: el => { draft.amount = el.value; draft.dirty = true; refreshSum(); },
  d_tl: el => { draft.tlAmount = el.value; draft.dirty = true; refreshSum(); },
  d_dir: el => { draft.dir = el.value; draft.dirty = true; segRadio(el); refreshSum(); },
  segradio: el => segRadio(el),
  dailyDate: el => { if (el.value) { history.replaceState({ d: depth() }, '', '#/daily/' + el.value); render(); } },
  setKdv: async el => { state.settings.kdvDefault = el.checked; await persist(false); },
  setKdvRate: async el => { const n = parseNum(el.value); if (n >= 0 && n <= 100) { state.settings.kdvRate = n; await persist(false); } },
  setSig: async el => { state.settings.signature = el.value.trim(); await persist(false); },
  setArch: async el => { state.settings.showArchived = el.checked; await persist(false); },
  restoreFile: el => { const f = el.files && el.files[0]; el.value = ''; if (f) restoreFromFile(f); }
};
function segRadio(el) { $$(`input[name="${el.name}"]`).forEach(r => r.parentElement.classList.toggle('on', r.checked)); }
const TEXTY = new Set(['text', 'search', 'tel', 'textarea', '']);
document.addEventListener('input', e => {
  const el = e.target, b = el.dataset && el.dataset.bind;
  if (!b || !binds[b]) return;
  const type = el.tagName === 'TEXTAREA' ? 'textarea' : (el.getAttribute('type') || '');
  if (el.tagName === 'SELECT' || !TEXTY.has(type)) return;
  binds[b](el);
});
document.addEventListener('change', e => {
  const el = e.target, b = el.dataset && el.dataset.bind;
  if (!b || !binds[b]) return;
  const type = el.tagName === 'TEXTAREA' ? 'textarea' : (el.getAttribute('type') || '');
  if (el.tagName !== 'SELECT' && TEXTY.has(type)) return;
  binds[b](el);
});

/* ---------------- Başlangıç ---------------- */
(async function init() {
  try { await loadState(); }
  catch (e) { console.error(e); alertBox('Veriler yüklenirken hata oluştu: ' + esc(e.message || e)); }
  if (!history.state || typeof history.state.d !== 'number') history.replaceState({ d: 0 }, '', location.hash || '#/');
  render();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW', e));
  }
})();
