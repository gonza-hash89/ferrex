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
function previewImage(input) {
  const file = input.files?.[0];
  const preview = $('#fotoPrev');
  if (!file) { preview.classList.add('hidden'); return; }
  if (file.size > 5 * 1024 * 1024) { toast('Imagen > 5MB, elija otra'); input.value = ''; preview.classList.add('hidden'); return; }
  const reader = new FileReader();
  reader.onload = e => { preview.src = e.target.result; preview.classList.remove('hidden'); };
  reader.readAsDataURL(file);
}
function absImg(u) { if (!u) return u; return u.startsWith('/') ? API_BASE + u : u; }
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.remove('hidden'); setTimeout(() => t.classList.add('hidden'), 2200); }
function openModal(id) { $('#' + id).classList.remove('hidden'); }
function closeModal(id) { $('#' + id).classList.add('hidden'); }
function unlockAudio() { try { if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)(); if (audioCtx.state === 'suspended') audioCtx.resume(); } catch {} }
document.addEventListener('pointerdown', unlockAudio, { once: true });

async function api(path, opts = {}) {
  try {
    const r = await fetch(apiURL(path), opts);
    let j = null; 
    try { j = await r.json(); } catch { throw new Error('Respuesta inválida del servidor'); }
    if (!r.ok || j.ok === false) throw new Error(j.error || ('Error ' + r.status));
    return { ok: true, data: j };
  } catch (err) {
    // Modo demo silencioso - no lanzar error, retornar flag
    console.debug('API unavailable (demo mode):', err.message);
    return { ok: false, error: err.message, demo: true };
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
  
  // Restaurar sesión demo si existe
  const demoSession = localStorage.getItem('ga_active_store');
  if (demoSession) {
    try {
      const store = JSON.parse(demoSession);
      storeId = store.id;
      localStorage.setItem('ga_store', storeId);
      AT = 'demo-token-' + Date.now();
      await loadStores();
      paintSession();
    } catch {}
  }
  
  const healthResult = await api('/health');
  if (healthResult.ok) {
    const h = healthResult.data;
    $('#apiStat').innerHTML = `● API conectada v${h.version || ''} · ${API_BASE ? esc(API_BASE) : 'mismo origen'} · <button onclick="configAPI()" class="underline">⚙️ cambiar backend</button>`;
    $('#apiStat').className = 'text-center text-[11px] py-1 bg-listo text-plomoDark';
  } else {
    // Modo demo silencioso - sin error visible bloqueante
    $('#apiStat').innerHTML = `○ Modo demo (offline) · <button onclick="configAPI()" class="underline">⚙️ configurar API</button>`;
    $('#apiStat').className = 'text-center text-[11px] py-1 bg-ferrex-warning text-ferrex-bg';
  }
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
  let apiStores = [];
  const storesResult = await api('/stores' + qs);
  if (storesResult.ok) apiStores = storesResult.data;
  // Incluir tiendas demo de localStorage
  let demoStores = [];
  try { demoStores = JSON.parse(localStorage.getItem('ga_demo_stores') || '[]'); } catch {}
  stores = [...apiStores, ...demoStores];
  // Filtrar por distrito si hay ubicación manual
  if (loc && loc.mode === 'manual' && loc.distrito) {
    stores = stores.filter(s => s.distrito === loc.distrito);
  }
  if (!stores.length) { 
    toast(`Sin ferreterías en ${loc?.distrito || 'tu zona'} — registra la tuya`); 
    stores = [...apiStores, ...demoStores]; // mostrar todas si filtro no da resultados
  }
  if (!stores.find(s => s.id === storeId)) { storeId = stores[0]?.id || 1; localStorage.setItem('ga_store', storeId); }
  $('#storeSel').innerHTML = stores.map(s => {
    const d = s.distance_km != null ? ` · a ${s.distance_km} km (~${s.eta_min} min)` : '';
    const st = s.abierto_ahora === false ? ' · 🔴 Cerrado' : '';
    const demoBadge = demoStores.some(ds => ds.id === s.id) ? ' · 🧪 Demo' : '';
    return `<option value="${s.id}" ${s.id === storeId ? 'selected' : ''}>${esc(s.nombre)} · ${esc(s.distrito)}${d}${st}${demoBadge}</option>`;
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
    // 1. Intentar API
    const r = await fetch(apiURL('/auth/login'), { 
      method: 'POST', 
      headers: { 'Content-Type': 'application/json' }, 
      credentials: 'include', 
      body: JSON.stringify({ identifier, password }) 
    });
    const j = await r.json().catch(() => ({}));
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
    
    // Buscar por teléfono o celular
    const matchedStore = demoStores.find(s => 
      (s.telefono === identifier || s.whatsapp === identifier || s.celular === identifier) && 
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
  // Primero buscar en stores (API + demo)
  let s = stores.find(s => s.id === storeId);
  // Si no está en stores, buscar en localStorage demo
  if (!s) {
    try {
      const demoStores = JSON.parse(localStorage.getItem('ga_demo_stores') || '[]');
      s = demoStores.find(ds => ds.id === storeId);
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
  const form = e.target;
  const submitBtn = $('#storeSubmitBtn');
  const errorDiv = $('#storeFormError');
  
  // Validación de campos requeridos
  const fd = new FormData(form);
  const nombre = fd.get('nombre')?.trim();
  const distrito = fd.get('distrito')?.trim();
  const password = fd.get('password');
  const aceptaTerminos = fd.get('aceptaTerminos');
  const dias = [...form.querySelectorAll('#regDias input:checked')].map(i => Number(i.value));
  
  if (!nombre || !distrito || !password || !aceptaTerminos) {
    errorDiv.textContent = '⚠ Complete todos los campos obligatorios y acepte los términos.';
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
    if (s.accessToken) AT = s.accessToken;
    toast('¡Ferretería registrada correctamente! ✅');
    closeModal('storeModal'); 
    form.reset(); 
    $('#logoPrev').classList.add('hidden');
    $('#regDias').innerHTML = [1,2,3,4,5,6,0].map(d =>
      `<label class="text-[11px] bg-ferrex-bg border border-ferrex-border rounded-lg px-2 py-1 cursor-pointer"><input type="checkbox" value="${d}" ${[1,2,3,4,5,6].includes(d) ? 'checked' : ''} class="accent-ferrex-neon"> ${['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'][d]}</label>`).join('');
    await loadStores(); 
    storeId = s.id; 
    localStorage.setItem('ga_store', s.id); 
    $('#storeSel').value = s.id;
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
      logo: null,
      abierto: true,
      creado: new Date().toISOString()
    };
    
    try {
      const existing = JSON.parse(localStorage.getItem('ga_demo_stores') || '[]');
      existing.push(demoStore);
      localStorage.setItem('ga_demo_stores', JSON.stringify(existing));
    } catch {}
    
    toast('¡Ferretería registrada localmente (modo demo)! ✅');
    closeModal('storeModal'); 
    form.reset(); 
    $('#logoPrev').classList.add('hidden');
    $('#regDias').innerHTML = [1,2,3,4,5,6,0].map(d =>
      `<label class="text-[11px] bg-ferrex-bg border border-ferrex-border rounded-lg px-2 py-1 cursor-pointer"><input type="checkbox" value="${d}" ${[1,2,3,4,5,6].includes(d) ? 'checked' : ''} class="accent-ferrex-neon"> ${['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'][d]}</label>`).join('');
    await loadStores(); 
    storeId = demoStore.id; 
    localStorage.setItem('ga_store', demoStore.id); 
    $('#storeSel').value = demoStore.id;
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
  const q = $('#q').value || '';
  let apiProducts = [];
  const productsResult = await api(`/products?store_id=${storeId}&q=${encodeURIComponent(q)}${activeCat !== 'Todo' ? '&cat=' + encodeURIComponent(activeCat) : ''}`);
  if (productsResult.ok) apiProducts = productsResult.data;
  
  // Cargar productos demo de localStorage
  let demoProducts = [];
  try { demoProducts = JSON.parse(localStorage.getItem('ga_demo_products') || '[]'); } catch {}
  const storeDemoProducts = demoProducts.filter(p => p.store_id === storeId);
  
  products = [...apiProducts, ...storeDemoProducts];
  
  $('#cats').innerHTML = CATS.map(c => `<button onclick="activeCat='${c}';loadProducts()" class="whitespace-nowrap px-4 py-2 rounded-full text-xs font-bold border ${activeCat === c ? 'bg-ferrex-card border-ferrex-neon text-ferrex-neon' : 'bg-ferrex-card border-ferrex-border'}">${c}</button>`).join('');
  $('#grid').innerHTML = products.filter(p => p.stock).map(p => `
    <div class="product-card p-3">
      ${p.foto_base64 ? `<img src="${p.foto_base64}" alt="${esc(p.nombre)}" class="w-full h-40 object-cover rounded-xl" loading="lazy" onerror="imgFallback(this)">`
        : p.foto_url ? `<img src="${absImg(p.foto_url)}" alt="${esc(p.nombre)}" class="w-full h-40 object-cover rounded-xl" loading="lazy" onerror="imgFallback(this)">`
        : `<div class="text-5xl text-center bg-ferrex-bg rounded-xl py-8">${p.emoji || '📦'}</div>`}
      <p class="text-[11px] text-ferrex-text-muted font-bold mt-2">${esc(p.categoria)}</p>
      <h3 class="font-extrabold text-sm leading-tight text-ferrex-text">${esc(p.nombre)}</h3>
      <span class="price-tag text-sm mt-1">${money(p.precio)}</span>
      <button onclick="addCart(${p.id})" class="w-full mt-2 btn-primary py-2 rounded-xl text-sm">Agregar al carrito</button>
    </div>`).join('') || '<p class="text-ferrex-text-muted col-span-3 text-center py-8">Sin productos. La ferretería puede subir fotos con "Agregar producto".</p>';
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
  if (!window._all) { 
    const allResult = await api(`/products?store_id=${storeId}`);
    if (allResult.ok) window._all = allResult.data;
    else window._all = products;
  }
  const t = totals();
  $('#cartN').textContent = t.n;
  const all = [...products, ...(window._all || [])];
  $('#cartBox').innerHTML = t.n === 0 ? '<p class="text-ferrex-text-muted text-center">Vacío</p>' :
    Object.entries(cart).map(([id, q]) => { const p = all.find(x => x.id == id); if (!p) return '';
      return `<div class="flex justify-between items-center bg-ferrex-bg rounded-xl p-2"><span><b>${q}×</b> ${esc(p.nombre)}</span><b class="text-ferrex-neon">${money(p.precio * q)}</b></div>`; }).join('');
  $('#subT').textContent = money(t.sub);
  $('#shT').textContent = t.n === 0 ? '—' : (t.del ? `${money(SHIPPING_COST)}` : 'Gratis (recojo en tienda)');
  $('#toT').textContent = money(t.total);
}

/* ---------- 1. Checkout + WhatsApp ---------- */
function currentStore() { return stores.find(s => s.id === storeId); }

function buildWhatsAppMessage(t, store) {
  const all = [...products, ...(window._all || [])];
  const itemsText = Object.entries(cart).map(([id, q]) => {
    const p = all.find(x => x.id == id);
    return `• ${q}x ${p?.nombre || 'Producto'} - S/ ${(p?.precio || 0).toFixed(2)}`;
  }).join('\n');
  
  const deliveryText = t.del 
    ? `🚚 Delivery a: ${$('#addr').value.trim() || 'Dirección no especificada'}`
    : `🏪 Recojo en tienda${$('#pickupName').value.trim() ? ` - Quien recoge: ${$('#pickupName').value.trim()}` : ''}`;
  
  const paymentText = `💳 Pago: ${pay}`;
  const subtotal = t.sub;
  const shipping = t.del ? SHIPPING_COST : 0;
  
  return `📋 *Nuevo Pedido FERREX*\n${itemsText}\n${deliveryText}\n${paymentText}\n💰 Subtotal: S/ ${subtotal.toFixed(2)}\n🚚 Envío: S/ ${shipping.toFixed(2)}\n*Total a pagar: S/ ${t.total.toFixed(2)}*\n\n_Ferretería: ${store?.nombre || 'FERREX'}_`;
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
  const store = stores.find(s => s.id === storeId) || 
    JSON.parse(localStorage.getItem('ga_demo_stores') || '[]').find(s => s.id === storeId);
  
  if (!store) {
    toast('No hay ferretería seleccionada');
    return;
  }
  
  // Obtener teléfono de la tienda
  const rawPhone = store.whatsapp || store.telefono || store.celular;
  const phone = normalizePhone(rawPhone);
  
  if (!phone) {
    toast('La ferretería no tiene teléfono/WhasApp configurado');
    return;
  }
  
  // Construir mensaje y URL de WhatsApp LOCALMENTE
  const message = buildWhatsAppMessage(t, store);
  const whatsappUrl = `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
  
  const btn = $('#sendBtn'); 
  btn.disabled = true; 
  btn.textContent = 'Abriendo WhatsApp…';
  
  try {
    // 1. Abrir WhatsApp INMEDIATAMENTE (frontend-first)
    window.open(whatsappUrl, '_blank');
    toast('Abriendo WhatsApp… 📲');
    
    // 2. Mostrar confirmación en UI
    $('#orderOk').classList.remove('hidden');
    $('#okCode').textContent = `Pedido FERREX-${Date.now().toString().slice(-6)}`;
    $('#okTxt').textContent = `${t.n} productos · ${t.del ? 'Delivery' : 'Recojo'} · ${pay} · Total ${money(t.total)}`;
    const a = $('#waCta');
    a.href = whatsappUrl;
    a.classList.remove('hidden');
    window._lastWa = message;
    
    // 3. Limpiar carrito
    cart = {}; 
    renderCart();
    
    // 4. Guardar en API EN BACKGROUND (no bloquea)
    const body = {
      store_id: storeId, 
      items: Object.entries(cart).map(([id, q]) => { 
        const p = all.find(x => x.id == id); 
        return { product_id: Number(id), nombre: p?.nombre || 'Producto', qty: q, price: p?.precio || 0 }; 
      }), 
      total: t.total, pay,
      address: $('#addr').value.trim(),
      pickupName: $('#pickupName').value.trim(),
      delivery: t.del ? 'delivery' : 'recojo',
      clientZone: getLoc()
    };
    
    // Fire-and-forget: intentar guardar en API, pero no bloquear
    api('/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(o => {
        // Si API responde, actualizar código de pedido
        $('#okCode').textContent = `Pedido ${o.code}`;
        window._lastWa = o.whatsapp_message || message;
      })
      .catch(err => {
        // Silencioso: modo demo
        console.debug('API order save failed (demo mode):', err.message);
      });
    
  } finally {
    btn.disabled = false; 
    btn.textContent = 'Confirmar pedido por WhatsApp →';
  }
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
  const newStock = val === true || val === 'true';
  try {
    // 1. Intentar API
    await apiAuth(`/products/${id}`, 'PATCH', { stock: newStock });
  } catch (err) {
    // 2. Fallback localStorage demo
    console.warn('API stock toggle falló, actualizando localStorage:', err.message);
    let demoProducts = [];
    try { demoProducts = JSON.parse(localStorage.getItem('ga_demo_products') || '[]'); } catch {}
    const idx = demoProducts.findIndex(p => p.id === id);
    if (idx >= 0) {
      demoProducts[idx].stock = newStock;
      localStorage.setItem('ga_demo_products', JSON.stringify(demoProducts));
    }
    // También actualizar en stores si está ahí
    const storeIdx = products.findIndex(p => p.id === id);
    if (storeIdx >= 0) products[storeIdx].stock = newStock;
  }
  window._all = null;
  loadProducts();
  toast(newStock ? 'Producto disponible ✅' : 'Producto agotado ❌');
}

async function saveProduct(e) {
  e.preventDefault();
  if (!AT) { closeModal('prodModal'); needAuth(() => openModal('prodModal')); return; }
  
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
    // 1. Intentar API
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
    
    toast('Producto publicado localmente (modo demo) ✅');
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
    ${p.foto_base64 ? `<img src="${p.foto_base64}" alt="Foto de ${esc(p.nombre)}" class="w-12 h-12 object-cover rounded-xl" loading="lazy" onerror="imgFallback(this)">`
      : p.foto_url ? `<img src="${absImg(p.foto_url)}" alt="Foto de ${esc(p.nombre)}" class="w-12 h-12 object-cover rounded-xl" loading="lazy" onerror="imgFallback(this)">`
      : `<span class="text-2xl">${p.emoji || '📦'}</span>`}
    <div class="flex-1"><b class="text-sm text-ferrex-text">${esc(p.nombre)}</b> <span class="price-tag text-xs">${money(p.precio)}</span></div>
    <button onclick="toggleStock(${p.id},${!p.stock})" class="text-xs font-black px-3 py-2 rounded-full ${p.stock ? 'bg-listo text-plomoDark' : 'bg-ferrex-danger text-white'}">${p.stock ? 'HAY ✓' : 'SIN STOCK'}</button>
    <button onclick="delProduct(${p.id})" class="text-xs px-2 text-ferrex-text-muted hover:text-ferrex-danger" aria-label="Eliminar">🗑️</button></div>`).join('');
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

// Inicialización segura con DOMContentLoaded
document.addEventListener('DOMContentLoaded', () => {
  try {
    init();
  } catch (err) {
    console.error('Error inicializando app:', err);
  }
});

// Safe event listener helpers
function safeOn(id, event, handler) {
  document.getElementById(id)?.addEventListener(event, handler);
}
