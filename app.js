/* FERREX v1.5 — WhatsApp + SSE/polling + sonido + PWA + API remota (Netlify) */
let stores = [], products = [], cart = {};
let isInventoryOpen = false; // Track inventory modal state
// Base de la API: ?api= > localStorage ga_api > window.GA_API > window.__VITE_API_URL__ > '' (mismo origen, ideal con Render)
const API_Q = new URLSearchParams(location.search).get('api');
if (API_Q) { try { localStorage.setItem('ga_api', API_Q.replace(/\/$/, '')); } catch {} }
// Desactivar modo demo cuando hay una ferretería seleccionada
localStorage.removeItem('ga_demo_mode');
const ENV_API = (typeof __VITE_API_URL__ !== 'undefined' ? __VITE_API_URL__ : '') || (typeof VITE_API_URL !== 'undefined' ? VITE_API_URL : '');
const API_BASE = (localStorage.getItem('ga_api') || window.GA_API || ENV_API || 'https://ferrex-vdex.onrender.com').replace(/\/$/, '');
function apiURL(p) { return API_BASE + '/api' + p; }
let activeCat = 'Todo', pay = 'Efectivo';
let shipMode = 'delivery'; // 'delivery' | 'recojo' (entrega a pie / retiro en tienda)
let storeId = localStorage.getItem('ga_store') || 1;
let storesApiOk = true; // false cuando la API de tiendas no respondió tras los reintentos
let soundOn = localStorage.getItem('ga_sound') !== 'off';
let seenOrders = new Set(), es = null, pollTimer = null, audioCtx = null;
const CATS = ['Todo', 'Electricidad', 'Gasfitería', 'Fijaciones', 'Herramientas', 'Pinturas', 'Candados'];
const SHIPPING_RATE = 0.15; // 15% del subtotal, solo en delivery
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const round2 = n => Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100; // redondeo monetario a 2 decimales
const NEXT = { 'Pendiente': ['Aceptado', 'Rechazado'], 'Aceptado': ['En Camino', 'Listo para recojo', 'Completado'], 'En Camino': ['Completado'], 'Listo para recojo': ['Completado'] };
const $ = s => document.querySelector(s);
const money = n => 'S/ ' + Number(n).toFixed(2);
function priceHtml(p, cls = '') {
  const base = Number(p?.precio) || 0;
  const offer = Number(p?.precio_oferta) || 0;
  const hasOffer = offer > 0 && offer < base;
  return `<span class="flex items-baseline gap-2 ${cls}">
    <span class="price-tag text-sm">${money(hasOffer ? offer : base)}</span>
    ${hasOffer ? `<span class="text-xs line-through text-ferrex-text-muted">${money(base)}</span>` : ''}
  </span>`;
}

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
window.openLoc = openLoc; // Exponer en global scope para onclick inline
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
function previewImage(input) {
  const file = input.files?.[0];
  // El formulario de inventario usa #invFotoPrev; el de producto usa #fotoPrev
  const preview = input.form?.id === 'newProductForm' ? $('#invFotoPrev') : $('#fotoPrev');
  if (!preview) return;
  if (!file) { preview.classList.add('hidden'); preview.src = ''; return; }
  if (file.size > 5 * 1024 * 1024) { toast('Imagen > 5MB, elija otra'); input.value = ''; preview.classList.add('hidden'); return; }
  const reader = new FileReader();
  reader.onload = e => { preview.src = e.target.result; preview.classList.remove('hidden'); };
  reader.onerror = () => toast('No se pudo leer la imagen');
  reader.readAsDataURL(file);
}
function absImg(u) { if (!u) return u; return u.startsWith('/') ? API_BASE + u : u; }
function toast(m) { const t = $('#toast'); if (!t) { console.log('[toast]', m); return; } t.textContent = m; t.classList.remove('hidden'); t.classList.add('show'); setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.classList.add('hidden'), 300); }, 2200); }
function openModal(id) { 
  const el = $('#' + id); 
  if (el) { 
    el.classList.remove('hidden'); 
    el.style.display = 'flex'; 
    document.body.style.overflow = 'hidden'; 
  } 
}
window.openModal = openModal; // Exponer en global scope para onclick inline

function closeModal(id) { 
  const el = $('#' + id); 
  if (el) { 
    el.classList.add('hidden'); 
    el.style.display = 'none'; 
    document.body.style.overflow = ''; 
    document.body.style.scrollBehavior = ''; 
  } 
}

// Close modal on overlay click
document.addEventListener('click', e => {
  if (e.target.classList.contains('modal-overlay') || e.target.matches('[data-close-modal]')) {
    const modal = e.target.closest('.modal');
    if (modal) closeModal(modal.id);
  }
});
function unlockAudio() { try { if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)(); if (audioCtx.state === 'suspended') audioCtx.resume(); } catch {} }
document.addEventListener('pointerdown', unlockAudio, { once: true });

async function api(path, opts = {}) {
  try {
    const controller = new AbortController();
    const timeout = opts.timeout || 8000;
    const fetchOpts = { ...opts };
    delete fetchOpts.timeout;
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    const r = await fetch(apiURL(path), { ...fetchOpts, signal: controller.signal });
    clearTimeout(timeoutId);
    let j = null; 
    try { j = await r.json(); } catch { throw new Error('Respuesta inválida del servidor'); }
    if (!r.ok || j.ok === false) throw new Error(j.error || ('Error ' + r.status));
    return { ok: true, data: j };
  } catch (err) {
    // Falla silenciosa: nunca mostrar "modo demo", "modo local" ni "sin conexión"
    console.debug('API no disponible:', err.message);
    return { ok: false, error: err.message, demo: true };
  } finally {
    // Cleanup timeout if fetch completed before abort
    // (clearTimeout is safe to call even if already cleared)
  }
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
    for (const id of ['locModal', 'loginModal', 'storeModal', 'prodModal', 'invModal', 'privModal', 'termModal', 'devModal', 'libroModal']) {
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
    const raw = decodeURIComponent(String(m[2]));
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw);
    const id = isUuid ? raw : raw.split('-')[0];
    if (id) { storeId = id; try { localStorage.setItem('ga_store', id); } catch {} }
  }
}
async function init() {
  paintSoundBtn(); paintLoc(); handleDeepLink(); initLegal(); applyShippingUI();
  
// Ping silencioso en segundo plano para mantener Render despierto
  let healthCheckInterval = null;
  function startHealthCheckPing() {
    if (healthCheckInterval) clearInterval(healthCheckInterval);
    healthCheckInterval = setInterval(async () => {
      try {
        await fetch(apiURL('/health'), { method: 'GET', cache: 'no-cache' });
        console.debug('🏓 Health check ping sent');
      } catch (err) {
        console.debug('Health check ping failed:', err.message);
      }
    }, 4 * 60 * 1000); // Ping cada 4 minutos para mantener Render despierto
  }

  function stopHealthCheckPing() {
    if (healthCheckInterval) clearInterval(healthCheckInterval);
    healthCheckInterval = null;
  }

  // Verificación de salud con timeout extendido a 45s
  async function checkHealthWithRetry(retries = 3, delay = 5000) {
    for (let i = 0; i < retries; i++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 45000); // 45s timeout para Render cold start
        const res = await fetch(apiURL('/health'), { signal: controller.signal });
        clearTimeout(timeoutId);
        const data = await res.json();
        if (res.ok) return { ok: true, data };
      } catch (err) {
        console.debug(`Health check attempt ${i + 1} failed:`, err.message);
        if (i < retries - 1) await new Promise(r => setTimeout(r, delay));
      }
    }
    return { ok: false }; // FIX: sin esto, init() lanzaba TypeError y la app no cargaba
  }

  // Estado de la API en segundo plano: NO bloquea el render de tiendas/catálogo
  // y NO escribe ningún cartel en pantalla (sin "modo demo" ni "sin conexión").
  (async () => {
    const healthResult = await checkHealthWithRetry();
    if (healthResult.ok) {
      try { localStorage.removeItem('ga_demo_mode'); } catch {}
      startHealthCheckPing(); // Ping en segundo plano para mantener Render despierto
    }
  })();

  await loadStores(); await loadProducts();
  const before = JSON.stringify(getLoc());
  handleDeepLink(stores.map(s => s.distrito).filter(Boolean)); // 2da pasada con distritos de DB
  if (JSON.stringify(getLoc()) !== before) { await loadStores(); await loadProducts(); }
  if (/^\/(tienda|ferreteria)\//.test(location.pathname)) metaForStore(stores.find(s => String(s.id) === String(storeId)));
  if (location.pathname.startsWith('/catalogo')) document.getElementById('grid')?.scrollIntoView();
  $('#storeForm [name=logo]')?.addEventListener('change', e => {
    const f = e.target.files[0]; if (!f) return;
    if (f.size > 5 * 1024 * 1024) { toast('Logo > 5MB, elige otra imagen'); e.target.value = ''; return; }
    $('#logoPrev').src = URL.createObjectURL(f); $('#logoPrev').classList.remove('hidden');
  });
  $('#prodForm [name=foto]')?.addEventListener('change', e => {
    const f = e.target.files[0]; if (!f) return;
    if (f.size > 5 * 1024 * 1024) { toast('Foto > 5MB, elige otra'); e.target.value = ''; return; }
    $('#fotoPrev').src = URL.createObjectURL(f); $('#fotoPrev').classList.remove('hidden');
  });
}
function setMode(m) {
  const c = m === 'c';
  $('#vCli')?.classList.toggle('active', c);
  $('#vFer')?.classList.toggle('active', !c);
  // Switch de escritorio y móvil comparten estado
  for (const [cli, fer] of [['#bCli', '#bFer'], ['#bCliM', '#bFerM']]) {
    const cb = $(cli), fb = $(fer);
    if (cb) cb.className = 'px-3 py-1.5 rounded-lg ' + (c ? 'bg-[#17FF00] text-black font-bold text-xs' : 'bg-white/10 text-white/80 text-xs font-bold');
    if (fb) fb.className = 'px-3 py-1.5 rounded-lg ' + (!c ? 'bg-[#17FF00] text-black font-bold text-xs' : 'bg-white/10 text-white/80 text-xs font-bold');
  }
  paintSession();
  if (!c) {
    const hasSession = !!AT || !!localStorage.getItem('ga_active_store');
    if (hasSession) { loadOrders(); startRealtime(); }
    else { ftab('ped'); openModal('loginModal'); } // sin sesión: pedir login, no dejar la vista vacía
  } else {
    stopRealtime();
    // Al volver al catálogo, refrescar productos (por si se agregó stock/fotos)
    window._all = null;
    loadProducts();
  }
}
window.setMode = setMode; // Exponer en global scope para onclick inline

function ftab(t) {
  $('#fPed')?.classList.toggle('hidden', t !== 'ped');
  $('#fStk')?.classList.toggle('hidden', t !== 'stk');
  $('#fInv')?.classList.toggle('hidden', t !== 'inv');
  // Resaltar el tab activo del panel lateral
  document.querySelectorAll('[data-ftab]').forEach(b => {
    const on = b.dataset.ftab === t;
    b.className = on
      ? 'w-full text-left px-3 py-2 rounded-xl bg-ferrex-neon text-ferrex-bg-alt font-black text-sm'
      : 'w-full text-left px-3 py-2 rounded-xl text-white/80 hover:bg-white/10 font-bold text-sm';
  });
  if (t === 'ped') loadOrders();
  if (t === 'stk') renderStock();
  if (t === 'inv') { openModal('invModal'); loadInventory(); }
}
window.ftab = ftab;
function setPay(p) {
  pay = p;
  document.querySelectorAll('.pay').forEach(b => {
    const on = b.textContent.trim() === p;
    b.className = 'pay font-bold rounded-xl py-2 text-xs ' + (on ? 'bg-plomo text-white' : 'bg-gray-100 text-ferrex-text');
  });
}

/* ---------- Delivery / Recojo: estado + UI + recálculo inmediato ---------- */
function applyShippingUI() {
  document.querySelectorAll('input[name=del]').forEach(r => {
    r.checked = r.value === shipMode;
    const label = r.closest('label');
    if (label) {
      label.classList.toggle('active', r.checked);
      label.setAttribute('aria-checked', String(r.checked));
    }
  });
  // Campos según el modo: dirección solo para delivery, "quién recoge" solo para recojo
  const addrWrap = $('#addrWrap'); if (addrWrap) addrWrap.style.display = shipMode === 'recojo' ? 'none' : 'block';
  const pickWrap = $('#pickupWrap'); if (pickWrap) pickWrap.style.display = shipMode === 'recojo' ? 'block' : 'none';
}
function setShipping(mode) {
  shipMode = mode === 'recojo' ? 'recojo' : 'delivery';
  const radio = document.querySelector(`input[name=del][value="${shipMode}"]`);
  if (radio) radio.checked = true;
  applyShippingUI();
  renderCart(); // recalcula Envío/Total al instante (Gratis 🎉 en recojo, 15% en delivery)
}
window.setShipping = setShipping;

/* ---------- tiendas (filtradas por zona) ---------- */
async function loadStores() {
  const loc = getLoc();
  let qs = '';
  if (loc && loc.mode === 'gps' && Number.isFinite(loc.lat) && Number.isFinite(loc.lng)) qs = `?lat=${loc.lat}&lng=${loc.lng}`;
  else if (loc && loc.mode === 'manual' && loc.distrito) qs = `?distrito=${encodeURIComponent(loc.distrito)}`;
  let apiStores = [];
  let apiOk = false;
  // 2 intentos: Render free tier puede tardar en despertar (cold start)
  for (let attempt = 1; attempt <= 2; attempt++) {
    const storesResult = await api('/stores' + qs, { timeout: 30000 });
    if (storesResult.ok) { apiStores = Array.isArray(storesResult.data) ? storesResult.data : []; apiOk = true; break; }
    console.debug(`Tiendas: intento ${attempt}/2 falló:`, storesResult.error);
    if (attempt < 2) await new Promise(r => setTimeout(r, 1200));
  }
  // Incluir tiendas demo de localStorage (solo desarrollo local; nunca se etiquetan en pantalla)
  let demoStores = [];
  try { demoStores = JSON.parse(localStorage.getItem('ga_demo_stores') || '[]'); } catch {}
  storesApiOk = apiOk;
  stores = [...apiStores, ...demoStores];
  // Filtrar por distrito si hay ubicación manual
  if (loc && loc.mode === 'manual' && loc.distrito) {
    stores = stores.filter(s => s.distrito === loc.distrito);
  }
  if (!stores.length) {
    stores = [...apiStores, ...demoStores]; // mostrar todas si filtro no da resultados
    // Solo avisar cuando la API respondió de verdad y no hay ninguna ferretería
    if (apiOk && !stores.length) toast(`Sin ferreterías en ${loc?.distrito || 'tu zona'} — registra la tuya`);
  }
  // Deduplicar ferreterías por ID (evitar registros duplicados)
  const seenIds = new Set();
  stores = stores.filter(s => {
    if (seenIds.has(String(s.id))) return false;
    seenIds.add(String(s.id));
    return true;
  });

  if (!stores.find(s => String(s.id) === String(storeId))) {
    storeId = stores[0]?.id || 1;
    try { localStorage.setItem('ga_store', storeId); } catch {}
  }
  const sel = $('#storeSel');
  if (sel) {
    sel.innerHTML = stores.map(s => {
      const d = s.distance_km != null ? ` · a ${s.distance_km} km (~${s.eta_min} min)` : '';
      const st = s.abierto_ahora === false ? ' · 🔴 Cerrado' : '';
      return `<option value="${s.id}" ${String(s.id) === String(storeId) ? 'selected' : ''}>${esc(s.nombre)} · ${esc(s.distrito || s.zona || '')}${d}${st}</option>`;
    }).join('');
    // Si no hay tiendas, ocultamos el select vacío (el botón SuperAdmin ocupa ese lugar)
    sel.classList.toggle('hidden', stores.length === 0);
    if (stores.length && stores.some(s => String(s.id) === String(storeId))) sel.value = String(storeId);
  }
  paintSession();
  paintStoreCards();
  window._all = null; loadProducts();
}
async function retryLoad() {
  await loadStores();
  await loadProducts();
}
window.retryLoad = retryLoad;
function onStoreChange() {
  const val = $('#storeSel').value;
  const st = stores.find(s => String(s.id) === String(val));
  storeId = st ? st.id : val;
  localStorage.setItem('ga_store', storeId);
  window._all = null;
  metaForStore(stores.find(s => String(s.id) === String(storeId)));
  paintStoreCards();
  loadProducts();
  if ($('#vFer').classList.contains('active')) { loadOrders(); startRealtime(); }
}

/* ---------- Tarjetas de tiendas (hero + sidebar) ---------- */
function storeEmoji(i) { return ['🔩💡🔒', '🚿🎨🔧', '🪛🧰🔌', '🛠️📐⚙️'][i % 4]; }
function paintStoreCards() {
  const hero = $('#heroStores');
  if (hero) {
    const heroEmpty = !storesApiOk
      ? `<div class="bg-white text-ferrex-text rounded-2xl p-4 shadow-pop sm:col-span-2">
      <p class="text-xs font-black text-ferrex-text-dim">● CATÁLOGO</p>
      <h3 class="font-extrabold mt-1">Estamos cargando las ferreterías de tu zona</h3>
      <p class="text-xs text-ferrex-text-dim mt-1">Volvé a intentar en unos segundos.</p>
      <button onclick="retryLoad()" class="mt-3 w-full btn-primary font-bold py-2 rounded-xl text-sm">Reintentar</button>
    </div>`
      : `<div class="bg-white text-ferrex-text rounded-2xl p-4 shadow-pop sm:col-span-2">
      <p class="text-xs font-black text-ferrex-neon-dim">● SUMATE AL PILOTO</p>
      <h3 class="font-extrabold mt-1">Todavía no hay ferreterías en tu zona</h3>
      <p class="text-xs text-ferrex-text-dim mt-1">Registrá tu ferretería y aparecé en el catálogo de FERREX.</p>
      <button onclick="openModal('storeModal')" class="mt-3 w-full btn-primary font-bold py-2 rounded-xl text-sm">Registrar mi ferretería</button>
    </div>`;
    hero.innerHTML = stores.slice(0, 2).map((s, i) => {
      const open = s.abierto_ahora !== false;
      const dist = s.distance_km != null ? ` · A ${s.distance_km} KM` : '';
      return `<div class="bg-white text-ferrex-text rounded-2xl p-4 shadow-pop flex flex-col">
        <p class="text-xs font-black ${open ? 'text-listo' : 'text-etiqueta'}">● ${open ? 'ABIERTO' : 'CERRADO'}${dist}</p>
        <h3 class="font-extrabold mt-1 leading-tight">${esc(s.nombre)}</h3>
        <p class="text-xs text-ferrex-text-dim mt-0.5">${esc(s.distrito || s.zona || '')}${s.direccion ? ' · ' + esc(s.direccion) : ''}</p>
        <p class="text-[11px] text-ferrex-text-muted mt-1">${esc(s.horario_txt || 'Horario no registrado')}</p>
        <div class="mt-2 text-4xl">${storeEmoji(i)}</div>
        <button onclick="pickStore('${esc(s.id)}')" class="mt-3 w-full ${i === 0 ? 'btn-primary' : 'bg-plomo text-white'} font-bold py-2 rounded-xl text-sm">Pedir aquí</button>
      </div>`;
    }).join('') || heroEmpty;
  }
  const list = $('#tiendasList');
  if (list) {
    list.innerHTML = stores.map(s => {
      const active = String(s.id) === String(storeId);
      const short = String(s.nombre || 'Ferretería').replace(/^Ferretería\s+/i, '');
      const dist = s.distance_km != null ? `${s.distance_km} km · ` : '';
      return `<button onclick="pickStore('${esc(s.id)}')" class="w-full text-left p-2 rounded-xl border-2 ${active ? 'border-ferrex-neon bg-ferrex-neon/5' : 'border-ferrex-border hover:border-ferrex-neon'} transition-colors">
        <b class="text-ferrex-text">${esc(short)}</b><br>
        <span class="text-[11px] text-ferrex-text-muted">${dist}${s.abierto_ahora === false ? 'Cerrado' : 'Abierto'}</span>
      </button>`;
    }).join('') || (storesApiOk
      ? `<button onclick="openModal('storeModal')" class="w-full text-left p-2 rounded-xl border-2 border-dashed border-ferrex-border text-ferrex-text-dim text-xs">+ Registrá la primera ferretería</button>`
      : `<button onclick="retryLoad()" class="w-full text-left p-2 rounded-xl border-2 border-dashed border-ferrex-border text-ferrex-text-dim text-xs">Reintentar</button>`);
  }
  const lbl = $('#storeLbl');
  if (lbl) {
    const s = stores.find(x => String(x.id) === String(storeId));
    lbl.textContent = s ? '· ' + String(s.nombre).replace(/^Ferretería\s+/i, '') : '· tu zona';
  }
}
function pickStore(id) {
  const st = stores.find(s => String(s.id) === String(id));
  if (!st) { toast('No encontramos esa ferretería'); return; }
  storeId = st.id;
  try { localStorage.setItem('ga_store', storeId); } catch {}
  const sel = $('#storeSel'); if (sel) sel.value = storeId;
  window._all = null;
  metaForStore(st);
  paintStoreCards();
  loadProducts();
  toast(`Tienda: ${st.nombre} ✓`);
  document.getElementById('catalogo')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
window.pickStore = pickStore;

function scrollToCart() {
  document.getElementById('cartPanel')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
window.scrollToCart = scrollToCart;

function scrollToNewProduct() {
  setMode('f');
  ftab('inv');
  needAuth(() => openModal('prodModal'));
}
window.scrollToNewProduct = scrollToNewProduct;
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
  if (!AT && !localStorage.getItem('ga_active_store')) { toast('Inicia sesión como ferretería 🔐'); openModal('loginModal'); return; }
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
    const result = await api(path, { method, headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) });
    if (!result.ok) throw new Error(result.error || 'API error');
    return result.data;
  } catch (e) {
    if (/sesi|401|Inicia sesión|vencida/i.test(e.message) && !retried) {
      if (await tryRefresh()) return apiAuth(path, method, body, true);
    }
    if (/sesi|401|Inicia sesión|vencida/i.test(e.message)) { AT = null; paintSession(); openModal('loginModal'); }
    // Modo demo silencioso
    console.debug('API auth failed (demo mode):', e.message);
    return { demo: true };
  }
}
async function login(e) {
  e.preventDefault();
  const form = e.target;
  const submitBtn = $('#loginSubmitBtn');
  const errorDiv = $('#loginFormError');
  
  const identifier = form.querySelector('[name=identifier]').value.trim();
  const password = form.querySelector('[name=password]').value;
  
  if (!identifier || !password) {
    errorDiv.textContent = '⚠ Complete celular y contraseña.';
    errorDiv.classList.remove('hidden');
    return;
  }
  
  submitBtn.disabled = true;
  submitBtn.innerHTML = 'Entrando... <span class="animate-spin">⏳</span>';
  errorDiv.classList.add('hidden');
  
  try {
    // 1. Intentar API (con timeout para no dejar el botón colgado)
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 20000);
    let r, j;
    try {
      r = await fetch(apiURL('/auth/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ identifier, password }),
        signal: ctrl.signal
      });
      j = await r.json().catch(() => ({}));
    } finally { clearTimeout(tid); }
    if (!r.ok) throw new Error(j.error || ('Error ' + r.status));
    
    // Éxito API
    AT = j.accessToken;
    storeId = j.store.id; 
    localStorage.setItem('ga_store', storeId);
    toast(`¡Bienvenido, ${j.store.nombre}! ✅`);
    closeModal('loginModal'); 
    form.reset();
    await loadStores(); 
    paintSession(); 
    setMode('f');
  } catch (err) {
    // 2. Fallback: buscar en localStorage demo stores
    console.warn('API login falló, probando localStorage:', err.message);
    
    let demoStores = [];
    try { demoStores = JSON.parse(localStorage.getItem('ga_demo_stores') || '[]'); } catch {}
    
    // Buscar por teléfono, WhatsApp o nombre de la ferretería
    const norm = s => String(s || '').trim().toLowerCase();
    const matchedStore = demoStores.find(s =>
      (s.telefono === identifier || s.whatsapp === identifier || s.celular === identifier || norm(s.nombre) === norm(identifier)) &&
      s.password === password
    );
    
    if (matchedStore) {
      // Guardar sesión en localStorage
      localStorage.setItem('ga_active_store', JSON.stringify(matchedStore));
      localStorage.setItem('ga_store', matchedStore.id);
      storeId = matchedStore.id;
      AT = 'demo-token-' + Date.now(); // token simulado
      
      toast(`¡Sesión iniciada correctamente! Bienvenido, ${matchedStore.nombre} ✅`);
      closeModal('loginModal'); 
      form.reset();
      await loadStores(); 
      paintSession(); 
      setMode('f');
    } else {
      errorDiv.textContent = '⚠ Celular o contraseña incorrectos.';
      errorDiv.classList.remove('hidden');
    }
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = 'Entrar →';
  }
}
async function logout() {
  try { await fetch(apiURL('/auth/logout'), { method: 'POST', credentials: 'include' }); } catch {}
  AT = null;
  localStorage.removeItem('ga_active_store');
  paintSession(); 
  toast('Sesión cerrada');
}
function myStore() { 
  // Primero buscar en stores (API + demo) — IDs pueden ser UUID (string) o numéricos
  let s = stores.find(x => String(x.id) === String(storeId));
  // Si no está en stores, buscar en localStorage demo
  if (!s) {
    try {
      const demoStores = JSON.parse(localStorage.getItem('ga_demo_stores') || '[]');
      s = demoStores.find(ds => String(ds.id) === String(storeId));
    } catch {}
  }
  return s;
}

function paintSession() {
  // Verificar sesión: token JWT (AT) o demo store en localStorage
  const demoSession = localStorage.getItem('ga_active_store');
  const on = !!AT || !!demoSession;
  
  $('#sesBar')?.classList.toggle('hidden', !on);
  $('#noSes')?.classList.toggle('hidden', on);
  
  let s = myStore();
  // Si no hay store en memoria pero hay demo session
  if (!s && demoSession) {
    try { s = JSON.parse(demoSession); } catch {}
  }
  
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
  const apertura = $('#hApe').value;
  const cierre = $('#hCie').value;
  const abierto = $('#hOpen').checked;
  const payload = {
    apertura, cierre, dias_atencion: dias,
    abierta: abierto, abierto,
    horario: { apertura, cierre, dias }
  };
  try {
    const s = await apiAuth(`/stores/${storeId}`, 'PATCH', payload);
    if (s?.demo) {
      // Modo demo: guardar horario en localStorage
      const active = JSON.parse(localStorage.getItem('ga_active_store') || 'null') || {};
      const upd = { ...active, ...payload, abierto, abierto_ahora: abierto, horario: payload.horario, horario_txt: `${apertura} - ${cierre}` };
      try {
        localStorage.setItem('ga_active_store', JSON.stringify(upd));
        const demos = JSON.parse(localStorage.getItem('ga_demo_stores') || '[]').map(d => String(d.id) === String(storeId) ? { ...d, ...upd } : d);
        localStorage.setItem('ga_demo_stores', JSON.stringify(demos));
      } catch {}
      paintSession();
      toast('Horario guardado ✅');
      return;
    }
    // Releer tiendas para obtener el formato público (horario, abierto_ahora)
    await loadStores();
    paintSession();
    toast('Horario guardado ✅');
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
  const form = e.target;
  const submitBtn = $('#storeSubmitBtn');
  const errorDiv = $('#storeFormError');
  
  // Validación de campos requeridos
  const fd = new FormData(form);
  const nombre = fd.get('nombre')?.trim();
  const distrito = fd.get('distrito')?.trim();
  const telefono = String(fd.get('telefono') || '').replace(/\D/g, '');
  const password = fd.get('password');
  const aceptaTerminos = fd.get('aceptaTerminos');
  const dias = [...form.querySelectorAll('#regDias input:checked')].map(i => Number(i.value));
  
  if (!nombre || !distrito || !password || !aceptaTerminos) {
    errorDiv.textContent = '⚠ Complete todos los campos obligatorios y acepte los términos.';
    errorDiv.classList.remove('hidden');
    return;
  }
  if (!/^9\d{8}$/.test(telefono)) {
    errorDiv.textContent = '⚠ Ingresá un celular válido de 9 dígitos (empieza con 9).';
    errorDiv.classList.remove('hidden');
    return;
  }
  if (password.length < 6) {
    errorDiv.textContent = '⚠ La contraseña debe tener al menos 6 caracteres.';
    errorDiv.classList.remove('hidden');
    return;
  }
  if (dias.length === 0) {
    errorDiv.textContent = '⚠ Seleccione al menos un día de atención.';
    errorDiv.classList.remove('hidden');
    return;
  }
  
  // Estado de carga
  submitBtn.disabled = true;
  submitBtn.innerHTML = 'Guardando... <span class="animate-spin">⏳</span>';
  errorDiv.classList.add('hidden');
  
  fd.append('dias', JSON.stringify(dias));
  
  try {
    const r = await fetch(apiURL('/stores'), { method: 'POST', body: fd, credentials: 'include' });
    const s = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(s.error || ('Error ' + r.status));
    
    // Éxito API
    const storeData = s.store || s;
    if (s.accessToken) AT = s.accessToken;
    toast('¡Ferretería registrada correctamente! ✅');
    closeModal('storeModal'); 
    form.reset(); 
    $('#logoPrev').classList.add('hidden');
    $('#regDias').innerHTML = [1,2,3,4,5,6,0].map(d =>
      `<label class="text-[11px] bg-ferrex-bg border border-ferrex-border rounded-lg px-2 py-1 cursor-pointer"><input type="checkbox" value="${d}" ${[1,2,3,4,5,6].includes(d) ? 'checked' : ''} class="accent-ferrex-neon"> ${['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'][d]}</label>`).join('');
    await loadStores(); 
    storeId = storeData.id; 
    try { localStorage.setItem('ga_store', storeId); } catch {}
    try { localStorage.setItem('ga_active_store', JSON.stringify(storeData)); } catch {}
    $('#storeSel').value = storeId;
    paintSession(); 
    setMode('f'); 
    loadProducts();
  } catch (err) {
    // Fallback localStorage para modo demo
    console.warn('API no disponible, guardando localmente:', err.message);
    
    const demoStore = {
      id: Date.now(),
      nombre,
      distrito,
      direccion: fd.get('direccion')?.trim() || '',
      telefono: fd.get('telefono')?.trim() || '',
      whatsapp: fd.get('whatsapp')?.trim() || '',
      password, // en demo se guarda plano (solo demo)
      apertura: fd.get('apertura') || '08:00',
      cierre: fd.get('cierre') || '20:00',
      dias,
      horario: { apertura: fd.get('apertura') || '08:00', cierre: fd.get('cierre') || '20:00', dias },
      abierto_ahora: true,
      abierto: true,
      logo: null,
      creado: new Date().toISOString()
    };
    
    try {
      const existing = JSON.parse(localStorage.getItem('ga_demo_stores') || '[]');
      existing.push(demoStore);
      localStorage.setItem('ga_demo_stores', JSON.stringify(existing));
      localStorage.setItem('ga_active_store', JSON.stringify(demoStore));
    } catch {}
    
    AT = 'demo-token-' + Date.now(); // sesión demo para habilitar el panel
    toast('¡Ferretería registrada! ✅');
    closeModal('storeModal'); 
    form.reset(); 
    $('#logoPrev').classList.add('hidden');
    $('#regDias').innerHTML = [1,2,3,4,5,6,0].map(d =>
      `<label class="text-[11px] bg-ferrex-bg border border-ferrex-border rounded-lg px-2 py-1 cursor-pointer"><input type="checkbox" value="${d}" ${[1,2,3,4,5,6].includes(d) ? 'checked' : ''} class="accent-ferrex-neon"> ${['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'][d]}</label>`).join('');
    await loadStores(); 
    storeId = demoStore.id; 
    try { localStorage.setItem('ga_store', storeId); } catch {}
    $('#storeSel').value = storeId;
    paintSession(); 
    setMode('f'); 
    loadProducts();
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = 'Guardar ferretería ✅';
  }
}

/* ---------- catálogo ---------- */
async function loadProducts() {
  const qEl = $('#q');
  const q = qEl ? (qEl.value || '') : '';
  const isApiStore = UUID_RE.test(String(storeId));
  const apiUnreachable = !storesApiOk && !stores.length; // no hay tiendas porque la API no respondió
  let apiProducts = [];
  let apiOk = !isApiStore && !apiUnreachable;
  const grid = $('#grid');
  // Placeholder neutro mientras llegan los datos (cold start de Render)
  if (grid && (isApiStore || apiUnreachable)) {
    grid.innerHTML = `<div class="col-span-full text-center py-12"><p class="text-ferrex-text-muted text-sm animate-pulse">Cargando catálogo…</p></div>`;
  }
  // Las tiendas demo tienen ids numéricos: la API sólo entiende UUID
  if (isApiStore) {
    const url = `/products?store_id=${storeId}&q=${encodeURIComponent(q)}${activeCat !== 'Todo' ? '&cat=' + encodeURIComponent(activeCat) : ''}`;
    // 2 intentos para tolerar el cold start inicial de Render
    for (let attempt = 1; attempt <= 2; attempt++) {
      const productsResult = await api(url, { timeout: 30000 });
      if (productsResult.ok) { apiProducts = Array.isArray(productsResult.data) ? productsResult.data : []; apiOk = true; break; }
      console.debug(`Productos: intento ${attempt}/2 falló:`, productsResult.error);
      if (attempt < 2) await new Promise(r => setTimeout(r, 800));
    }
  }
  
  // Cargar productos demo de localStorage solo si no hay productos de la API
  let demoProducts = [];
  try { demoProducts = JSON.parse(localStorage.getItem('ga_demo_products') || '[]'); } catch {}
  let storeDemoProducts = demoProducts.filter(p => String(p.store_id) === String(storeId));
  if (activeCat !== 'Todo') storeDemoProducts = storeDemoProducts.filter(p => p.categoria === activeCat);
  if (q) storeDemoProducts = storeDemoProducts.filter(p => String(p.nombre || '').toLowerCase().includes(q.toLowerCase()));

  // Solo usar productos demo si no hay productos de la API
  products = apiProducts.length > 0 ? apiProducts : [...apiProducts, ...storeDemoProducts];
  
  const catsEl = $('#cats');
  if (catsEl) catsEl.innerHTML = CATS.map(c => `<button onclick="activeCat='${c}';loadProducts()" class="cat-pill ${activeCat === c ? 'active' : 'inactive'}">${c}</button>`).join('');
  const catSide = $('#catSide');
  if (catSide) catSide.innerHTML = CATS.map(c => `<button onclick="activeCat='${c}';loadProducts()" class="w-full text-left px-3 py-2 rounded-xl text-sm font-bold ${activeCat === c ? 'bg-ferrex-bg-alt text-white' : 'text-ferrex-text-dim hover:bg-ferrex-bg'}">${c}</button>`).join('');

  if (grid) {
    const visibles = products.filter(p => p.stock);
    const cards = visibles.map(p => `
    <div class="product-card">
      ${p.foto_base64 ? `<img src="${p.foto_base64}" alt="${esc(p.nombre)}" loading="lazy" onerror="imgFallback(this)">`
        : p.foto_url ? `<img src="${absImg(p.foto_url)}" alt="${esc(p.nombre)}" loading="lazy" onerror="imgFallback(this)">`
        : `<div class="product-emoji">${p.emoji || '📦'}</div>`}
      <p class="text-[11px] text-ferrex-text-muted font-bold mt-2 uppercase tracking-wide">${esc(p.categoria)}</p>
      <h3 class="font-extrabold text-sm leading-tight text-ferrex-text">${esc(p.nombre)}</h3>
      ${priceHtml(p, 'mt-1')}
      <button onclick="addCart('${esc(p.id)}')" class="w-full mt-2 btn-primary py-2 rounded-xl text-sm">Agregar al carrito</button>
    </div>`).join('');
    const retryHtml = `<div class="col-span-full text-center py-12 bg-ferrex-card border border-dashed border-ferrex-border rounded-2xl">
      <p class="text-ferrex-text-muted text-lg mb-1">📦 El catálogo está tardando en cargar</p>
      <p class="text-xs text-ferrex-text-muted mb-4">Volvé a intentar en unos segundos.</p>
      <button onclick="loadProducts()" class="btn-primary px-5 py-2.5 rounded-xl text-sm">Reintentar</button>
    </div>`;
    const emptyHtml = `<div class="col-span-full text-center py-12 bg-ferrex-card border border-dashed border-ferrex-border rounded-2xl">
      <p class="text-ferrex-text-muted text-lg mb-1">📦 Sin productos disponibles</p>
      <p class="text-xs text-ferrex-text-muted mb-4">Si sos ferretero, publicá tu primer producto con foto.</p>
      <button onclick="scrollToNewProduct()" class="btn-primary px-5 py-2.5 rounded-xl text-sm">+ Agregar producto</button>
    </div>`;
    grid.innerHTML = cards || (apiOk ? emptyHtml : retryHtml);
  }
  renderCart(); renderStock();
}
function addCart(id) { cart[id] = (cart[id] || 0) + 1; renderCart(); toast('Agregado ✓'); }
function removeCart(id) { delete cart[id]; renderCart(); toast('Eliminado 🗑️'); }
function updateCartQuantity(id, delta) {
  const current = cart[id] || 0;
  const next = current + delta;
  if (next <= 0) { delete cart[id]; }
  else { cart[id] = next; }
  renderCart();
}
function totals() {
  let s = 0, n = 0;
  const all = [...products, ...(window._all || [])];
  for (const [id, q] of Object.entries(cart)) {
    const p = all.find(x => String(x.id) === String(id));
    if (p) { s += Number(p.precio_oferta || p.precio) * q; n += q; }
  }
  const checked = document.querySelector('input[name=del]:checked')?.value;
  if (checked === 'recojo' || checked === 'delivery') shipMode = checked; // el radio manda si existe
  const del = shipMode !== 'recojo';
  const sub = round2(s);
  // Recojo: envío gratis (S/ 0.00). Delivery: 15% del subtotal, redondeado a 2 decimales.
  const ship = (n === 0 || !del) ? 0 : round2(sub * SHIPPING_RATE);
  return { sub, n, ship, total: round2(sub + ship), del };
}
function paintCart(t) {
  const cartN = $('#cartN'); if (cartN) cartN.textContent = t.n;
  const all = [...products, ...(window._all || [])];
  const cartBox = $('#cartBox');
  if (cartBox) cartBox.innerHTML = t.n === 0 ? '<p class="text-ferrex-text-muted text-center py-4 text-sm">Vacío. Agregá algo urgente 👆</p>' :
    Object.entries(cart).map(([id, q]) => { const p = all.find(x => String(x.id) === String(id)); if (!p) return '';
      const unitPrice = Number(p.precio_oferta || p.precio);
      return `<div class="flex items-center justify-between bg-ferrex-bg rounded-xl p-2 gap-2">
        <div class="flex items-center gap-2 flex-1 min-w-0">
          <button onclick="updateCartQuantity('${esc(id)}', -1)" class="btn-secondary text-xl px-2 py-0 leading-none" aria-label="Disminuir">−</button>
          <span class="font-bold text-ferrex-text whitespace-nowrap">${q}×</span>
          <button onclick="updateCartQuantity('${esc(id)}', 1)" class="btn-secondary text-xl px-2 py-0 leading-none" aria-label="Incrementar">+</button>
          <span class="text-ferrex-text truncate">${esc(p.nombre)}</span>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-ferrex-neon-dim font-bold whitespace-nowrap">${money(unitPrice * q)}</span>
          <button onclick="removeCart('${esc(id)}')" class="text-ferrex-text-muted hover:text-ferrex-danger p-1" aria-label="Eliminar">🗑️</button>
        </div>
      </div>`; }).join('');
  const subT = $('#subT'); if (subT) subT.textContent = money(t.sub);
  const shT = $('#shT'); if (shT) {
    if (t.n === 0) shT.textContent = '—';
    else if (!t.del) shT.textContent = 'Gratis 🎉';
    else shT.textContent = money(t.ship);
  }
  const toT = $('#toT'); if (toT) toT.textContent = money(t.total);
}
async function renderCart() {
  // 1) Pintar YA con los datos en memoria: el cambio Delivery/Recojo se ve al instante
  paintCart(totals());
  // 2) Completar en segundo plano el catálogo completo (para ítems fuera del filtro activo)
  if (!window._all) {
    if (UUID_RE.test(String(storeId))) {
      const allResult = await api(`/products?store_id=${storeId}`);
      if (allResult.ok && Array.isArray(allResult.data)) window._all = allResult.data;
      else window._all = products;
    } else {
      window._all = products;
    }
    paintCart(totals());
  }
}

/* ---------- 1. Checkout + WhatsApp ---------- */
function currentStore() { return stores.find(s => String(s.id) === String(storeId)); }

function buildWhatsAppMessage(t, store) {
  const all = [...products, ...(window._all || [])];
  const itemsText = Object.entries(cart).map(([id, q]) => {
    const p = all.find(x => String(x.id) === String(id));
    return `• ${q}x ${p?.nombre || 'Producto'} - S/ ${Number(p?.precio_oferta || p?.precio || 0).toFixed(2)}`;
  }).join('\n');
  
  const deliveryText = t.del 
    ? `🚚 Delivery a: ${$('#addr')?.value.trim() || 'Dirección no especificada'}`
    : `🏪 Recojo en tienda${$('#pickupName')?.value.trim() ? ` - Quien recoge: ${$('#pickupName').value.trim()}` : ''}`;
  
  const paymentText = `💳 Pago: ${pay}`;
  const subtotal = t.sub;
  const shipping = t.del ? round2(t.ship) : 0;
  const shippingLine = t.del ? `🚚 Envío: S/ ${shipping.toFixed(2)}` : '🚚 Envío: Gratis 🎉';

  return `📋 *Nuevo Pedido FERREX*\n${itemsText}\n${deliveryText}\n${paymentText}\n💰 Subtotal: S/ ${subtotal.toFixed(2)}\n${shippingLine}\n*Total a pagar: S/ ${t.total.toFixed(2)}*\n\n_Ferretería: ${store?.nombre || 'FERREX'}_`;
}

function normalizePhone(phone) {
  if (!phone) return '';
  // Limpiar: quitar espacios, guiones, paréntesis, +, etc.
  let clean = phone.replace(/[\s\-\(\)\+]/g, '');
  // Si no empieza con 51 (código Perú), agregarlo
  if (!clean.startsWith('51')) {
    // Si empieza con 9 (celular peruano de 9 dígitos), agregar 51
    if (clean.startsWith('9') && clean.length === 9) {
      clean = '51' + clean;
    } else if (clean.length === 9) {
      clean = '51' + clean;
    }
  }
  return clean;
}

async function sendOrder() {
  const t = totals();
  if (t.n === 0) { toast('Carrito vacío 🛒'); return; }
  if (!$('#consent')?.checked) { toast('Aceptá las Políticas y Términos para confirmar ☑️'); $('#consent')?.focus(); return; }

  // Obtener tienda actual (API + demo)
  const store = stores.find(s => String(s.id) === String(storeId)) ||
    JSON.parse(localStorage.getItem('ga_demo_stores') || '[]').find(s => String(s.id) === String(storeId));

  if (!store) {
    toast('No hay ferretería seleccionada');
    return;
  }

  // Obtener teléfono de la tienda
  const rawPhone = store.whatsapp || store.telefono || store.celular;
  const phone = normalizePhone(rawPhone);

  if (!phone) {
    toast('La ferretería no tiene teléfono/WhatsApp configurado');
    return;
  }

  // ⚠️ Snapshot del carrito ANTES de vaciarlo (fix: antes se vaciaba primero)
  const all = [...products, ...(window._all || [])];
  const items = Object.entries(cart).map(([id, q]) => {
    const p = all.find(x => String(x.id) === String(id));
    return {
      product_id: String(id), // UUID real: nunca convertir a Number
      nombre: p?.nombre || 'Producto',
      qty: q,
      price: Number(p?.precio_oferta || p?.precio || 0)
    };
  });
  if (!items.length) { toast('Carrito vacío 🛒'); return; }

  // Mensaje local de respaldo (se construye con el carrito aún intacto)
  const localMessage = buildWhatsAppMessage(t, store);
  const localWhatsappUrl = `https://wa.me/${phone}?text=${encodeURIComponent(localMessage)}`;

  const body = {
    store_id: String(storeId),
    items,
    subtotal: t.sub,
    shipping: t.ship,
    envio_costo: t.ship,
    total: t.total,
    pay,
    address: $('#addr')?.value.trim() || '',
    pickupName: $('#pickupName')?.value.trim() || '',
    delivery: t.del ? 'delivery' : 'recojo',
    clientZone: getLoc()
  };

  const btn = $('#sendBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Guardando pedido…'; }

  // 1) Guardar PRIMERO en la base de datos (solo si tienda y productos son UUID reales)
  const canSave = UUID_RE.test(String(store.id)) && items.every(i => UUID_RE.test(String(i.product_id)));
  let saved;
  if (!canSave) {
    saved = { ok: false, error: 'modo demo local' };
  } else {
    try {
      saved = await api('/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        timeout: 30000 // Render free tier: cold start puede tardar
      });
    } catch (e) {
      saved = { ok: false, error: e.message };
    }
  }

  // 2) Determinar código, mensaje y URL (preferimos lo que devolvió el backend)
  let code, message, whatsappUrl;
  if (saved && saved.ok && saved.data) {
    const o = saved.data;
    code = o.codigo || o.code || ('FERREX-' + Date.now().toString().slice(-6));
    message = o.whatsapp_message || localMessage;
    whatsappUrl = o.whatsapp_url || localWhatsappUrl;
  } else {
    // Fallback modo demo/Sin conexión: el pedido solo se envía por WhatsApp
    code = 'FERREX-' + Date.now().toString().slice(-6);
    message = localMessage;
    whatsappUrl = localWhatsappUrl;
    console.debug('Pedido no guardado en BD (modo demo):', saved?.error || 'sin conexión');
  }

  // 3) Mostrar confirmación en UI
  $('#orderOk')?.classList.remove('hidden');
  const okCode = $('#okCode'); if (okCode) okCode.textContent = `Pedido ${code}`;
  const okTxt = $('#okTxt'); if (okTxt) okTxt.textContent = `${t.n} productos · ${t.del ? 'Delivery' : 'Recojo'} · ${pay} · Total ${money(t.total)}`;
  const a = $('#waCta');
  if (a) { a.href = whatsappUrl; a.classList.remove('hidden'); }
  window._lastWa = message;

  // 4) Abrir WhatsApp DESPUÉS de guardar
  window.open(whatsappUrl, '_blank');
  toast(saved && saved.ok ? 'Pedido guardado ✅ Abriendo WhatsApp…' : 'Abriendo WhatsApp… 📲');

  // 5) Limpiar carrito
  cart = {};
  renderCart();

  if (btn) { btn.disabled = false; btn.textContent = 'Confirmar pedido por WhatsApp →'; }
}

// Función auxiliar para construir mensaje (compatibilidad con código anterior)
function buildOrderMessage(order, store) {
  const itemsText = order.items.map(i => `• ${i.qty}x ${i.nombre} - S/ ${i.price.toFixed(2)}`).join('\n');
  const deliveryText = order.delivery === 'delivery' ? `🚚 Delivery a: ${order.address}` : `🏪 Recojo en tienda`;
  const paymentText = `💳 Pago: ${order.pay}`;
  return `📋 *Nuevo Pedido ${order.code}*\n${itemsText}\n${deliveryText}\n${paymentText}\n💰 *Total: S/ ${order.total.toFixed(2)}*\n\n_Ferretería: ${store?.nombre || 'FERREX'}_`;
}
function copyWa() { navigator.clipboard?.writeText(window._lastWa || '').then(() => toast('Mensaje copiado 📋')).catch(() => toast('No se pudo copiar')); }

/* ---------- ferretería: stock ---------- */
async function toggleStock(id, val) {
  const newStock = val === true || val === 'true' || val === 1;
  let savedRemote = false;
  const isDemo = String(AT || '').startsWith('demo-token') || !UUID_RE.test(String(id));
  if (AT && !isDemo) {
    try {
      // 1. Intentar API (apiAuth devuelve {demo:true} si no hay sesión/red)
      const r = await apiAuth(`/products/${id}/stock`, 'PATCH', { stock: newStock });
      savedRemote = !r?.demo;
    } catch (err) {
      console.debug('API stock toggle falló:', err.message);
    }
  }
  // 2. Fallback localStorage demo
  if (!savedRemote) {
    let demoProducts = [];
    try { demoProducts = JSON.parse(localStorage.getItem('ga_demo_products') || '[]'); } catch {}
    const idx = demoProducts.findIndex(p => String(p.id) === String(id));
    if (idx >= 0) {
      demoProducts[idx].stock = newStock;
      localStorage.setItem('ga_demo_products', JSON.stringify(demoProducts));
    }
    const storeIdx = products.findIndex(p => String(p.id) === String(id));
    if (storeIdx >= 0) products[storeIdx].stock = newStock;
  }
  window._all = null;
  loadProducts();
  toast(newStock ? 'Producto disponible ✅' : 'Producto agotado ❌');
}

async function saveProduct(e) {
  e.preventDefault();
  if (!AT && !localStorage.getItem('ga_active_store')) { closeModal('prodModal'); needAuth(() => openModal('prodModal')); return; }
  
  const form = e.target;
  const fileInput = form.querySelector('[name=foto]');
  const file = fileInput?.files?.[0];
  
  // Leer datos del formulario
  const nombre = form.querySelector('[name=nombre]').value.trim();
  const precio = parseFloat(form.querySelector('[name=precio]').value);
  const categoria = form.querySelector('[name=categoria]').value;
  
  if (!nombre || isNaN(precio) || !categoria) {
    toast('Complete todos los campos obligatorios');
    return;
  }
  
  // Convertir imagen a Base64 si existe
  let fotoBase64 = null;
  if (file) {
    if (file.size > 5 * 1024 * 1024) {
      toast('Imagen > 5MB, elija otra');
      return;
    }
    try {
      fotoBase64 = await fileToBase64(file);
    } catch (err) {
      toast('Error procesando imagen');
      return;
    }
  }
  
  const submitBtn = form.querySelector('button[type=submit]');
  const originalText = submitBtn.innerHTML;
  submitBtn.disabled = true;
  submitBtn.innerHTML = 'Publicando... <span class="animate-spin">⏳</span>';
  
  // Preparar objeto producto
  const productData = {
    id: Date.now(),
    store_id: storeId,
    nombre,
    precio,
    categoria,
    foto_base64: fotoBase64,
    stock: true,
    creado: new Date().toISOString()
  };
  
  try {
    // 1. Intentar API (sólo tiendas reales con sesión no-demo)
    if (!UUID_RE.test(String(storeId)) || String(AT).startsWith('demo-token')) throw new Error('modo demo local');
    const fd = new FormData(form);
    fd.append('store_id', storeId);
    const r = await fetch(apiURL('/products'), { method: 'POST', headers: authHeaders(), body: fd });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ('Error ' + r.status));
    
    // Éxito API
    toast('Producto publicado ✅');
  } catch (err) {
    // 2. Fallback localStorage para modo demo
    console.warn('API no disponible, guardando localmente:', err.message);
    
    let demoProducts = [];
    try { demoProducts = JSON.parse(localStorage.getItem('ga_demo_products') || '[]'); } catch {}
    demoProducts.push(productData);
    localStorage.setItem('ga_demo_products', JSON.stringify(demoProducts));
    
    toast('Producto publicado ✅');
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = originalText;
    closeModal('prodModal');
    form.reset();
    $('#fotoPrev').classList.add('hidden');
    $('#fotoPrev').src = '';
    window._all = null;
    loadProducts();
  }
}

// Helper: convertir File a Base64
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
async function delProduct(id) {
  if (!confirm('¿Eliminar producto y su foto?')) return;
  const isDemo = String(AT || '').startsWith('demo-token') || !UUID_RE.test(String(id));
  let ok = false;
  if (!isDemo) {
    const r = await api(`/products/${id}`, { method: 'DELETE', headers: authHeaders() });
    ok = r.ok;
    if (!r.ok && /sesi|401|Inicia sesión|vencida/i.test(r.error || '')) {
      AT = null; paintSession(); openModal('loginModal');
    }
  }
  if (!ok) {
    // Fallback demo local
    let demoProducts = [];
    try { demoProducts = JSON.parse(localStorage.getItem('ga_demo_products') || '[]'); } catch {}
    demoProducts = demoProducts.filter(p => String(p.id) !== String(id));
    localStorage.setItem('ga_demo_products', JSON.stringify(demoProducts));
  }
  window._all = null;
  loadProducts();
  toast('Producto eliminado ✅');
}
function renderStock() {
  const el = $('#fStk');
  if (!el) return;
  const list = window._all || products;
  el.innerHTML = list.map(p => `<div class="flex items-center gap-3 p-3">
    ${p.foto_base64 ? `<img src="${p.foto_base64}" alt="Foto de ${esc(p.nombre)}" class="w-12 h-12 object-cover rounded-xl" loading="lazy" onerror="imgFallback(this)">`
      : p.foto_url ? `<img src="${absImg(p.foto_url)}" alt="Foto de ${esc(p.nombre)}" class="w-12 h-12 object-cover rounded-xl" loading="lazy" onerror="imgFallback(this)">`
      : `<span class="text-2xl">${p.emoji || '📦'}</span>`}
    <div class="flex-1 min-w-0"><b class="text-sm text-ferrex-text block truncate">${esc(p.nombre)}</b> <span class="price-tag text-xs">${money(p.precio)}</span></div>
    <button onclick="toggleStock('${esc(p.id)}', ${!p.stock})" class="text-xs font-black px-3 py-2 rounded-full whitespace-nowrap ${p.stock ? 'bg-listo text-white' : 'bg-ferrex-danger text-white'}">${p.stock ? 'HAY ✓' : 'SIN STOCK'}</button>
    <button onclick="delProduct('${esc(p.id)}')" class="text-xs px-2 text-ferrex-text-muted hover:text-ferrex-danger" aria-label="Eliminar">🗑️</button></div>`).join('') || '<p class="text-ferrex-text-muted text-center py-6 text-sm">Sin productos todavía.</p>';
}

/* ---------- INVENTARIO MANAGEMENT ---------- */
async function loadInventory() {
  const demoSession = localStorage.getItem('ga_active_store');
  if (!AT && !demoSession) { needAuth(() => openModal('invModal')); return; }
  const listEl = $('#invList');
  if (!listEl) return;
  listEl.innerHTML = '<p class="text-ferrex-text-dim text-center py-4">Cargando inventario…</p>';

  let demoProducts = [];
  try { demoProducts = JSON.parse(localStorage.getItem('ga_demo_products') || '[]'); } catch {}
  const storeProducts = demoProducts.filter(p => String(p.store_id) === String(storeId));

  // 2 intentos con backoff; si falla, seguimos con lo local
  let apiProducts = [];
  if (UUID_RE.test(String(storeId))) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const r = await api(`/products?store_id=${storeId}`, { timeout: 15000 });
      if (r.ok) { apiProducts = Array.isArray(r.data) ? r.data : []; break; }
      console.warn(`Inventario: intento ${attempt}/2 falló:`, r.error);
      if (attempt < 2) await new Promise(res => setTimeout(res, 800 * attempt));
    }
  }

  // Deduplicar por id (API manda; demo completa)
  const byId = new Map();
  for (const p of [...apiProducts, ...storeProducts]) byId.set(String(p.id), p);
  const allProducts = [...byId.values()];

  if (!allProducts.length) {
    listEl.innerHTML = `<div class="text-center py-10">
      <p class="text-ferrex-text-dim text-lg mb-4">📦 Aún no tenés productos en tu catálogo</p>
      <button onclick="closeModal('invModal'); openModal('prodModal')" class="btn-primary px-5 py-2.5 rounded-xl text-sm">+ Agregar producto</button>
    </div>`;
    return;
  }

  listEl.innerHTML = allProducts.map(p => `
    <div class="inv-product-row" data-id="${esc(p.id)}">
      <div class="inv-product-header gap-2">
        <div class="flex items-center gap-2 min-w-0">
          ${p.foto_base64 ? `<img src="${p.foto_base64}" alt="" class="w-10 h-10 object-cover rounded-lg" loading="lazy" onerror="imgFallback(this)">`
            : p.foto_url ? `<img src="${absImg(p.foto_url)}" alt="" class="w-10 h-10 object-cover rounded-lg" loading="lazy" onerror="imgFallback(this)">`
            : `<span class="text-2xl">${p.emoji || '📦'}</span>`}
          <div class="min-w-0">
            <span class="font-bold text-ferrex-text block truncate">${esc(p.nombre)}</span>
            <span class="text-xs text-ferrex-text-dim">${esc(p.categoria)}${p.codigo ? ' · SKU: ' + esc(p.codigo) : ''}</span>
          </div>
        </div>
        <span class="stock-badge ${p.stock ? 'in-stock' : 'out-stock'}">${p.stock ? 'HAY' : 'SIN STOCK'}</span>
      </div>
      <div class="inv-product-fields">
        <div>
          <label class="text-xs text-ferrex-text-dim">Precio S/</label>
          <input type="number" step="0.10" min="0.1" value="${Number(p.precio) || 0}" class="input-dark rounded-xl px-3 py-2 text-sm" onchange="updateInventoryField('${esc(p.id)}', 'precio', this.value)">
        </div>
        <div>
          <label class="text-xs text-ferrex-text-dim">Stock (unidades)</label>
          <input type="number" min="0" value="${Number(p.stock_qty) || 0}" class="input-dark rounded-xl px-3 py-2 text-sm" onchange="updateInventoryField('${esc(p.id)}', 'stock_qty', this.value)">
        </div>
        <div class="full-width">
          <label class="text-xs text-ferrex-text-dim">Precio Oferta S/</label>
          <input type="number" step="0.10" min="0" value="${p.precio_oferta != null ? Number(p.precio_oferta) : ''}" placeholder="Opcional" class="input-dark rounded-xl px-3 py-2 text-sm" onchange="updateInventoryField('${esc(p.id)}', 'precioOferta', this.value)">
        </div>
        <div class="full-width">
          <label class="text-xs text-ferrex-text-dim">Código / SKU</label>
          <input type="text" value="${esc(p.codigo || '')}" placeholder="SKU-001" class="input-dark rounded-xl px-3 py-2 text-sm" onchange="updateInventoryField('${esc(p.id)}', 'codigo', this.value)">
        </div>
      </div>
      <div class="flex gap-2 pt-2">
        <button onclick="toggleInventoryStock('${esc(p.id)}', ${!p.stock})" class="flex-1 btn-secondary py-2 text-sm">${p.stock ? 'Marcar Sin Stock' : 'Marcar Disponible'}</button>
        <button onclick="deleteInventoryProduct('${esc(p.id)}')" class="btn-secondary py-2 text-sm bg-ferrex-danger border-ferrex-danger text-white">Eliminar</button>
      </div>
    </div>`).join('');
}

/* Funciones de inventario */
async function addInventoryProduct(e) {
  e.preventDefault();
  if (!AT && !localStorage.getItem('ga_active_store')) { needAuth(() => openModal('invModal')); return; }
  
  const form = e.target;
  const fileInput = form.querySelector('[name=foto]');
  const file = fileInput?.files?.[0];
  
  const codigo = form.querySelector('[name=codigo]').value.trim();
  const nombre = form.querySelector('[name=nombre]').value.trim();
  const precio = parseFloat(form.querySelector('[name=precio]').value);
  const categoria = form.querySelector('[name=categoria]').value;
  const stock = parseInt(form.querySelector('[name=stock]').value) || 0;
  const precioOferta = parseFloat(form.querySelector('[name=precioOferta]').value) || null;
  
  if (!codigo || !nombre || isNaN(precio) || !categoria) {
    $('#invFormError').textContent = 'Complete todos los campos obligatorios';
    $('#invFormError').classList.remove('hidden');
    return;
  }
  
  let fotoBase64 = null;
  if (file) {
    if (file.size > 5 * 1024 * 1024) { toast('Imagen > 5MB, elija otra'); return; }
    try { fotoBase64 = await fileToBase64(file); } catch { toast('Error procesando imagen'); return; }
  }
  
  const submitBtn = form.querySelector('button[type=submit]');
  const originalText = submitBtn.innerHTML;
  submitBtn.disabled = true;
  submitBtn.innerHTML = 'Guardando... <span class="animate-spin">⏳</span>';
  $('#invFormError').classList.add('hidden');
  
  const productData = {
    id: String(Date.now()),
    store_id: storeId,
    codigo,
    nombre,
    precio,
    categoria,
    stock: stock > 0,
    stock_qty: stock,
    precio_oferta: precioOferta,
    precioOferta,
    foto_base64: fotoBase64,
    creado: new Date().toISOString()
  };
  
  try {
    // 1. Intentar API (sólo tiendas reales con sesión no-demo)
    if (!UUID_RE.test(String(storeId)) || String(AT).startsWith('demo-token')) throw new Error('modo demo local');
    const fd = new FormData(form);
    fd.append('store_id', storeId);
    const r = await fetch(apiURL('/products'), { method: 'POST', headers: authHeaders(), body: fd });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ('Error ' + r.status));
    toast('Producto agregado ✅');
  } catch (err) {
    console.warn('API no disponible, guardando localmente:', err.message);
    let demoProducts = [];
    try { demoProducts = JSON.parse(localStorage.getItem('ga_demo_products') || '[]'); } catch {}
    demoProducts.push(productData);
    localStorage.setItem('ga_demo_products', JSON.stringify(demoProducts));
    toast('Producto agregado ✅');
} finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = originalText;
      form.reset();
      $('#invFotoPrev').classList.add('hidden');
      $('#invFotoPrev').src = '';
      closeModal('invModal');
      loadInventory();
      loadProducts();
    }
}
  
// Traduce los campos del inventario a lo que acepta la API
function inventoryPayload(field, value) {
  if (field === 'precioOferta' || field === 'precio_oferta') {
    const n = value === '' || value == null ? null : parseFloat(value);
    return { precio_oferta: Number.isFinite(n) && n > 0 ? n : null };
  }
  if (field === 'precio') {
    const n = parseFloat(value);
    return { precio: Number.isFinite(n) && n > 0 ? n : undefined };
  }
  if (field === 'stock_qty') {
    const n = parseInt(value);
    return { stock_qty: Number.isFinite(n) && n >= 0 ? n : 0 };
  }
  return { [field]: value };
}
// Guarda el mismo cambio en los productos demo de localStorage
function updateDemoProduct(id, field, value) {
  let demoProducts = [];
  try { demoProducts = JSON.parse(localStorage.getItem('ga_demo_products') || '[]'); } catch {}
  const idx = demoProducts.findIndex(p => String(p.id) === String(id));
  if (idx < 0) return false;
  if (field === 'precioOferta' || field === 'precio_oferta') {
    demoProducts[idx].precio_oferta = value === '' ? null : value;
    demoProducts[idx].precioOferta = value === '' ? null : value;
  } else {
    demoProducts[idx][field] = value;
  }
  try { localStorage.setItem('ga_demo_products', JSON.stringify(demoProducts)); } catch {}
  return true;
}

async function updateInventoryField(id, field, value) {
  const patch = inventoryPayload(field, value);
  const isDemo = String(AT || '').startsWith('demo-token') || !UUID_RE.test(String(id));
  let savedRemote = false;
  if (!isDemo) {
    try {
      const r = await apiAuth(`/products/${id}`, 'PATCH', patch);
      savedRemote = !r?.demo;
    } catch (err) {
      console.debug('API inventario falló:', err.message);
    }
  }
  const savedLocal = updateDemoProduct(id, field, value);
  if (savedRemote) toast('Actualizado ✅');
  else if (savedLocal) toast('Actualizado ✅');
  else toast('No se pudo actualizar ⚠️');
  loadInventory();
}

async function toggleInventoryStock(id, newStock) {
  const stock = newStock === true || newStock === 'true';
  const isDemo = String(AT || '').startsWith('demo-token') || !UUID_RE.test(String(id));
  let savedRemote = false;
  if (AT && !isDemo) {
    try {
      const r = await apiAuth(`/products/${id}/stock`, 'PATCH', { stock });
      savedRemote = !r?.demo;
    } catch (err) {
      console.debug('API stock falló:', err.message);
    }
  }
  const savedLocal = updateDemoProduct(id, 'stock', stock);
  loadInventory();
  if (savedRemote) toast(stock ? 'Producto disponible ✅' : 'Producto sin stock ❌');
  else if (savedLocal) toast(stock ? 'Disponible ✅' : 'Sin stock ❌');
}

async function deleteInventoryProduct(id) {
  if (!confirm('¿Eliminar este producto permanentemente?')) return;
  const isDemo = String(AT || '').startsWith('demo-token') || !UUID_RE.test(String(id));
  let removedRemote = false;
  if (AT && !isDemo) {
    const r = await api(`/products/${id}`, { method: 'DELETE', headers: authHeaders() });
    removedRemote = r.ok;
  }
  let demoProducts = [];
  try { demoProducts = JSON.parse(localStorage.getItem('ga_demo_products') || '[]'); } catch {}
  demoProducts = demoProducts.filter(p => String(p.id) !== String(id));
  try { localStorage.setItem('ga_demo_products', JSON.stringify(demoProducts)); } catch {}
  toast('Producto eliminado ✅');
  window._all = null;
  loadInventory();
  loadProducts();
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
    const res = await api(`/orders?store_id=${encodeURIComponent(storeId)}`);
    if (!res.ok) { $('#fPed').innerHTML = '<p class="text-ferrex-text-muted">Enciende el backend para ver pedidos.</p>'; return; }
    const list = Array.isArray(res.data) ? res.data : [];
    if (!keepSeen) list.forEach(o => { if (o.status !== 'Pendiente') seenOrders.add(o.id); });
    $('#fPed').innerHTML = list.map(o => `
      <div class="bg-ferrex-card border border-ferrex-border rounded-2xl shadow p-4 ${o.status === 'Pendiente' ? 'order-new' : ''}">
        <div class="flex justify-between items-center"><b class="text-ferrex-text">${esc(o.code)}</b>
          <span class="text-xs font-black px-2 py-1 rounded-full ${ST_CLS[o.status] || 'bg-ferrex-border'}">${esc(o.status)}</span></div>
        <p class="text-[11px] text-ferrex-text-muted">${new Date(o.created_at).toLocaleString('es-PE')}</p>
        <p class="text-sm mt-1 text-ferrex-text">${o.items.map(i => `${i.qty}× ${esc(i.nombre)}`).join(', ')}</p>
        <p class="text-xs text-ferrex-text-dim">${money(o.total)} · ${esc(o.pay)} · ${o.delivery === 'delivery' ? '🛵 ' + esc(o.address) : '🏃 Recojo · ' + esc(o.pickupName || o.address || '')}</p>
        ${o.clientZone && (o.clientZone.label || o.clientZone.distrito) ? `<p class="text-xs font-bold text-ferrex-neon">📌 Zona: ${esc(o.clientZone.label || o.clientZone.distrito)}${o.clientZone.mode === 'gps' ? ' (GPS)' : ''}</p>` : ''}
        <div class="flex gap-2 mt-2 flex-wrap">${(NEXT[o.status] || []).map(n => {
          const hot = (o.status === 'Pendiente' && n === 'Aceptado') || (o.status === 'Aceptado');
          return `<button onclick="setOrder('${o.id}','${n}')" class="text-xs font-extrabold px-3 py-2 rounded-xl ${hot ? 'bg-listo text-ferrex-bg' : 'bg-ferrex-border text-ferrex-text'}">${n}</button>`;
        }).join('')}</div>
      </div>`).join('') || '<p class="text-ferrex-text-muted">Sin pedidos aún.</p>';
  } catch { $('#fPed').innerHTML = '<p class="text-ferrex-text-muted">Enciende el backend para ver pedidos.</p>'; }
}
async function setOrder(id, st) {
  try { await apiAuth(`/orders/${id}`, 'PATCH', { status: st }); loadOrders(true); toast(`Pedido → ${st}`); }
  catch (e) { toast(e.message); }
}

// ==================== SUPERADMIN FUNCTIONS ====================

// Token de SuperAdmin (memoria + persistencia)
let adminToken = null;
try { adminToken = localStorage.getItem('ga_admin_token') || null; } catch {}

function adminHeaders(extra = {}) {
  return adminToken ? { ...extra, 'x-admin-token': adminToken } : extra;
}

async function adminApi(path, method = 'GET', body) {
  const result = await api(path, {
    method,
    headers: adminHeaders({ 'Content-Type': 'application/json' }),
    body: body !== undefined ? JSON.stringify(body) : undefined,
    timeout: 30000 // Render free tier puede tardar por cold start
  });
  if (!result.ok) throw new Error(result.error || 'Error de API');
  return result.data;
}

async function adminLogin(e) {
  e.preventDefault();
  const email = $('#adminEmail').value.trim();
  const password = $('#adminPassword').value;
  const errEl = $('#adminLoginError');
  const btn = $('#adminLoginBtn');
  errEl.classList.add('hidden');
  btn.disabled = true;
  btn.textContent = 'Entrando…';
  try {
    const res = await api('/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: email, password }),
      timeout: 30000
    });
    if (!res.ok) throw new Error(res.error || 'Credenciales inválidas');
    adminToken = res.data.token || 'cookie';
    try { localStorage.setItem('ga_admin_token', adminToken); } catch {}
    if ($('#adminWho')) $('#adminWho').textContent = res.data.admin?.email || email;
    showAdminDashboard();
    await loadSuperAdminData();
    toast('Bienvenido, SuperAdmin 🔐');
  } catch (err) {
    errEl.textContent = '⚠ ' + (err.message || 'No se pudo iniciar sesión');
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Entrar 🔓';
  }
}

function showAdminDashboard() {
  $('#adminLoginBox')?.classList.add('hidden');
  $('#adminDashboard')?.classList.remove('hidden');
}

function adminLogout() {
  adminToken = null;
  try { localStorage.removeItem('ga_admin_token'); } catch {}
  $('#adminDashboard')?.classList.add('hidden');
  $('#adminLoginBox')?.classList.remove('hidden');
  if ($('#adminPassword')) $('#adminPassword').value = '';
}

// Cargar datos del SuperAdmin
async function loadSuperAdminData() {
  if (!adminToken) return;
  try {
    $('#superAdminStoresList').innerHTML = '<tr><td colspan="7" class="text-center py-4 text-ferrex-text-dim">Cargando…</td>';
    const stores = await adminApi('/admin/ferreterias');
    const stats = await adminApi('/admin/stats');

    if (stats) {
      $('#statTotalSales').textContent = money(stats.total_ventas || 0);
      $('#statCompletedOrders').textContent = stats.completados || 0;
      $('#statTotalStores').textContent = stats.total_ferreterias || 0;
    }

    const list = Array.isArray(stores) ? stores : [];
    const rate = (parseFloat($('#commissionRate')?.value) || 15) / 100;
    $('#superAdminStoresList').innerHTML = list.map(s => {
      const revenue = Number(s.total_sales || 0);
      const commission = revenue * rate;
      return `<tr class="border-t border-ferrex-border">
        <td class="px-3 py-2"><b class="text-ferrex-text">${esc(s.nombre)}</b></td>
        <td class="px-3 py-2 text-xs text-ferrex-text-dim">${esc(s.ruc_dni || '—')}</td>
        <td class="px-3 py-2 text-xs text-ferrex-text-dim">${esc(s.telefono || '—')}</td>
        <td class="px-3 py-2 text-center">
          <span class="px-2 py-0.5 rounded-full text-xs font-bold ${s.abierta !== false ? 'bg-listo text-plomoDark' : 'bg-ferrex-danger text-white'}">${s.abierta !== false ? 'Activo' : 'Inactivo'}</span></td>
        <td class="px-3 py-2 text-right text-sm text-ferrex-text">${money(revenue)}</td>
        <td class="text-right px-3 py-2 text-sm text-ferrex-text-dim">${money(commission)}</td>
        <td class="text-center px-3 py-2 text-xs font-bold text-ferrex-warning">${money(commission)}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="7" class="text-center py-4 text-ferrex-text-dim">No hay ferreterías registradas</td>';
  } catch (err) {
    console.error('Error loading superadmin data:', err);
    $('#superAdminStoresList').innerHTML = '<tr><td colspan="7" class="text-center py-4 text-ferrex-danger">Error: ' + esc(err.message) + '</td></tr>';
    if (/401|admin|autentic|sesi/i.test(err.message)) adminLogout();
  }
}

// Cargar datos del SuperAdmin al abrir el modal
function openSuperAdminModal() {
  openModal('superAdminModal');
  if (adminToken) {
    showAdminDashboard();
    loadSuperAdminData();
  } else {
    $('#adminLoginBox')?.classList.remove('hidden');
    $('#adminDashboard')?.classList.add('hidden');
  }
}

// Guardar configuración de comisión
async function saveCommissionConfig() {
  const rate = parseFloat($('#commissionRate').value) || 15;
  const currency = $('#commissionCurrency').value;
  try {
    await adminApi('/admin/commission', 'POST', { rate, currency });
    toast('Configuración de comisión guardada ✅');
    loadSuperAdminData();
  } catch (e) {
    toast('Error guardando configuración');
  }
}

function resetCommissionConfig() {
  $('#commissionRate').value = 15;
  $('#commissionCurrency').value = 'PEN';
  toast('Configuración restablecida');
}

async function calculateAllCommissions() {
  try {
    const rate = parseFloat($('#globalCommissionRate')?.value) || parseFloat($('#commissionRate')?.value) || 15;
    const data = await adminApi('/admin/commissions/calculate', 'POST', { rate });
    $('#totalCommissionDue').textContent = money(data.total_commission || 0);
    toast('Comisiones calculadas ✅');
    loadSuperAdminData(); // Recargar tabla
  } catch (e) {
    toast('Error calculando comisiones');
  }
}

function exportCommissionsCSV() {
  try {
    const rows = [['Ferreteria', 'RUC/DNI', 'Telefono', 'Ingresos', 'Comision']];
    document.querySelectorAll('#superAdminStoresList tr').forEach(tr => {
      const tds = tr.querySelectorAll('td');
      if (tds.length >= 7) {
        rows.push([
          tds[0].innerText.trim(),
          tds[1].innerText.trim(),
          tds[2].innerText.trim(),
          tds[4].innerText.trim(),
          tds[5].innerText.trim()
        ]);
      }
    });
    const csv = rows.map(r => r.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\n');
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'comisiones-ferrex-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast('CSV exportado ✅');
  } catch (e) {
    toast('Error exportando CSV');
  }
}

// Initialize app
document.addEventListener('DOMContentLoaded', () => {
  // Desactivar modo demo al cargar
  localStorage.removeItem('ga_demo_mode');

  // 🔍 Registrar Service Worker (PWA offline)
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('/sw.js')
      .then(reg => console.log('[FERREX] SW registrado:', reg.scope))
      .catch(err => console.warn('[FERREX] SW registro falló:', err));
  }

  try {
    init();
  } catch (err) {
    console.error('Error inicializando app:', err);
  }
});

// Close modal on overlay click
document.addEventListener('click', e => {
  if (e.target.classList.contains('modal-overlay') || e.target.matches('[data-close-modal]')) {
    const modal = e.target.closest('.modal');
    if (modal) closeModal(modal.id);
  }
});
