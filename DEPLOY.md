# Despliegue a producción — G&A Casero v1.1

## 1. Qué incluye esta versión
- Checkout con pedido `Pendiente` + enlace `wa.me/51XXX` con mensaje formateado (nº pedido, fecha, items, servicio, dirección/quién recoge, pago y total).
- Panel ferretero en tiempo real: SSE `GET /api/orders/stream?store_id=` + polling de respaldo cada 8s + alerta sonora (Web Audio) + tarjeta amarilla pulsante.
- Estados: Pendiente → Aceptado → En Camino / Listo para recojo → Completado (+ Rechazado). Transiciones ilegales devuelven 400.
- Backend endurecido: `.env`, uploads sanitizados (`timestamp-hash.ext`, solo JPG/PNG/WEBP 5MB), validación de precio > 0, celular 9 dígitos, WhatsApp 51+9, errores JSON `{ok:false,error}` con 400/404/429/500, DB con escritura atómica y respaldo si se corrompe.
- PWA básica: `manifest.json`, `sw.js`, `theme-color #2C3E50`, `loading="lazy"` + fallback si una foto 404.

## 2. Variables de entorno
Copiar `backend/.env.example` → `backend/.env`:
```
PORT=3001
BASE_URL=http://localhost:3001
```
En Render/Railway el `PORT` lo inyecta la plataforma (no lo fijes). Solo define `BASE_URL=https://tu-app.onrender.com`.

## 3. Arranque local
```
cd ga-casero-app/backend
npm install
npm start        # http://localhost:3001 (API + web)
npm run smoke    # 13 checks automáticos
```

## 4. Desplegar backend (Render ejemplo)
1. Subir `ga-casero-app/` a GitHub (NO subir `node_modules`; SÍ `package.json`, `server.js`, `frontend/`, `.env.example`).
2. Render → New → Web Service → repo → Build: `npm install --prefix backend` → Start: `npm start --prefix backend`.
3. Environment:
   - `BASE_URL=https://TU-APP.onrender.com`
   - `JWT_SECRET=` genera uno con `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` (obligatorio en producción, sin él no arranca)
   - `CORS_ORIGIN=https://TU-SITIO.netlify.app` (el backend solo acepta ese origen + localhost)
   - `NODE_ENV=production`
4. ⚠️ **Imágenes:** el plan free de Render es efímero: `backend/uploads/` y `db.json` se borran en cada redeploy.
   - Piloto: aceptable (las fotos viven mientras no redespliegues). Activa un **Disk persistente** en `/opt/render/project/src/backend/uploads` y otro para `db.json`, o migra a S3/Cloudinary + Postgres en fase 2.
   - Railway: agrega un **Volume** montado en `/app/backend/uploads`.
5. Abrir `https://TU-APP/...` → registrar ferretería → subir foto → pedir desde el celular → se abre WhatsApp.

## 4b. Frontend en Netlify (corrige el 404 "Page not found")
Netlify es hosting **estático**: no corre Node. Por eso el 404: publicaste la carpeta
`ga-casero-app/` (sin `index.html` en la raíz) en vez de `frontend/`.
1. **Backend primero:** súbelo a Render/Railway (sección 4) y anota su URL, ej. `https://ga-casero.onrender.com`.
2. **Netlify → Add new site → Deploy manually:** arrastra SOLO la carpeta **`frontend/`**
   (la que contiene `index.html`, `app.js`, `_redirects`). Alternativa con Git:
   Build command vacío, **Publish directory = `ga-casero-app/frontend`**.
3. Abre tu sitio como `https://TU-SITIO.netlify.app/?api=https://ga-casero.onrender.com`
   (o toca ⚙️ en la barra superior y pega la URL del backend). Queda guardada en el navegador.
4. Las fotos se sirven desde el backend (`/uploads`), el frontend las prefija solo.

## 5. Probar las 5 capas
1. Vecino: agrega 2 productos → Enviar pedido → verifica tarjeta verde + botón WhatsApp que abre `wa.me/51987...` con el pedido formateado.
2. Ferretería (otra pestaña): cambia a modo Ferretería → debe sonar + tarjeta amarilla pulsante en Pendiente → Aceptado → En Camino → Completado.
3. Sube un `.exe` o foto de 6MB → debe responder 400 con mensaje claro.
4. DevTools → Application → Manifest (G&A Casero, standalone) + Service Workers registrado; Network con throttling 3G: imágenes con lazy.
