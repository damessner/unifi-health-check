# 💡 Strategic Roadmap: 10 Advanced Features for UniFi Network Health Analyzer

This roadmap captures the next major capabilities to evolve the dashboard from diagnostics into a proactive remediation suite for school environments.

---

## 🏗️ Architectural Overview of Extensions

```mermaid
graph TD
    subgraph Frontend [Modern HTML/CSS Dashboard]
        F_Admin[Main IT Admin View]
        F_Teacher[New: Simplified Teacher View /teacher]
        F_Tuning[New: Graph-Coloring Simulator & Interactive Optimizer]
    end

    subgraph Express_Backend [Express Node.js Server]
        S_API[Express API Router]
        S_Cache[In-Memory Cache & Poller]
        S_Alerts[New: Alert & Report Engine]
        S_Optimization[New: Welsh-Powell Graph-Coloring Engine]
        S_DB[New: Persistent SQLite Time-Series DB]
        S_WriteBack[New: Safe Provisioning API Engine]
    end

    subgraph External_Infrastructure [Network Infrastructure]
        U_Controller[UniFi Controller API]
        U_DB[SQLite Local File]
        U_Sys[Admin Webhooks / Email SMTP]
    end

    F_Admin -->|API queries & actions| S_API
    F_Teacher -->|Status queries/report issue| S_API
    F_Tuning -->|Optimization simulation| S_API

    S_API --> S_Cache
    S_API --> S_Optimization
    S_API --> S_WriteBack
    S_API --> S_Alerts
    S_API --> S_DB

    S_Cache -->|Read telemetry| U_Controller
    S_WriteBack -->|Provision channel/power| U_Controller
    S_DB -->|Read/write| U_DB
    S_Alerts -->|Email/Webhook| U_Sys
```

---

## 📋 10 Feature Blueprints

1. **Proactive Webhook Alerts & Scheduled PDF Digests**  
   Trigger threshold-based alerts and periodic PDF reports via SMTP/webhooks.

2. **AP Sticky-Client Roaming Diagnostics**  
   Detect clients with weak RSSI on distant APs and recommend roaming/radio policy fixes.

3. **Virtual Classroom Grouping & Wi-Fi SLAs**  
   Group APs by classroom and calculate a simple readiness SLA (green/yellow/red).

4. **Graph-Coloring Channel Optimization Engine**  
   Add Welsh-Powell channel allocation to compute conflict-minimized plans.

5. **Safe Write-Back Controller Integration**  
   Add guarded write-back actions (kick client / update AP radio) behind `WRITEBACK_PASSCODE`.

6. **Airtime Fairness & Multi-SSID Traffic Auditor**  
   Surface SSID airtime hogs and identify low-throughput/high-airtime clients.

7. **DHCP Pool & IP Lease Exhaustion Predictor**  
   Track subnet lease utilization and warn before address exhaustion.

8. **SQLite Time-Series with Historic Time-Travel**  
   Persist snapshots to SQLite and enable date-range trend analysis beyond process restarts.

9. **Rogue AP & Mobile Hotspot Spectrum Radar**  
   Parse UniFi rogue AP telemetry and estimate likely physical proximity.

10. **Teacher Portal & Live Feedback Logger**  
   Add `/teacher` read-only status and `/api/teacher/report` incident logging.

---

## 🚀 Recommended Implementation Sequence

1. **Phase 1 (Persistence):** SQLite storage + historical chart enhancements  
2. **Phase 2 (Operations):** alerts/reporting + simplified teacher portal  
3. **Phase 3 (Advanced Optimization):** graph-coloring engine + safe write-back actions
