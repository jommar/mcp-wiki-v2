# Load Testing Monitoring Stack

## Commands {#wiki-docker-load-testing-monitoring-stack-commands}

```bash
# Start monitoring stack
cd Portage-backend/test/load
./start_grafana.sh

# Stop monitoring stack
./stop_grafana.sh

# Run a k6 test with InfluxDB output
export K6_INFLUXDB_ORGANIZATION="my-org"
export K6_INFLUXDB_BUCKET="k6"
export K6_INFLUXDB_TOKEN="my-super-secret-token"
k6 run --out "xk6-influxdb=http://localhost:8086" test/load/k6-ezat-performance.js
```

---

## Configurable Parameters (set via env or defaults) {#wiki-docker-load-testing-monitoring-stack-configurable-parameters-set-via-env-or-defaults}

| Variable | Default | Purpose |
|---|---|---|
| `INFLUXDB_ADMIN_USER` | `admin` | InfluxDB admin username |
| `INFLUXDB_ADMIN_PASSWORD` | `admin123` | InfluxDB admin password |
| `INFLUXDB_ORG` | `my-org` | InfluxDB organization |
| `INFLUXDB_BUCKET` | `k6` | InfluxDB bucket for k6 data |
| `INFLUXDB_TOKEN` | `my-super-secret-token` | InfluxDB API token |

---

## Grafana Access {#wiki-docker-load-testing-monitoring-stack-grafana-access}

- URL: `http://localhost:3000`
- InfluxDB connection: `http://localhost:8086`

---

---

## Network {#wiki-docker-load-testing-monitoring-stack-network}

- **Name:** `monitoring-net` (created by `start_grafana.sh`)

---

## Prerequisites {#wiki-docker-load-testing-monitoring-stack-prerequisites}

- **Go** — required to build the custom k6 binary with xk6 (InfluxDB v2 output plugin)
- The script installs `xk6` via `go install go.k6.io/xk6/cmd/xk6@latest` if missing

---

## Services {#wiki-docker-load-testing-monitoring-stack-services}

| Service | Port | Purpose |
|---|---|---|
| Grafana | `3000` | Metrics dashboard |
| InfluxDB | `8086` | Time-series data store for k6 output |

---

