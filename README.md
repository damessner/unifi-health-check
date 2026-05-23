# 🌐 UniFi Network Health Analyzer

[![Docker Build](https://img.shields.io/badge/docker-ready-blue.svg?logo=docker&logoColor=white&style=for-the-badge)](https://www.docker.com/)
[![License](https://img.shields.io/badge/License-MIT-green.svg?style=for-the-badge)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Debian%20%7C%20Proxmox%20LXC-orange.svg?logo=proxmox&logoColor=white&style=for-the-badge)](https://www.proxmox.com/)

A modern, high-fidelity real-time network health diagnostics and channel optimization dashboard for UniFi Wireless controllers. Features a constrained joint-band batch optimizer that jointly tunes both 2.4 GHz and 5 GHz channels across APs with proximity awareness, change budgeting, and incremental improvement tracking. Aggregates client telemetry, monitors AP channel utilization, and categorizes client types (Apple vs. others) over a premium dark-themed interface.

---

## 🚀 One-Click Proxmox VE Host Installation

If you are running a Proxmox VE host, you can create a brand new, lightweight, and pre-configured Debian LXC container and install the entire application stack automatically with a single command.

Log in to your **Proxmox VE Host shell** as **root** and run:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/damessner/unifi-health-check/main/proxmox-install.sh)"
```

### 🔍 What the Proxmox Host Script Does:
1. **Dynamic Resource Detection**: Automatically scans your Proxmox server for the next available Container ID (VMID), network bridges (like `vmbr0`), and template/container storage volumes.
2. **Template Provisioning**: Downloads the latest official `debian-12-standard` LXC template if not already cached.
3. **Container Creation**: Provisions a lightweight, unprivileged Debian 12 container (2 Cores, 2GB RAM, 8GB disk size) with `nesting=1` and `keyctl=1` features pre-enabled (essential for nested Docker containers).
4. **Direct Access from Host**: Container shell access is available via `pct enter` from the Proxmox host.
5. **Container Setup Automation**: Powers on the new container, waits for a DHCP IP lease, and executes the in-container `setup-lxc.sh` auto-installer in a non-interactive pipe.

---

## 📦 In-Container Debian LXC & Docker Auto-Installation

If you already have an existing Debian LXC container or a standard Debian server running and want to install the analyzer manually inside it:

Log in to your **Debian Container terminal** as **root** and run:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/damessner/unifi-health-check/main/setup-lxc.sh)"
```

### 🔍 What the In-Container Auto-Installer Does:
1. **Adaptive Prerequisite Setup**: Detects and installs `curl`, `git`, and standard certificates if they are missing.
2. **Smart Docker & Compose Checker**: Checks if Docker is already installed.
   - If **absent**: Automatically downloads and configures the official Docker Engine and enables the system daemon.
   - If **present**: Skips installation and validates that your Docker Compose V2 plugin is active and fully functional.
3. **Proxmox Nesting Validation**: Performs a daemon check and issues alert instructions if Proxmox Nesting is disabled.
4. **Repository Deployment**: Clones or updates the project code inside `/opt/unifi-health-check`.
5. **Interactive Configuration Wizard**: Prompts you for your UniFi Controller details and port preferences. In non-interactive terminals, it gracefully falls back to default values.
6. **Container Orchestration**: Builds and runs the Node.js diagnostics container on a conflict-free, custom external port (**`2943`**).
7. **Success Summary**: Prints local container IP access URLs and helpful commands to manage your setup.

---

## 🐳 Running on a Debian LXC Already Having Docker

If your container already has Docker running, running the one-liner is still the **recommended and easiest method**. The script is built defensively:
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

## 🔄 One-Click Application Updates

To update your existing installation to the latest version of the UniFi Network Health & Channel Analyzer while fully preserving all your `.env` settings and credentials, simply run the following one-liner inside your **Debian Container/Server terminal** as root:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/damessner/unifi-health-check/main/setup-lxc.sh)"
```

The script is built to be completely non-destructive:
- It **safeguards your existing credentials** and never overwrites your current `.env` file.
- It pulls all new updates from the remote repository.
- It automatically handles container rebuilds and restarts the service smoothly on port `2943`.

---

## ⚙️ Environment Configuration

The application is configured using a `.env` file located in the root of the project directory.

| Variable | Default Value | Description |
|---|---|---|
| `UNIFI_HOST` | `unifi-controller.local` | Hostname or IP address of your UniFi Controller. |
| `UNIFI_PORT` | `8443` | The controller API Port (typically `8443` or `443`). |
| `UNIFI_USER` | **Required** | Username for the UniFi account (read-only recommended). |
| `UNIFI_PASS` | **Required** | Password for the UniFi account. |
| `UNIFI_SITE` | `default` | UniFi Site Name/ID (typically `default`). |
| `PORT` | `3445` | Internal Node.js server port (do not modify). |
| `HOST_PORT` | `2943` | External port exposed on the host machine to access the UI. |
| `CACHE_EXPIRY_SEC` | `15` | Caching duration (in seconds) of controller data to limit load. |
| `API_TOKEN` | _(empty)_ | Optional API protection token; when set, send it in `x-api-token` header for all `/api/*` calls. |
| `OPT_MAX_CHANGES` | `8` | Maximum APs the batch optimizer suggests per round. Lower = fewer changes, less risk. |
| `UNIFI_ALLOW_SELF_SIGNED` | `false` | Keep `false` for production; only set `true` if you intentionally trust a self-signed controller certificate. |

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

The internal Node.js server exposes these diagnostic endpoints:
- **`GET /api/health`**: Tests connection status to the UniFi controller and verifies credentials.
- **`GET /api/diagnostics`**: Compiles AP radio congestion, active clients, and Apple device metrics. Use `?force=true` to bypass cache.
- **`GET /api/history`**: Returns the ring-buffered timeline trends (up to 60 snapshot samples).
- **`GET /api/optimize`**: Runs the constrained batch optimizer. Query params: `?maxChanges=8` (default 8), `?force=true` (bypass cache). Returns an AP-level joint-band channel plan, changed AP list, and before/after improvement estimates.
- **`GET /api/export/xlsx`**: Generates a multi-sheet XLSX report (Channel Optimization, Client Issues, Summary, Improvement Report) using the constrained batch optimizer.

If `API_TOKEN` is configured, include `x-api-token: <token>` for all `/api/*` requests.

---

## 🌍 Public Release Notes

- No real controller credentials are shipped in defaults.
- Sandbox topology is generated dynamically from live AP telemetry (no hardcoded room/device map).
- Sandbox model caps visualization/simulation to the first 60 AP endpoints per fetch.
- For public exposure, run behind TLS and reverse-proxy auth in addition to `API_TOKEN`.

---

## 🛡️ License

This project is open-source and licensed under the [MIT License](LICENSE).

---

## 🧭 Feature Integrity Snapshot & Strategic Roadmap

Current implementation integrity (verified in this repository):

- ✅ Implemented today: real-time diagnostics API, RF/channel analyzer, iPad/Apple client diagnostics, in-memory history ring buffer, speed/capacity widgets, **constrained joint-band batch optimizer** (AP-level, proximity-aware, change-limited), **iterative recheck workflow** (round counter, Re-scan & Re-optimize, batch history in localStorage, cumulative progress bar), XLSX export with improvement report, batch optimizer UX (grid highlighting, channel diff badges, select-all batch, before/after comparison), butterfly-effect sandbox simulator.
- ❌ Not implemented yet: webhook/email alerting, sticky-client roaming diagnostics, classroom SLA grouping, safe write-back controller actions, airtime fairness auditor, DHCP pool exhaustion predictor, SQLite persistent time-series, rogue AP radar, teacher portal/reporting endpoint.

Planned advanced extensions are documented in **`/STRATEGIC_ROADMAP.md`**.

### Constrained Batch Optimizer

The **Constrained Joint-Band Batch Optimizer** (`services/optimizer.js`) replaces the old per-radio greedy algorithm with an AP-level solver that jointly optimizes both 2.4 GHz and 5 GHz channels per AP. Key design decisions:

| Feature | Description |
|---|---|
| **AP-level joint-band** | Treats both radios of an AP as a unit. Evaluates all 57 channel combinations (3 × 19) per AP. |
| **Change budget** | Limits suggestions to N APs per round (configurable, default 8). Prevents the "butterfly effect" of cascading changes across all APs. |
| **Proximity-aware** | Builds a dynamic RF neighbor graph from live telemetry. Penalizes co-channel overlap between adjacent APs. |
| **Floor separation** | Staggers channel assignments across EG/1OG/2OG floors for 3D interference reduction. |
| **Stability bias** | Skips healthy APs (low CU, zero CCI, single-occupant channels) to avoid unnecessary disruption. |
| **Improvement report** | Computes before/after metrics (avg CU, max CU, CCI count, channel variance) with estimated improvement percentage. |
| **Incremental workflow** | Designed for "fix worst N → re-scan → re-optimize" cycles. Each round picks the next worst offenders. |

Access the optimizer via the **Optimizer** tab in the dashboard or `GET /api/optimize?maxChanges=8`.
