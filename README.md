# 🌐 UniFi Network Health Analyzer

[![Docker Build](https://img.shields.io/badge/docker-ready-blue.svg?logo=docker&logoColor=white&style=for-the-badge)](https://www.docker.com/)
[![License](https://img.shields.io/badge/License-MIT-green.svg?style=for-the-badge)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Debian%20%7C%20Proxmox%20LXC-orange.svg?logo=proxmox&logoColor=white&style=for-the-badge)](https://www.proxmox.com/)

A modern, high-fidelity real-time network health diagnostics and channel analysis dashboard for UniFi Wireless controllers. It aggregates client telemetry, monitors access point (AP) channel utilization, categorizes client types (Apple vs. others), and streams metric history over a gorgeous premium dark-themed interface.

---

## 🚀 One-Click Debian LXC & Docker Auto-Installation

For Proxmox Debian LXC containers or standard Debian hosts, use this complete, zero-dependency auto-installer. 

Avoid `curl | bash` direct execution. Download, inspect, and then run:

```bash
curl -fsSLo /tmp/setup-lxc.sh https://raw.githubusercontent.com/damessner/unifi-health-check/main/setup-lxc.sh
chmod 755 /tmp/setup-lxc.sh
less /tmp/setup-lxc.sh
bash /tmp/setup-lxc.sh
```

For stronger integrity guarantees, pin to a commit URL and verify SHA-256 before execution.

### 🔍 What the Auto-Installer Does:
1. **Adaptive Prerequisite Setup**: Detects and installs `curl`, `git`, and standard certificates if they are missing.
2. **Smart Docker & Compose Checker**: Checks if Docker is already installed.
   - If **absent**: Automatically downloads and configures the official Docker Engine and enables the system daemon.
   - If **present**: Skips installation and validates that your Docker Compose V2 plugin is active and fully functional.
3. **Proxmox Nesting Validation**: Performs a daemon check and issues alert instructions if Proxmox Nesting is disabled.
4. **Repository Deployment**: Clones or updates the project code inside `/opt/unifi-health-check`.
5. **Interactive Configuration Wizard**: Prompts you for your UniFi Controller details and API key. In non-interactive mode, required values must be provided via environment variables.
6. **Container Orchestration**: Builds and runs the Node.js diagnostics container on a conflict-free, custom external port (**`3843`**).
7. **Success Summary**: Prints local container IP access URLs and helpful commands to manage your setup.

---

## 🐳 Running on a Debian LXC Already Having Docker

If your container already has Docker running, running the installer script is still the recommended method. The script is built defensively:
- It **does not overwrite** or reinstall Docker if it is already installed.
- It **retains any existing `.env` configuration file** instead of prompting you again.
- It simply ensures the latest repository changes are checked out and executes a clean rebuild.

### Alternative Manual Run
If you prefer to configure and run the container manually:

```bash
# 1. Clone the repository
git clone https://github.com/damessner/unifi-health-check.git
cd unifi-health-check

# 2. Configure Environment Variables
cp .env.example .env
nano .env  # Edit your UniFi Controller details

# 3. Spin up the container
docker compose up -d --build
```

---

## ⚙️ Environment Configuration

The application is configured using a `.env` file located in the root of the project directory.

| Variable | Example Value | Description |
|---|---|---|
| `UNIFI_URL` | `https://controller.example.internal:8443` | Full HTTPS URL for your UniFi Controller API endpoint. |
| `UNIFI_USER` | `__REQUIRED__` | UniFi API username (provide securely; do not commit real values). |
| `UNIFI_PASS` | `__REQUIRED__` | UniFi API password (provide securely; do not commit real values). |
| `UNIFI_SITE` | `default` | UniFi Site Name/ID (typically `default`). |
| `API_KEY` | `__REQUIRED__` | Required API key for all `/api/*` endpoints (pass in `X-API-Key` header). |
| `API_AUTH_ENABLED` | `true` | Keep API protection enabled in production. |
| `TRUST_PROXY` | `false` | Set to `true` only behind a trusted reverse proxy. |
| `RATE_LIMIT_WINDOW_SEC` | `60` | API rate limit rolling window length in seconds. |
| `RATE_LIMIT_MAX_REQUESTS` | `60` | Maximum API calls allowed per client per window. |
| `FORCE_REFRESH_MIN_INTERVAL_SEC` | `30` | Minimum interval between `?force=true` requests to prevent abuse. |
| `UNIFI_ALLOW_SELF_SIGNED_CERT` | `false` | Keep `false` unless you explicitly trust a self-signed controller cert. |
| `PORT` | `3000` | Internal Node.js server port (do not modify). |
| `HOST_PORT` | `3843` | External port exposed on the host machine to access the UI. |
| `CACHE_EXPIRY_SEC` | `15` | Caching duration (in seconds) of controller data to limit load. |

---

## 🛠️ Management & Control Commands

Navigate to `/opt/unifi-health-check` (or your manual installation folder) to execute these management commands:

* **View Live Container Logs**:
  ```bash
  docker compose logs -f
  ```
* **Restart the Service**:
  ```bash
  docker compose restart
  ```
* **Stop and Remove Container**:
  ```bash
  docker compose down
  ```
* **Update to the Latest Release**:
  ```bash
  git pull && docker compose up -d --build
  ```

---

## 📡 API Endpoints

The internal Node.js server exposes these diagnostic endpoints (all require `X-API-Key`):
- **`GET /api/health`**: Tests connection status to the UniFi controller and verifies credentials.
- **`GET /api/diagnostics`**: Compiles AP radio congestion, active clients, and Apple device metrics. `?force=true` is rate-limited and throttled.
- **`GET /api/history`**: Returns the ring-buffered timeline trends (up to 60 snapshot samples).

---

## 🛡️ License

This project is open-source and licensed under the [MIT License](LICENSE).
