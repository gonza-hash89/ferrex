/* FERREX v1.3 — WhatsApp + SSE/polling + sonido + PWA + API remota (Netlify) */
let stores = [], products = [], cart = {};
// Base de la API: ?api= > localStorage ga_api > window.GA_API > window.__VITE_API_URL__ > '' (mismo origen)
const API_Q = new URLSearchParams(location.search).get('api');
if (API_Q) { try { localStorage.setItem('ga_api', API_Q.replace(/\/$/, '')); } catch {} }
const ENV_API = (typeof __VITE_API_URL__ !== 'undefined' ? __VITE_API_URL__ : '') || (typeof VITE_API_URL !== 'undefined' ? VITE_API_URL : '');
const API_BASE = (localStorage.getItem('ga_api') || window.GA_API || ENV_API || '').replace(/\/$/, '');
function apiURL(p) { return API_BASE + '/api' + p; }
let activeCat = 'Todo', pay = 'Efectivo';
let storeId = Number(localStorage.getItem('ga_store') || 1);
let soundOn = localStorage.getItem('ga_sound') !== 'off';
let seenOrders = new Set(), es = null, pollTimer = null, audioCtx = null;
const CATS = ['Todo', 'Electricidad', 'Gasfitería', 'Fijaciones', 'Herramientas', 'Pinturas', 'Candados'];
const SHIPPING_COST = 5.00;
const NEXT = { 'Pendiente': ['Aceptado', 'Rechazado'], 'Aceptado': ['En Camino', 'Listo para recojo', 'Completado'], 'En Camino': ['Completado'], 'Listo para recojo': ['Completado'] };
const $ = s => document.querySelector(s);
const money = n => 'S/ ' + Number(n).toFixed(2);

/* ---------- Ubicación híbrida (GPS + manual), persistida ---------- */
const LOC_KEY = 'user_location';
const DISTRICTS = ['Chosica', 'Ate', 'Santa Anita', 'San Juan de Lurigancho', 'Chaclacayo', 'Santa Clara', 'Ricardo Palma', 'Lurigancho'];
function getLoc() { try { return JSON.parse(localStorage.getItem(LOC_KEY) || 'null'); } catch { return null; } }
function setLoc(loc) {
  if (!loc) localStorage.removeItem(LOC_KEY);
  else localStorage.setItem(LOC_KEY, JSON.stringify(loc));
  paintLoc();
}
function locLabel(loc) {
  if (!loc) return null;
  if (loc.mode === 'gps') return `GPS · ${Number(loc.lat).toFixed(3)}, ${Number(loc.lng).toFixed(3)}`;
  return [loc.distrito, loc.ref].filter(Boolean).join(' · ') || loc.distrito;
}
function paintLoc() {
  const loc = getLoc(), lbl = locLabel(loc) || 'Selecciona tu zona';
  const a = $('#locLbl'); if (a) a.textContent = lbl;
  const b = $('#zoneLbl'); if (b) b.textContent = loc ? `📍 ${lbl}` : 'Sin zona — toca para elegir';
  const d = $('#locDistrito'); if (d && loc && loc.distrito) d.value = loc.distrito;
  const r = $('#locRef'); if (r && loc && loc.ref) r.value = loc.ref;
}
function openLoc() { paintLoc(); openModal('locModal'); }
function useGPS() {
  if (!('geolocation' in navigator)) { toast('Tu equipo no soporta GPS, elige tu distrito 👇'); $('#locDistrito')?.focus(); return; }
  const btn = $('#gpsBtn'); btn.disabled = true; btn.textContent = '📡 Obteniendo ubicación…';
  navigator.geolocation.getCurrentPosition(
    async pos => {
      btn.disabled = false; btn.textContent = '🎯 Usar mi ubicación actual (GPS)';
      setLoc({ mode: 'gps', lat: +pos.coords.latitude.toFixed(6), lng: +pos.coords.longitude.toFixed(6), label: `${pos.coords.latitude.toFixed(3)}, ${pos.coords.longitude.toFixed(3)}` });
      closeModal('locModal'); toast('Ubicación GPS lista 📍'); await loadStores();
      // Auto-selección: la primera ya viene ordenada por distancia (Haversine)
      const near = stores[0];
      if (near) {
        storeId = near.id;
        try { localStorage.setItem('ga_store', storeId); } catch {}
        $('#storeSel').value = storeId; window._all = null; metaForStore(near); await loadProducts();
        toast(`Cercana: ${near.nombre}${near.distance_km != null ? ` (a ${near.distance_km} km)` : ''} ✅`);
      }
    },
    err => {
      btn.disabled = false; btn.textContent = '🎯 Usar mi ubicación actual (GPS)';
      toast('No pudimos obtener tu ubicación GPS, elige tu distrito manualmente 👇');
      $('#locDistrito')?.focus();
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 300000 }
  );
}
function saveManualLoc() {
  const distrito = $('#locDistrito').value, ref = $('#locRef').value.trim();
  if (!distrito) { toast('Elige tu distrito primero'); $('#locDistrito').focus(); return; }
  setLoc({ mode: 'manual', distrito, ref, label: [distrito, ref].filter(Boolean).join(' · ') });
  closeModal('locModal'); toast(`Zona: ${distrito} ✅`); loadStores();
}
function clearLoc() { setLoc(null); closeModal('locModal'); loadStores(); }
const PLACEHOLDER = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#eef1f4"/><text x="200" y="160" text-anchor="middle" font-size="60">🔩</text></svg>');
function imgFallback(el) { el.onerror = null; el.src = PLACEHOLDER; }
function absImg(u) { if (!u) return u; return u.startsWith('/') ? API_BASE + u : u; }
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.remove('hidden'); setTimeout(() => t.classList.add('hidden'), 2200); }
function openModal(id) { $('#' + id).classList.remove('hidden'); }
function closeModal(id) { $('#' + id).classList.add('hidden'); }
function unlockAudio() { try { if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)(); if (audioCtx.state === 'suspended') audioCtx.resume(); } catch {} }
document.addEventListener('pointerdown', unlockAudio, { once: true });

async function api(path, opts = {}) {
  const r = await fetch(apiURL(path), opts);
  let j = null; try { j = await r.json(); } catch { throw new Error('Respuesta inválida del servidor'); }
  if (!r.ok || j.ok === false) throw new Error(j.error || ('Error ' + r.status));
  return j;
}
function configAPI() {
  const cur = localStorage.getItem('ga_api') || '';
  const v = prompt('URL del backend (Render/Railway). Vacío = mismo origen.\nEj: https://ga-casero.onrender.com', cur);
  if (v === null) return;
  try {
    if (!v.trim()) localStorage.removeItem('ga_api');
    else localStorage.setItem('ga_api', v.trim().replace(/\/$/, ''));
  } catch {}
  location.reload();
}

/* ---------- Legal: cookies, consentimiento y Libro de Reclamaciones ---------- */
function initLegal() {
  try { if (!localStorage.getItem('ga_cookie')) $('#cookieBar').classList.remove('hidden'); } catch {}
  const y = $('#year'); if (y) y.textContent = new Date().getFullYear();
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    for (const id of ['locModal', 'loginModal', 'storeModal', 'prodModal', 'privModal', 'termModal', 'devModal', 'libroModal']) {
      if (!$('#' + id)?.classList.contains('hidden')) { closeModal(id); break; }
    }
  });
}
function acceptCookies() {
  try { localStorage.setItem('ga_cookie', '1'); } catch {}
  $('#cookieBar').classList.add('hidden'); toast('Preferencias guardadas 🍪');
}
async function sendReclamo(e) {
  e.preventDefault();
  const tel = $('#recTel').value.trim();
  if (!/^9\d{8}$/.test(tel)) { toast('Celular inválido (9 dígitos)'); return; }
  const code = 'LR-' + Date.now().toString().slice(-6);
  const rec = { code, nombre: $('#recNom').value.trim(), tel, pedido: $('#recPed').value.trim(), tipo: $('#recTipo').value, msg: $('#recMsg').value.trim(), fecha: new Date().toISOString() };
  try {
    const arr = JSON.parse(localStorage.getItem('ga_reclamos') || '[]'); arr.push(rec);
    localStorage.setItem('ga_reclamos', JSON.stringify(arr));
  } catch {}
  const s = myStore() || stores[0];
  const txt = `📕 LIBRO DE RECLAMACIONES ${code}\n${rec.tipo} de ${rec.nombre} (${rec.tel})\nPedido: ${rec.pedido || '-'}\n${rec.msg}`;
  $('#recOk').textContent = `Registrado con código ${code} ✅`; $('#recOk').classList.remove('hidden');
  if (s?.whatsapp) window.open(`https://wa.me/${s.whatsapp}?text=${encodeURIComponent(txt)}`, '_blank');
  toast(`Reclamo ${code} registrado`);
}
/* ---------- init ---------- */
function slugEq(a, b) {  const s = x => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s(a) === s(b);
}
// Deep links SEO: /distrito/:slug preselecciona zona, /tienda/:id(-slug) o /ferreteria/:id elige tienda
function handleDeepLink(extraDistritos = []) {
  const legal = location.pathname.match(/^\/(privacidad|terminos|devoluciones|libro)/);
  if (legal) {
    openModal({ privacidad: 'privModal', terminos: 'termModal', devoluciones: 'devModal', libro: 'libroModal' }[legal[1]]);
    return;
  }
  const m = location.pathname.match(/^\/(distrito|tienda|ferreteria)\/([^/]+)/);
  if (!m) return;
  if (m[1] === 'distrito') {
    if (getLoc()?.mode === 'gps') return; // el GPS manda
    const all = [...new Set([...DISTRICTS, ...extraDistritos])];
    const hit = all.find(d => slugEq(d, decodeURIComponent(m[2])));
    if (hit) {
      try { localStorage.setItem(LOC_KEY, JSON.stringify({ mode: 'manual', distrito: hit, ref: '', label: hit })); } catch {}
      paintLoc();
      updateMeta(`Ferreterías en ${hit} | FERREX`,
        `Encuentra accesorios ferreteros con delivery o recojo inmediato en el distrito de ${hit}.`);
    }
  } else {
    const id = Number(String(m[2]).split('-')[0]);
    if (Number.isInteger(id) && id > 0) { storeId = id; try { localStorage.setItem('ga_store', id); } catch {} }
  }
}
async function init() {
  paintSoundBtn(); paintLoc(); handleDeepLink(); initLegal();
  try {
    const h = await api('/health');
    $('#apiStat').innerHTML = `● API conectada v${h.version || ''} · ${API_BASE ? esc(API_BASE) : 'mismo origen'} · <button onclick="configAPI()" class="underline">⚙️ cambiar backend</button>`;
    $('#apiStat').className = 'text-center text-[11px] py-1 bg-listo text-plomoDark';
  } catch { $('#apiStat').innerHTML = '✕ API inalcanzable — <button onclick="configAPI()" class="underline">⚙️ configura el backend</button> o en local: npm start'; }
  await loadStores(); await loadProducts();
  const before = JSON.stringify(getLoc());
  handleDeepLink(stores.map(s => s.distrito).filter(Boolean)); // 2da pasada con distritos de DB
  if (JSON.stringify(getLoc()) !== before) { await loadStores(); await loadProducts(); }
  if (/^\/(tienda|ferreteria)\//.test(location.pathname)) metaForStore(stores.find(s => s.id === storeId));
  if (location.pathname.startsWith('/catalogo')) document.getElementById('grid')?.scrollIntoView();
  $('#storeForm [name=logo]').addEventListener('change', e => {
    const f = e.target.files[0]; if (!f) return;
    if (f.size > 5 * 1024 * 1024) { toast('Logo > 5MB, elige otra imagen'); e.target.value = ''; return; }
    $('#logoPrev').src = URL.createObjectURL(f); $('#logoPrev').classList.remove('hidden');
  });
  $('#prodForm [name=foto]').addEventListener('change', e => {
    const f = e.target.files[0]; if (!f) return;
    if (f.size > 5 * 1024 * 1024) { toast('Foto > 5MB, elige otra'); e.target.value = ''; return; }
    $('#fotoPrev').src = URL.createObjectURL(f); $('#fotoPrev').classList.remove('hidden');
  });
}
function setMode(m) {
  const c = m === 'c';
  $('#vCli').classList.toggle('active', c); $('#vFer').classList.toggle('active', !c);
  $('#bCli').className = 'px-3 py-1.5 rounded-lg ' + (c ? 'bg-cinta text-plomo' : '');
  $('#bFer').className = 'px-3 py-1.5 rounded-lg ' + (!c ? 'bg-cinta text-plomo' : '');
  if (!c) { loadOrders(); startRealtime(); } else stopRealtime();
}
function ftab(t) {
  $('#fPed').classList.toggle('hidden', t !== 'ped');
  $('#fStk').classList.toggle('hidden', t !== 'stk');
  if (t === 'ped') loadOrders(); if (t === 'stk') renderStock();
}
function setPay(p) {
  pay = p;
  document.querySelectorAll('.pay').forEach(b => { const on = b.textContent === p; b.className = 'pay rounded-xl py-2 ' + (on ? 'bg-plomo text-white' : 'bg-gray-100'); });
}

/* ---------- tiendas (filtradas por zona) ---------- */
async function loadStores() {
  const loc = getLoc();
  let qs = '';
  if (loc && loc.mode === 'gps' && Number.isFinite(loc.lat) && Number.isFinite(loc.lng)) qs = `?lat=${loc.lat}&lng=${loc.lng}`;
  else if (loc && loc.mode === 'manual' && loc.distrito) qs = `?distrito=${encodeURIComponent(loc.distrito)}`;
  stores = await api('/stores' + qs);
  if (!stores.length) { toast(`Sin ferreterías en ${loc?.distrito || 'tu zona'} — mostrando todas`); stores = await api('/stores'); }
  if (!stores.find(s => s.id === storeId)) { storeId = stores[0]?.id || 1; localStorage.setItem('ga_store', storeId); }
  $('#storeSel').innerHTML = stores.map(s => {
    const d = s.distance_km != null ? ` · a ${s.distance_km} km (~${s.eta_min} min)` : '';
    const st = s.abierto_ahora === false ? ' · 🔴 Cerrado' : '';
    return `<option value="${s.id}" ${s.id === storeId ? 'selected' : ''}>${esc(s.nombre)} · ${esc(s.distrito)}${d}${st}</option>`;
  }).join('');
  paintSession();
  window._all = null; loadProducts();
}
function onStoreChange() { storeId = Number($('#storeSel').value); localStorage.setItem('ga_store', storeId); window._all = null; metaForStore(stores.find(s => s.id === storeId)); loadProducts(); if ($('#vFer').classList.contains('active')) { loadOrders(); startRealtime(); } }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
/* ---------- Sesión ferretera (JWT en memoria + refresh httpOnly) ---------- */
// El refresh vive en cookie httpOnly (inaccesible a JS/XSS); el access de 15 min
// solo vive en memoria y se renueva solo. Nada de tokens en localStorage.
let AT = null;
try { localStorage.removeItem('ga_token'); } catch {} // migración: revoca token opaco legacy
function authHeaders(extra = {}) {
  return AT ? { ...extra, 'Authorization': 'Bearer ' + AT } : extra;
}
function needAuth(fn) {
  if (!AT) { toast('Inicia sesión como ferretería 🔐'); openModal('loginModal'); return; }
  fn();
}
async function tryRefresh() {
  const r = await fetch(apiURL('/auth/refresh'), { method: 'POST', credentials: 'include' });
  if (!r.ok) return false;
  const j = await r.json().catch(() => ({}));
  if (!j.accessToken) return false;
  AT = j.accessToken;
  return true;
}
async function apiAuth(path, method, body, retried) {
  try {
    return await api(path, { method, headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) });
  } catch (e) {
    if (/sesi|401|Inicia sesión|vencida/i.test(e.message) && !retried) {
      if (await tryRefresh()) return apiAuth(path, method, body, true);
    }
    if (/sesi|401|Inicia sesión|vencida/i.test(e.message)) { AT = null; paintSession(); openModal('loginModal'); }
    throw e;
  }
}
async function login(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    const r = await fetch(apiURL('/auth/login'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ identifier: fd.get('identifier'), password: fd.get('password') }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ('Error ' + r.status));
    AT = j.accessToken;
    storeId = j.store.id; localStorage.setItem('ga_store', storeId);
    closeModal('loginModal'); e.target.reset();
    await loadStores(); paintSession(); setMode('f');
    toast(`Bienvenido, ${j.store.nombre} ✅`);
  } catch (err) { toast(err.message); }
}
async function logout() {
  try { await fetch(apiURL('/auth/logout'), { method: 'POST', credentials: 'include' }); } catch {}
  AT = null; paintSession(); toast('Sesión cerrada');
}
function myStore() { return stores.find(s => s.id === storeId); }
function paintSession() {
  const on = !!AT;
  $('#sesBar')?.classList.toggle('hidden', !on);
  $('#noSes')?.classList.toggle('hidden', on);
  const s = myStore();
  if (on && s) {
    $('#sesName').textContent = s.nombre;
    $('#sesHora').textContent = `${s.horario_txt || ''} · ${s.abierto_ahora ? '● Abierto ahora' : '● Cerrado ahora'}`;
    paintSchedule(s);
  }
}
const DIAS_LBL = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
function paintSchedule(s) {
  if (!s?.horario) return;
  $('#hApe').value = s.horario.apertura || '08:00';
  $('#hCie').value = s.horario.cierre || '20:00';
  $('#hOpen').checked = s.abierto !== false;
  $('#myDias').innerHTML = [1, 2, 3, 4, 5, 6, 0].map(d =>
    `<label class="text-[11px] rounded-lg px-2 py-1 cursor-pointer ${s.horario.dias.includes(d) ? 'bg-plomo text-white' : 'bg-gray-100'}"><input type="checkbox" value="${d}" ${s.horario.dias.includes(d) ? 'checked' : ''}> ${DIAS_LBL[d]}</label>`).join('');
  const st = $('#myState');
  st.textContent = s.abierto_ahora ? '● Abierto ahora' : '● Cerrado ahora';
  st.className = 'text-xs font-bold px-2 py-0.5 rounded-full ' + (s.abierto_ahora ? 'bg-listo text-plomoDark' : 'bg-etiqueta text-white');
  $('#myHoraTxt').textContent = s.horario_txt || '';
}
async function saveSchedule() {
  const dias = [...document.querySelectorAll('#myDias input:checked')].map(i => Number(i.value));
  try {
    const s = await apiAuth(`/stores/${storeId}`, 'PATCH', {
      abierto: $('#hOpen').checked,
      horario: { apertura: $('#hApe').value, cierre: $('#hCie').value, dias }
    });
    const i = stores.findIndex(x => x.id === s.id); if (i >= 0) stores[i] = s;
    paintSession(); toast('Horario guardado ✅');
  } catch (e) { toast(e.message); }
}
/* SEO dinámico: título + descripción según distrito / tienda (deep links) */
function updateMeta(title, desc) {
  if (title) document.title = title;
  if (desc) {
    const m = document.querySelector('meta[name="description"]');
    if (m) m.setAttribute('content', desc);
    const og = document.querySelector('meta[property="og:description"]');
    if (og) og.setAttribute('content', desc);
  }
}
function metaForStore(s) {
  if (!s) return;
  updateMeta(`${s.nombre} - Catálogo y Pedidos | FERREX`,
    `Pide en ${s.nombre} (${s.distrito}): accesorios ferreteros con delivery exprés o recojo gratis.`);
}
async function saveStore(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  fd.append('dias', JSON.stringify([...e.target.querySelectorAll('#regDias input:checked')].map(i => Number(i.value))));
  try {
    const r = await fetch(apiURL('/stores'), { method: 'POST', body: fd, credentials: 'include' });
    const s = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(s.error || ('Error ' + r.status));
    if (s.accessToken) AT = s.accessToken;
    toast('Ferretería creada y sesión iniciada ✅'); closeModal('storeModal'); e.target.reset(); $('#logoPrev').classList.add('hidden');
    await loadStores(); storeId = s.id; localStorage.setItem('ga_store', s.id); $('#storeSel').value = s.id;
    paintSession(); setMode('f'); loadProducts();
  } catch (err) { toast(err.message); }
}

/* ---------- catálogo ---------- */
async function loadProducts() {
  const q = $('#q').value || '';
  products = await api(`/products?store_id=${storeId}&q=${encodeURIComponent(q)}${activeCat !== 'Todo' ? '&cat=' + encodeURIComponent(activeCat) : ''}`);
  $('#cats').innerHTML = CATS.map(c => `<button onclick="activeCat='${c}';loadProducts()" class="whitespace-nowrap px-4 py-2 rounded-full text-xs font-bold border ${activeCat === c ? 'bg-plomo text-white' : 'bg-white'}">${c}</button>`).join('');
  $('#grid').innerHTML = products.filter(p => p.stock).map(p => `
    <div class="bg-white rounded-2xl shadow p-3">
      ${p.foto_url ? `<img src="${absImg(p.foto_url)}" alt="${esc(p.nombre)}" class="w-full h-40 object-cover rounded-xl" loading="lazy" onerror="imgFallback(this)">`
        : `<div class="text-5xl text-center bg-cemento rounded-xl py-8">${p.emoji || '📦'}</div>`}
      <p class="text-[11px] text-gray-400 font-bold mt-2">${esc(p.categoria)}</p>
      <h3 class="font-extrabold text-sm leading-tight">${esc(p.nombre)}</h3>
      <span class="price-tag text-sm mt-1">${money(p.precio)}</span>
      <button onclick="addCart(${p.id})" class="w-full mt-2 bg-cinta text-plomo font-extrabold py-2 rounded-xl text-sm">Agregar al carrito</button>
    </div>`).join('') || '<p class="text-gray-400 col-span-3 text-center py-8">Sin productos. La ferretería puede subir fotos con “Agregar producto”.</p>';
  renderCart(); renderStock();
}
function addCart(id) { cart[id] = (cart[id] || 0) + 1; renderCart(); toast('Agregado ✓'); }
function totals() {
  let s = 0, n = 0;
  const all = [...products, ...(window._all || [])];
  for (const [id, q] of Object.entries(cart)) { const p = all.find(x => x.id == id); if (p) { s += p.precio * q; n += q; } }
  const del = document.querySelector('input[name=del]:checked')?.value !== 'recojo';
  const ship = n === 0 ? 0 : (del ? SHIPPING_COST : 0);
  return { sub: s, n, ship, total: s + ship, del };
}
async function renderCart() {
  if (!window._all) { try { window._all = await api(`/products?store_id=${storeId}`); } catch { window._all = products; } }
  const t = totals();
  $('#cartN').textContent = t.n;
  const all = [...products, ...(window._all || [])];
  $('#cartBox').innerHTML = t.n === 0 ? '<p class="text-gray-400 text-center">Vacío</p>' :
    Object.entries(cart).map(([id, q]) => { const p = all.find(x => x.id == id); if (!p) return '';
      return `<div class="flex justify-between items-center bg-cemento rounded-xl p-2"><span><b>${q}×</b> ${esc(p.nombre)}</span><b class="text-etiqueta">${money(p.precio * q)}</b></div>`; }).join('');
  $('#subT').textContent = money(t.sub);
  $('#shT').textContent = t.n === 0 ? '—' : (t.del ? `${money(SHIPPING_COST)}` : 'Gratis (recojo en tienda)');
  $('#toT').textContent = money(t.total);
}

/* ---------- 1. Checkout + WhatsApp ---------- */
function currentStore() { return stores.find(s => s.id === storeId); }
async function sendOrder() {
  const t = totals();
  if (t.n === 0) { toast('Carrito vacío 🛒'); return; }
  if (!$('#consent')?.checked) { toast('Aceptá las Políticas y Términos para confirmar ☑️'); $('#consent')?.focus(); return; }
  const all = [...products, ...(window._all || [])];
  const items = Object.entries(cart).map(([id, q]) => { const p = all.find(x => x.id == id); return { product_id: Number(id), nombre: p?.nombre || 'Producto', qty: q, price: p?.precio || 0 }; });
  const body = {
    store_id: storeId, items, total: t.total, pay,
    address: $('#addr').value.trim(),
    pickupName: $('#pickupName').value.trim(),
    delivery: t.del ? 'delivery' : 'recojo',
    clientZone: getLoc()
  };
  const btn = $('#sendBtn'); btn.disabled = true; btn.textContent = 'Confirmando…';
  try {
    const o = await api('/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    cart = {}; renderCart();
    // Mostrar bloque WhatsApp con enlace generado por el backend (número real de la tienda)
    $('#orderOk').classList.remove('hidden');
    $('#okCode').textContent = `Pedido ${o.code}`;
    const zl = o.clientZone && (o.clientZone.label || o.clientZone.distrito) ? ` · 📌 ${o.clientZone.label || o.clientZone.distrito}` : '';
    const shipText = o.delivery === 'delivery' ? `Envío S/ ${SHIPPING_COST.toFixed(2)}` : 'Recojo en tienda (gratis)';
    $('#okTxt').textContent = `${o.items.length} productos · ${shipText} · ${o.pay} · Subtotal ${money(o.total - (o.delivery === 'delivery' ? SHIPPING_COST : 0))} · Total ${money(o.total)}${zl}`;
    const a = $('#waCta');
    if (o.whatsapp_url) { a.href = o.whatsapp_url; a.classList.remove('hidden'); window.open(o.whatsapp_url, '_blank'); }
    else { a.classList.add('hidden'); toast('Pedido guardado, pero la tienda no tiene WhatsApp registrado'); }
    window._lastWa = o.whatsapp_message || '';
    toast(`Pedido ${o.code} en Pendiente 🎉`);
  } catch (e) { toast(e.message); }
  finally { btn.disabled = false; btn.textContent = 'Confirmar pedido por WhatsApp →'; }
}
function copyWa() { navigator.clipboard?.writeText(window._lastWa || '').then(() => toast('Mensaje copiado 📋')).catch(() => toast('No se pudo copiar')); }

/* ---------- ferretería: stock ---------- */
async function saveProduct(e) {
  e.preventDefault();
  if (!AT) { closeModal('prodModal'); needAuth(() => openModal('prodModal')); return; }
  const fd = new FormData(e.target); fd.append('store_id', storeId);
  try {
    const r = await fetch(apiURL('/products'), { method: 'POST', headers: authHeaders(), body: fd });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ('Error ' + r.status));
    toast('Producto publicado ✅'); closeModal('prodModal'); e.target.reset(); $('#fotoPrev').classList.add('hidden');
    window._all = null; loadProducts();
  } catch (err) {
    if (/sesi|401|Inicia sesión|vencida/i.test(err.message)) { AT = null; paintSession(); openModal('loginModal'); }
    toast(err.message);
  }
}
async function toggleStock(id, val) {
  try { await apiAuth(`/products/${id}`, 'PATCH', { stock: val }); window._all = null; loadProducts(); }
  catch (e) { toast(e.message); }
}
async function delProduct(id) {
  if (!confirm('¿Eliminar producto y su foto?')) return;
  try { await api(`/products/${id}`, { method: 'DELETE', headers: authHeaders() }); window._all = null; loadProducts(); }
  catch (e) {
    if (/sesi|401|Inicia sesión|vencida/i.test(e.message)) { AT = null; paintSession(); openModal('loginModal'); }
    toast(e.message);
  }
}
function renderStock() {
  const list = window._all || products;
  $('#fStk').innerHTML = list.map(p => `<div class="flex items-center gap-3 p-3">
    ${p.foto_url ? `<img src="${absImg(p.foto_url)}" alt="Foto de ${esc(p.nombre)}" class="w-12 h-12 object-cover rounded-xl" loading="lazy" onerror="imgFallback(this)">` : `<span class="text-2xl">${p.emoji || '📦'}</span>`}
    <div class="flex-1"><b class="text-sm">${esc(p.nombre)}</b> <span class="price-tag text-xs">${money(p.precio)}</span></div>
    <button onclick="toggleStock(${p.id},${!p.stock})" class="text-xs font-black px-3 py-2 rounded-full ${p.stock ? 'bg-listo text-plomoDark' : 'bg-etiqueta text-white'}">${p.stock ? 'HAY ✓' : 'SIN STOCK'}</button>
    <button onclick="delProduct(${p.id})" class="text-xs px-2" aria-label="Eliminar">🗑️</button></div>`).join('');
}

/* ---------- 2. Tiempo real: SSE + polling + sonido ---------- */
function paintSoundBtn() { $('#sndBtn').textContent = soundOn ? '🔔 Sonido ON' : '🔕 Sonido OFF'; }
function toggleSound() { soundOn = !soundOn; localStorage.setItem('ga_sound', soundOn ? 'on' : 'off'); paintSoundBtn(); if (soundOn) beep(); }
function beep() {
  if (!soundOn) return;
  try {
    unlockAudio();
    const ctx = audioCtx || (audioCtx = new (window.AudioContext || window.webkitAudioContext)());
    [0, 0.28].forEach((off, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = i === 0 ? 880 : 1174;
      g.gain.setValueAtTime(0.001, ctx.currentTime + off);
      g.gain.exponentialRampToValueAtTime(0.4, ctx.currentTime + off + 0.03);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + off + 0.25);
      o.connect(g).connect(ctx.destination); o.start(ctx.currentTime + off); o.stop(ctx.currentTime + off + 0.3);
    });
  } catch {}
}
function ssePill(txt, cls) { const p = $('#ssePill'); p.textContent = txt; p.className = 'text-[11px] font-bold px-3 py-1.5 rounded-full ' + cls; }
function startRealtime() {
  stopRealtime();
  // Marcar vistos actuales para no sonar por historial
  api(`/orders?store_id=${storeId}`).then(l => l.forEach(o => seenOrders.add(o.id))).catch(() => {});
  try {
    es = new EventSource(apiURL(`/orders/stream?store_id=${storeId}`));
    es.addEventListener('hello', () => ssePill('● en vivo (SSE)', 'bg-listo text-plomoDark'));
    es.addEventListener('order', e => {
      const o = JSON.parse(e.data);
      if (o.status === 'Pendiente' && !seenOrders.has(o.id)) { seenOrders.add(o.id); beep(); toast(`🔔 Nuevo pedido ${o.code}`); }
      loadOrders(true);
    });
    es.onerror = () => ssePill('● reconectando…', 'bg-cinta');
  } catch { ssePill('● modo polling', 'bg-gray-200'); }
  // Polling de respaldo cada 8s
  pollTimer = setInterval(async () => {
    try {
      const list = await api(`/orders?store_id=${storeId}&status=Pendiente`);
      let fresh = false;
      for (const o of list) if (!seenOrders.has(o.id)) { seenOrders.add(o.id); fresh = true; }
      if (fresh) { beep(); toast('🔔 Pedido nuevo en Pendiente'); loadOrders(true); }
    } catch {}
  }, 8000);
}
function stopRealtime() { try { es?.close(); } catch {} es = null; clearInterval(pollTimer); pollTimer = null; }

const ST_CLS = { 'Pendiente': 'bg-cinta', 'Aceptado': 'bg-plomo text-white', 'En Camino': 'bg-blue-800 text-white', 'Listo para recojo': 'bg-blue-800 text-white', 'Completado': 'bg-listo text-plomoDark', 'Rechazado': 'bg-gray-300' };
async function loadOrders(keepSeen) {
  try {
    const list = await api(`/orders?store_id=${storeId}`);
    if (!keepSeen) list.forEach(o => { if (o.status !== 'Pendiente') seenOrders.add(o.id); });
    $('#fPed').innerHTML = list.map(o => `
      <div class="bg-white rounded-2xl shadow p-4 ${o.status === 'Pendiente' ? 'order-new' : ''}">
        <div class="flex justify-between items-center"><b>${esc(o.code)}</b>
          <span class="text-xs font-black px-2 py-1 rounded-full ${ST_CLS[o.status] || 'bg-gray-200'}">${esc(o.status)}</span></div>
        <p class="text-[11px] text-gray-400">${new Date(o.created_at).toLocaleString('es-PE')}</p>
        <p class="text-sm mt-1">${o.items.map(i => `${i.qty}× ${esc(i.nombre)}`).join(', ')}</p>
        <p class="text-xs text-gray-500">${money(o.total)} · ${esc(o.pay)} · ${o.delivery === 'delivery' ? '🛵 ' + esc(o.address) : '🏃 Recojo · ' + esc(o.pickupName || o.address || '')}</p>
        ${o.clientZone && (o.clientZone.label || o.clientZone.distrito) ? `<p class="text-xs font-bold text-plomo">📌 Zona: ${esc(o.clientZone.label || o.clientZone.distrito)}${o.clientZone.mode === 'gps' ? ' (GPS)' : ''}</p>` : ''}
        <div class="flex gap-2 mt-2 flex-wrap">${(NEXT[o.status] || []).map(n => {
          const hot = (o.status === 'Pendiente' && n === 'Aceptado') || (o.status === 'Aceptado');
          return `<button onclick="setOrder(${o.id},'${n}')" class="text-xs font-extrabold px-3 py-2 rounded-xl ${hot ? 'bg-listo text-plomoDark' : 'bg-gray-100'}">${n}</button>`;
        }).join('')}</div>
      </div>`).join('') || '<p class="text-gray-400">Sin pedidos aún.</p>';
  } catch { $('#fPed').innerHTML = '<p class="text-gray-400">Enciende el backend para ver pedidos.</p>'; }
}
async function setOrder(id, st) {
  try { await apiAuth(`/orders/${id}`, 'PATCH', { status: st }); loadOrders(true); toast(`Pedido → ${st}`); }
  catch (e) { toast(e.message); }
}

init();
