# CMTrading Call Notifier

SquareTalk → Agent Live Call Notifier. Node.js SSE server + Chrome Extension (MV3).

---

## How it works

1. SquareTalk POSTs `{ client_id }` to `/squaretalk-webhook`
2. Server calls CRM API to get the assigned `salesRep` ID
3. Server looks up that ID in the agent map to find their email
4. Server pushes an SSE event to that agent's Chrome Extension
5. Extension fires a desktop notification — agent clicks → CRM opens instantly

---

## Server Setup (first time)

### 1. Clone & configure

```bash
cd /root
git clone https://github.com/cmtradingapp/alertextension.git
cd alertextension
mkdir -p data
cp server/.env.example server/.env
nano server/.env   # fill in values
```

### 2. `.env` values

| Key | Value |
|-----|-------|
| `JWT_SECRET` | Any long random string |
| `SQUARETALK_WEBHOOK_SECRET` | Shared secret — set same in SquareTalk |
| `POSTGRES_USER` | Backoffice DB user |
| `POSTGRES_PASSWORD` | Backoffice DB password |

### 3. Start container

```bash
docker compose up -d --build
docker compose logs -f app
```

### 4. Add agent mappings

After getting the CRM salesRep ID for each agent, POST to the admin API:

```bash
# Get your admin token first
TOKEN=$(curl -s -X POST https://sq.cmtrading.com/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"YOUR_PASSWORD"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")

# Add an agent mapping
curl -X POST https://sq.cmtrading.com/admin/agent-map \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"crm_id": "3452", "email": "agent@cmtrading.com"}'
```

The map is stored in `data/agent-map.json` and survives container restarts.

---

## Cloudflare Tunnel setup (this server uses Cloudflare Tunnel)

```bash
# Add route for sq.cmtrading.com → localhost:3099
cloudflared tunnel route dns <TUNNEL_NAME> sq.cmtrading.com

# Edit /etc/cloudflared/config.yml and add:
#   - hostname: sq.cmtrading.com
#     service: http://localhost:3099
#
# Then restart cloudflared
systemctl restart cloudflared
```

## Nginx setup (alternative — if nginx is used)

```bash
cp nginx/sq.cmtrading.com.conf /etc/nginx/sites-available/sq.cmtrading.com
ln -s /etc/nginx/sites-available/sq.cmtrading.com /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

> **DNS:** Add an A record: `sq.cmtrading.com → <server IP>` (same IP as backoffice.cmtrading.com)

---

## GitHub Actions CI/CD

Add these secrets in the GitHub repo → Settings → Secrets:

| Secret | Value |
|--------|-------|
| `SERVER_HOST` | Server IP address |
| `SERVER_USER` | `root` |
| `SERVER_SSH_KEY` | Private SSH key (see setup below) |

### Generate deploy key (run on server once)

```bash
ssh-keygen -t ed25519 -C "github-actions-alertextension" -f ~/.ssh/alertextension_deploy -N ""
cat ~/.ssh/alertextension_deploy.pub >> ~/.ssh/authorized_keys
cat ~/.ssh/alertextension_deploy   # copy this → SERVER_SSH_KEY secret
curl -s ifconfig.me                # copy this → SERVER_HOST secret
```

Every push to `master` automatically deploys.

---

## Chrome Extension — Agent Install

1. Download `cmtrading-call-notifier-extension.zip`
2. Go to `chrome://extensions/`
3. Enable **Developer mode** (top right toggle)
4. Click **Load unpacked** → select the unzipped `extension/` folder
   *(or drag and drop the zip)*
5. Click the extension icon → sign in with your CMTrading backoffice email & password
6. You'll see a green **Live** badge when connected

---

## URLs

| | |
|-|---|
| **Webhook URL for SquareTalk** | `https://sq.cmtrading.com/squaretalk-webhook` |
| **SSE stream** | `https://sq.cmtrading.com/events?token=<jwt>` |
| **Health check** | `https://sq.cmtrading.com/health` |

---

## Build extension zip for distribution

```bash
cd extension
zip -r ../cmtrading-call-notifier-extension.zip .
```
