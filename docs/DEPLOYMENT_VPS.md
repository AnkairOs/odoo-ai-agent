# 🚀 Guía de Despliegue en Producción (Contabo VPS + Docker + CI/CD)

Esta guía documenta los pasos para desplegar **`odoo-ai-agent`** en tu VPS de Contabo con subdominio propio (**`agent.ankairos.online`**), SSL automático y despliegue continuo vía GitHub Actions.

---

## 1. Configuración de DNS

En tu proveedor de DNS (Cloudflare, GoDaddy o panel de dominio de `ankairos.online`):

1. Agrega un registro tipo **A**:
   - **Nombre / Host:** `agent`
   - **Contenido / IP:** La IP pública de tu VPS de Contabo (la misma que usas para Odoo).
   - **Proxy:** En Cloudflare puedes dejarlo en DNS Only (gris) inicialmente para generar el certificado SSL con Certbot, o con Proxy (naranja) si usas certificados de Cloudflare.

---

## 2. Configuración Inicial en el VPS (Una sola vez)

Conéctate por SSH a tu VPS de Contabo:

```bash
ssh usuario@tu-vps-ip
```

### A. Clonar el repositorio en `/opt/odoo-ai-agent`

```bash
cd /opt
git clone git@github.com:AnkairOs/odoo-ai-agent.git
cd /opt/odoo-ai-agent
```

### B. Crear el archivo de variables de entorno `.env`

Copia la plantilla y configura tus credenciales seguras de producción:

```bash
cp .env.example .env
nano .env
```

Variables clave a verificar en el `.env`:
```ini
PORT=3000
NODE_ENV=production
RELAY_DB_PATH=/app/data/relay.sqlite

# Odoo Connection (puede apuntar a localhost o a tu dominio Odoo)
ODOO_DEFAULT_URL=https://test.ankairos.online
ODOO_DEFAULT_DB=test
ODOO_DEFAULT_API_KEY=tu_odoo_api_key_de_produccion
ODOO_PRODUCT_COMPANY_ID=1
ODOO_PRODUCT_CREATION_ENABLED=true

# Kapso WhatsApp API
KAPSO_API_KEY=tu_kapso_api_key
KAPSO_PHONE_NUMBER_ID=1276774632195545
KAPSO_WEBHOOK_SECRET=tu_secreto_hex_hmac_sha256

# Fallback del Operador (si Odoo no tuviera teléfono en res.company)
RELAY_OPERATOR_WA_ID=593992849536

# IA (DeepSeek u OpenAI)
AI_ENABLED=true
AI_PROVIDER=deepseek
DEEPSEEK_API_KEY=tu_deepseek_api_key
DEEPSEEK_MODEL=deepseek-chat
```

### C. Primer arranque con Docker Compose

```bash
docker compose up -d --build
docker compose ps
```

Verifica que el servicio esté saludable:
```bash
curl http://localhost:3000/
# Respuesta esperada: Hello World!
```

---

## 3. Configuración de Nginx y Certificado SSL en el VPS

Para exponer el agente de forma segura bajo `https://agent.ankairos.online`:

### A. Crear bloque de servidor en Nginx

Crea el archivo de configuración para el subdominio:

```bash
sudo nano /etc/nginx/sites-available/agent.ankairos.online
```

Agrega la configuración del proxy hacia el puerto 3000:

```nginx
server {
    listen 80;
    server_name agent.ankairos.online;

    client_max_body_size 50M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
        proxy_connect_timeout 60s;
    }
}
```

Habilita el sitio y prueba la sintaxis:
```bash
sudo ln -s /etc/nginx/sites-available/agent.ankairos.online /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### B. Generar Certificado SSL Gratuito con Certbot

```bash
sudo certbot --nginx -d agent.ankairos.online
```

Certbot actualizará automáticamente la configuración para forzar HTTPS con certificado Let's Encrypt.

---

## 4. Configurar el Webhook Permanente en Kapso

Una vez que `https://agent.ankairos.online` responda con SSL:

Actualiza el webhook de Kapso para apuntar a la URL fija de producción:

```bash
npx kapso whatsapp webhooks update fd519aa5-7636-49a2-8ee9-68a718081825 \
  --phone-number-id 1276774632195545 \
  --url https://agent.ankairos.online/webhooks/kapso \
  --active
```

*(Con esto ya no necesitas ngrok nunca más; el agente queda 24/7 en línea en tu servidor).*

---

## 5. Pipeline Automático con GitHub Actions (CI/CD)

El archivo `.github/workflows/deploy.yml` ya está listo. Cada vez que hagas `git push` a `main`:

1. GitHub Actions corre automáticamente:
   - `npm test` (las 646 pruebas unitarias).
   - `npm run build` (compilación TypeScript).
   - `npm run lint` (validación de código).
2. Si todo pasa, se conecta a tu Contabo VPS por SSH usando los secretos del repositorio:
   - `VPS_HOST`
   - `VPS_USERNAME`
   - `VPS_SSH_KEY`
3. Ejecuta `git pull` y `docker compose up -d --build` en `/opt/odoo-ai-agent`.
4. El nuevo código queda desplegado en segundos sin caída del servicio.
