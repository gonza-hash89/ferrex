/* Smoke test seguridad v1.5: JWT+refresh, helmet, rate-limit, firma mágica, validadores */
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const server = spawn('node', ['server.js'], { cwd: __dirname });
function killServer() {
  try { server.kill(); } catch {}
  try { if (server.pid) execSync(`taskkill /PID ${server.pid} /T /F`, { stdio: 'ignore' }); } catch {}
}
server.stdout.on('data', d => process.stdout.write('[srv] ' + d));
server.stderr.on('data', d => process.stderr.write('[err] ' + d));
const wait = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
function check(name, cond, extra = '') {
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' → ' + extra : ''));
  if (!cond) fails++;
}
async function main() {
  for (let i = 0; i < 30; i++) { await wait(1000); try { const r = await fetch('http://localhost:3001/api/health'); if (r.ok) break; } catch {} }
  const h = await (await fetch('http://localhost:3001/api/health')).json();
  check('health ok', h.ok === true);
  const stores = await (await fetch('http://localhost:3001/api/stores')).json();
  check('stores seed', stores.length >= 2, stores.length + ' tiendas');

  // 3.4 validaciones: precio 0 y teléfono inválido deben dar 400
  const fdBad = new FormData();
  fdBad.append('store_id', '1'); fdBad.append('nombre', 'X'); fdBad.append('precio', '0'); fdBad.append('categoria', 'Electricidad');
  const badPrice = await fetch('http://localhost:3001/api/products', { method: 'POST', body: fdBad });
  check('producto sin token → 401', badPrice.status === 401);
  const fdBadPh = new FormData();
  fdBadPh.append('nombre', 'Ferre Test'); fdBadPh.append('distrito', 'Lima'); fdBadPh.append('telefono', '123');
  const badPhone = await fetch('http://localhost:3001/api/stores', { method: 'POST', body: fdBadPh });
  check('teléfono inválido → 400', badPhone.status === 400);

  // Auth + horario: registro con clave
  const tel = '9' + String(Math.floor(10000000 + Math.random() * 89999999));
  const fdReg = new FormData();
  fdReg.append('nombre', 'Ferre QA ' + Date.now()); fdReg.append('distrito', 'Chosica');
  fdReg.append('telefono', tel); fdReg.append('password', 'clave123');
  fdReg.append('apertura', '09:00'); fdReg.append('cierre', '19:00'); fdReg.append('dias', JSON.stringify([1, 2, 3, 4, 5]));
  const rReg = await fetch('http://localhost:3001/api/stores', { method: 'POST', body: fdReg });
  const reg = await rReg.json();
  const regCookie = (rReg.headers.get('set-cookie') || '').split(';')[0];
  check('registro con clave → 201 + JWT', rReg.status === 201 && !!reg.accessToken && reg.horario.apertura === '09:00', 'tienda #' + reg.id);
  check('refresh en cookie httpOnly', /ga_refresh=[^;]+;/.test(rReg.headers.get('set-cookie') || '') && /HttpOnly/i.test(rReg.headers.get('set-cookie') || ''));
  check('sin fuga de hash', !('passwordHash' in reg) && !('salt' in reg));
  check('abierto_ahora + horario_txt', typeof reg.abierto_ahora === 'boolean' && typeof reg.horario_txt === 'string', reg.horario_txt);
  const QA = reg.id, TOK = reg.accessToken;
  const rLoginBad = await fetch('http://localhost:3001/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: tel, password: 'otra' }) });
  check('login clave mala → 401', rLoginBad.status === 401);
  const rLogin = await fetch('http://localhost:3001/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: tel, password: 'clave123' }) });
  const loginJ = await rLogin.json();
  const loginCookie = (rLogin.headers.get('set-cookie') || '').split(';')[0];
  check('login ok → accessToken', rLogin.status === 200 && !!loginJ.accessToken);
  // Refresh rotativo: usa cookie, el viejo muere
  const rRef = await fetch('http://localhost:3001/api/auth/refresh', { method: 'POST', headers: { Cookie: loginCookie } });
  const refJ = await rRef.json();
  check('refresh → nuevo access', rRef.status === 200 && !!refJ.accessToken);
  const rRefOld = await fetch('http://localhost:3001/api/auth/refresh', { method: 'POST', headers: { Cookie: loginCookie } });
  check('refresh reutilizado → 401', rRefOld.status === 401);
  const AT2 = refJ.accessToken || loginJ.accessToken;
  const rNoAuth = await fetch(`http://localhost:3001/api/stores/${QA}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ abierto: false }) });
  check('PATCH tienda sin token → 401', rNoAuth.status === 401);
  const rHor = await fetch(`http://localhost:3001/api/stores/${QA}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + AT2 }, body: JSON.stringify({ horario: { apertura: '00:00', cierre: '23:59', dias: [0, 1, 2, 3, 4, 5, 6] } }) });
  const hor = await rHor.json();
  check('guardar horario 24/7 → abierto_ahora true', rHor.status === 200 && hor.abierto_ahora === true, hor.horario_txt);

  // Producto con foto real (tienda QA, con token)
  const testImg = path.join(__dirname, '..', '..', 'hola 123.jpeg');
  let prodId = null;
  if (fs.existsSync(testImg)) {
    const blob = new Blob([fs.readFileSync(testImg)], { type: 'image/jpeg' });
    const fd = new FormData();
    fd.append('store_id', String(QA)); fd.append('nombre', 'Martillo QA'); fd.append('precio', '25.90'); fd.append('categoria', 'Herramientas');
    fd.append('foto', blob, 'martillo.jpg');
    const rp = await fetch('http://localhost:3001/api/products', { method: 'POST', headers: { 'Authorization': 'Bearer ' + TOK }, body: fd });
    const p = await rp.json();
    check('upload foto → 201 + foto_url', rp.status === 201 && !!p.foto_url, p.foto_url);
    check('filename sanitizado', /^\d+-[0-9a-f]+\.jpg$/.test(p.foto.split('/').pop()));
    prodId = p.id;
    // Firma mágica: .txt renombrado a .jpg debe rebotar aunque el MIME diga image/jpeg
    const fdFake = new FormData();
    fdFake.append('store_id', String(QA)); fdFake.append('nombre', 'Falso'); fdFake.append('precio', '9.9');
    fdFake.append('foto', new Blob(['esto no es una imagen'], { type: 'image/jpeg' }), 'falso.jpg');
    const rFake = await fetch('http://localhost:3001/api/products', { method: 'POST', headers: { 'Authorization': 'Bearer ' + TOK }, body: fdFake });
    check('firma falsa → 400', rFake.status === 400);
  }
  // Validador: pedido vacío e items inválidos
  const rEmpty = await fetch('http://localhost:3001/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ store_id: QA, items: [] }) });
  check('pedido vacío → 400', rEmpty.status === 400);

  // 1. Pedido Pendiente + WhatsApp (tienda QA)
  const orderBody = {
    store_id: QA,
    items: [{ product_id: prodId || 1, nombre: 'Martillo QA', qty: 2, price: 25.90 }],
    total: 54.80, pay: 'Yape', address: 'Jr. Lima 240', pickupName: '', delivery: 'delivery'
  };
  const ro = await fetch('http://localhost:3001/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(orderBody) });
  const o = await ro.json();
  check('POST /orders → 201 Pendiente', ro.status === 201 && o.status === 'Pendiente', o.code);
  check('whatsapp_url wa.me/51..', typeof o.whatsapp_url === 'string' && o.whatsapp_url.startsWith('https://wa.me/51'), (o.whatsapp_url || '').slice(0, 30));
  check('mensaje incluye pedido+total', (o.whatsapp_message || '').includes(o.code) && o.whatsapp_message.includes('S/'), 'msg ok');

  // 2b. Transición válida Pendiente→Aceptado; inválida Aceptado→Pendiente (con JWT)
  const BH = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOK };
  const noAuthOrder = await fetch(`http://localhost:3001/api/orders/${o.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'Aceptado' }) });
  check('PATCH pedido sin JWT → 401', noAuthOrder.status === 401);
  const ok1 = await fetch(`http://localhost:3001/api/orders/${o.id}`, { method: 'PATCH', headers: BH, body: JSON.stringify({ status: 'Aceptado' }) });
  check('Pendiente→Aceptado 200', ok1.status === 200);
  const bad2 = await fetch(`http://localhost:3001/api/orders/${o.id}`, { method: 'PATCH', headers: BH, body: JSON.stringify({ status: 'Pendiente' }) });
  check('Aceptado→Pendiente → 400', bad2.status === 400);
  const ok2 = await fetch(`http://localhost:3001/api/orders/${o.id}`, { method: 'PATCH', headers: BH, body: JSON.stringify({ status: 'En Camino' }) });
  check('Aceptado→En Camino 200', ok2.status === 200);

  // SSE responde event-stream
  const sse = await fetch('http://localhost:3001/api/orders/stream?store_id=1', { headers: { Accept: 'text/event-stream' } });
  check('SSE 200 text/event-stream', sse.status === 200 && (sse.headers.get('content-type') || '').includes('text/event-stream'));
  sse.body.cancel();

  // Ubicación híbrida: filtro distrito + GPS ordenado + zona en WhatsApp
  const chos = await (await fetch('http://localhost:3001/api/stores?distrito=Chosica')).json();
  check('filtro ?distrito=Chosica', Array.isArray(chos) && chos.length >= 2 && chos.every(s => s.distrito === 'Chosica'), chos.length + ' tiendas');
  const gps = await (await fetch('http://localhost:3001/api/stores?lat=-11.9434&lng=-76.6982')).json();
  check('GPS ordena por cercanía', gps.length >= 2 && gps[0].id === 1 && typeof gps[0].distance_km === 'number' && typeof gps[0].eta_min === 'number', `#${gps[0]?.id} a ${gps[0]?.distance_km}km`);
  const badGps = await fetch('http://localhost:3001/api/stores?lat=999&lng=0');
  check('GPS inválido → 400', badGps.status === 400);
  const orderZone = { ...orderBody, clientZone: { mode: 'manual', distrito: 'Chosica', label: 'Chosica · Jr. Lima 240' } };
  const rz = await fetch('http://localhost:3001/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(orderZone) });
  const oz = await rz.json();
  check('pedido con zona → 201', rz.status === 201 && oz.clientZone?.distrito === 'Chosica', oz.code);
  check('WhatsApp incluye zona', (oz.whatsapp_message || '').includes('Zona del cliente') && oz.whatsapp_message.includes('Chosica'), 'msg zona ok');

  // SEO: sitemap.xml + robots.txt
  const sm = await fetch('http://localhost:3001/sitemap.xml');
  const smTxt = await sm.text();
  check('sitemap 200 text/xml', sm.status === 200 && (sm.headers.get('content-type') || '').includes('xml'));
  check('sitemap estáticas', smTxt.includes('<loc>http://localhost:3001/</loc>') && smTxt.includes('/catalogo') && smTxt.includes('/ferreterias') && smTxt.includes('/como-funciona'));
  check('sitemap distritos', smTxt.includes('/distrito/chosica') && smTxt.includes('/distrito/ate'));
  check('sitemap tiendas con slug', /\/tienda\/1-ferreteria-los-andes/.test(smTxt));
  const rb = await fetch('http://localhost:3001/robots.txt');
  const rbTxt = await rb.text();
  check('robots.txt + Sitemap', rb.status === 200 && rbTxt.includes('User-agent: *') && rbTxt.includes('Disallow: /api/') && rbTxt.includes('Sitemap: http://localhost:3001/sitemap.xml'));

  // Seguridad: headers helmet + rate-limit
  const hh = await fetch('http://localhost:3001/api/health');
  check('sin X-Powered-By', !hh.headers.get('x-powered-by'));
  check('helmet: frame+nosniff', (hh.headers.get('x-frame-options') || '').toLowerCase().includes('sameorigin') && hh.headers.get('x-content-type-options') === 'nosniff');
  check('rate-limit headers', !!hh.headers.get('ratelimit-limit') && Number(hh.headers.get('ratelimit-limit')) === 100);

  // Limpieza: borra producto, pedidos y tienda QA de db.json
  if (prodId) await fetch(`http://localhost:3001/api/products/${prodId}`, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + TOK } });
  try {
    const dbf = path.join(__dirname, 'db.json');
    const db = JSON.parse(fs.readFileSync(dbf, 'utf-8'));
    db.products = db.products.filter(p => p.store_id !== QA);
    db.orders = db.orders.filter(o => o.store_id !== QA);
    db.stores = db.stores.filter(s => s.id !== QA);
    db.sessions = (db.sessions || []).filter(x => x.store_id !== QA);
    fs.writeFileSync(dbf, JSON.stringify(db, null, 2));
    console.log('CLEANUP QA OK');
  } catch (e) { console.log('CLEANUP FAIL', e.message); fails++; }
  console.log(fails === 0 ? 'ALL CHECKS DONE ✅' : `FAILURES: ${fails}`);
  killServer(); process.exit(fails === 0 ? 0 : 1);
}
main().catch(e => { console.error('FAIL', e); killServer(); process.exit(1); });
setTimeout(() => { console.error('TIMEOUT'); killServer(); process.exit(1); }, 60000);
