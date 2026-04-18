# Port Map (All Docker Services)

## Application Ports (Non-Docker, Host-Only) {#wiki-docker-port-map-all-docker-services-application-ports-non-docker-host-only}

| Port | Service | Notes |
|---|---|---|
| `8000` | Portage API | `BACKEND_PORT` in root + api `.env` |
| `8001` | Portage Queue | `BACKEND_PORT` in queue `.env` |
| `3000` | Portage Scheduler | `BACKEND_PORT` in scheduler `.env` — **conflicts with Grafana** |
| `3001` | Portage Frontend | Nuxt dev server default |
| `8081` | TravelTracker Server | `server.port` in `config.json` |

> **Port conflict note:** Portage scheduler uses port `3000` by default, which conflicts with Grafana. If running load tests, change `BACKEND_PORT` in `Portage-backend/apps/scheduler/.env` to something else (e.g., `3002`).

---

---

