# 🌐 UniFi Network Health Analyzer

A UniFi dashboard for Proxmox and Debian that focuses on what a network admin needs most: client connectivity, traffic activity, RF congestion, historical trends, actionable remediation, and a copy/paste log bundle for escalation.

---

## 🚀 One-line Proxmox installer and updater

### Install
```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/damessner/unifi-health-check/main/setup-lxc.sh)"
```

### Update
```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/damessner/unifi-health-check/main/setup-lxc.sh)" -- --update-only
```

### What changed
- Simpler install/update flow for Proxmox shell copy/paste
- Default host port changed to **`38443`**
- Existing `.env` is preserved on updates
- History retention is larger by default for better trend analysis

---

## ✅ 20 admin-focused additions in this release

1. Proxmox updater one-liner
2. Unique default host port `38443`
3. Configurable request timeout for UniFi API calls
4. Configurable in-memory history depth
5. Rich controller/auth telemetry in `/api/health`
6. Live/cache/mock telemetry source visibility
7. Client connectivity success verdicts
8. Client traffic state visibility (active/light/idle)
9. Per-client error summaries from anomalies and RF issues
10. Issues Detected panel
11. No Issues panel
12. Possible Solutions section
13. Connectivity operations summary on overview
14. Full client connectivity audit table
15. Copy/paste log aggregator panel
16. Log aggregator API endpoint
17. Log aggregator download/copy actions
18. Server-side history clear endpoint
19. Historical highlight cards and incident feed
20. Connectivity + issue trend chart

Also included: DFS handling was corrected so **channel 140 is no longer suggested or displayed**.

---

## 📊 What the dashboard now shows

### Connectivity and traffic visibility
- Whether clients appear to have connected successfully
- Which clients are unstable or error-prone
- Whether clients are actively downloading/uploading or just sitting idle
- Error/anomaly summaries and recommended next actions

### RF and Wi-Fi health
- 2.4 GHz and 5 GHz utilization
- Congested radios and co-channel interference
- DFS usage visibility (without channel 140)
- Access point inventory and optimization blueprint

### Historical insights
- Peak client counts
- Worst 5 GHz load window
- Best connection success window
- Most unstable client window
- Largest idle-client window
- Recent incident timeline

### Copy/paste escalation data
- Generated admin log bundle with:
  - controller status
  - traffic summary
  - issues detected
  - no-issue confirmations
  - connectivity audit
  - historical highlights
  - suggested remediations

---

## 🐳 Manual Docker run

```bash
git clone https://github.com/damessner/unifi-health-check.git
cd unifi-health-check
cp .env.example .env
nano .env
docker compose up -d --build
```

Open the UI on:
```text
http://<host-ip>:38443
```

---

## ⚙️ Environment configuration

| Variable | Default | Description |
|---|---:|---|
| `UNIFI_HOST` | `172.16.0.200` | UniFi controller hostname or IP |
| `UNIFI_PORT` | `8443` | UniFi controller API port |
| `UNIFI_USER` | `observer` | UniFi username |
| `UNIFI_PASS` | `change-me` | UniFi password |
| `UNIFI_SITE` | `default` | UniFi site ID |
| `UNIFI_TIMEOUT_MS` | `10000` | Timeout for each UniFi API request |
| `PORT` | `3000` | Internal Node.js port |
| `CACHE_EXPIRY_SEC` | `15` | Cache lifetime in seconds |
| `HISTORY_MAX_SAMPLES` | `288` | Number of historical snapshots kept in memory |
| `HOST_PORT` | `38443` | Host port exposed by Docker |

---

## 🛠️ Useful commands

From `/opt/unifi-health-check`:

```bash
docker compose logs -f
docker compose restart
docker compose down
bash -c "$(curl -fsSL https://raw.githubusercontent.com/damessner/unifi-health-check/main/setup-lxc.sh)" -- --update-only
```

---

## 📡 API endpoints

- `GET /api/health` — controller/auth/telemetry health
- `GET /api/diagnostics` — full dashboard payload
- `GET /api/history` — historical snapshots and derived history insights
- `DELETE /api/history` — clear stored history snapshots
- `GET /api/log-aggregate` — paste-ready admin log report

---

## 🧪 Demo mode

For local testing without a controller:

```bash
MOCK_MODE=true npm start
```

---

## 🛡️ Notes

- The app will fall back to bundled demo data if the controller cannot be reached.
- The history buffer is in-memory and resets when the server restarts.
- The dashboard is intentionally conservative about auto-refresh to avoid overloading UniFi hardware.
