# Docker Setup

Docker is used exclusively for **local development infrastructure** (databases, Redis, Kafka, monitoring). No application services are containerized.

---

## Architecture Summary

```mermaid
graph TB
    subgraph Docker["Docker Containers"]
        DB[("ttt-database MySQL :3306")]
        RD[("ttt-redis Redis :6379")]
        ZK[("ttt-zookeeper :2181")]
        KF[("ttt-kafka :9092")]
        ZK --> KF
    end

    subgraph Host["Host Processes (Native)"]
        API["Portage API :8000"]
        Q["Portage Queue :8001"]
        SCH["Portage Scheduler :3000"]
        TT["TravelTracker :8081"]
        GRA["Grafana :3000"]
        INF[("InfluxDB :8086")]
    end

    DB --> API
    DB --> Q
    DB --> SCH
    DB --> TT
    RD --> API
    RD --> Q
    RD --> TT
    KF --> API
    KF --> Q

    GRA --> INF
```

All application processes run **natively on the host** and connect to Docker containers via `127.0.0.1` (published ports).

---

## TravelTracker Infrastructure Stack

**Compose file:** `TravelTracker/setup/docker/docker-compose.yml`
**Init script:** `TravelTracker/setup/docker/init.local.sql`

### Services

```mermaid
graph LR
    subgraph Network["ttt network"]
        DB[("ttt-database mysql:latest :3306")]
        RD[("ttt-redis redis:6.0 :6379")]
        ZK[("ttt-zookeeper bitnamilegacy/zookeeper :2181")]
        KF[("ttt-kafka bitnamilegacy/kafka :9092")]
    end

    ZK --> KF

    DB -. "volume ttt-database-data" .-> DB
    RD -. "volume ttt-redis-data" .-> RD
```

| Service Key | Container Name | Image | Host Port → Container Port | Purpose |
|---|---|---|---|---|
| `ttt-database` | `ttt-database` | `mysql:latest` | `3306 → 3306` | Primary MySQL database |
| `ttt-redis` | `ttt-redis` | `redis:6.0` | `6379 → 6379` | Cache / session store |
| `zookeeper` | `ttt-zookeeper` | `bitnamilegacy/zookeeper:3.9.3-debian-12-r22` | `2181 → 2181` | Kafka coordination |
| `ttt-kafka` | `ttt-kafka` | `bitnamilegacy/kafka:3.6.2` | `9092 → 9092` | Event message broker |

### Network

- **Name:** `ttt`
- **Type:** Custom bridge network
- All services are attached to this network

### Volumes

| Volume Name | Mounted To | Service |
|---|---|---|
| `ttt-database-data` | `/var/lib/mysql` | `ttt-database` |
| `ttt-redis-data` | `/data` | `ttt-redis` |

### Init Script (`init.local.sql`)

Executed once on first container start. Contents:

```sql
CREATE DATABASE IF NOT EXISTS travel_tracker_trips;

GRANT CREATE, CREATE VIEW, ALTER, INDEX, LOCK TABLES, REFERENCES, UPDATE, DELETE, DROP, SELECT, INSERT ON *.* TO 'admin'@'%';
ALTER USER 'admin'@'%' IDENTIFIED WITH mysql_native_password BY 'secret';

FLUSH PRIVILEGES;
```

**Databases created:** `travel_tracker_trips`

**Important:** The Portage backend also needs the `ez_colbert` database (client DB). This is **not** created by the init script and must be created manually if missing.

### Credentials

| Role | Username | Password | Auth Plugin |
|---|---|---|---|
| Root | `root` | `secret` | default |
| Application | `admin` | `secret` | `mysql_native_password` |

### Kafka Configuration

| Env Variable | Value |
|---|---|
| `KAFKA_BROKER_ID` | `1` |
| `KAFKA_CFG_ZOOKEEPER_CONNECT` | `ttt-zookeeper:2181` |
| `KAFKA_CFG_LISTENERS` | `PLAINTEXT://:9092` |
| `KAFKA_CFG_ADVERTISED_LISTENERS` | `PLAINTEXT://127.0.0.1:9092` |
| `KAFKA_CFG_LISTENER_SECURITY_PROTOCOL_MAP` | `PLAINTEXT:PLAINTEXT` |
| `ALLOW_PLAINTEXT_LISTENER` | `true` |
| `KAFKA_ENABLE_KRAFT` | `false` |
| `KAFKA_CFG_MESSAGE_MAX_BYTES` | `10485880` |

### Extra Hosts

Both `ttt-database` and `ttt-redis` have:
```
host.docker.internal:host-gateway
```
This allows containers to reach services running on the Docker host.

### Commands

```bash
# Start all infrastructure services
cd TravelTracker/setup/docker
docker-compose up -d

# Or use the npm script from TravelTracker root
cd TravelTracker
npm run build:docker

# Stop (preserves data volumes)
docker-compose down

# Stop and destroy all data
docker-compose down -v

# View logs for a specific service
docker-compose logs -f ttt-database
docker-compose logs -f ttt-kafka

# Restart a single service
docker-compose restart ttt-kafka
```

---

## Portage Backend — Docker Dependency Mapping

Portage Backend has **no Dockerfile or docker-compose**. It connects to TravelTracker's Docker containers via localhost ports.

### Portage Apps and Their Docker Dependencies

```mermaid
graph LR
    subgraph Portage["Portage Backend Apps"]
        API["api :8000"]
        Q["queue :8001"]
        SCH["scheduler :3000"]
    end

    subgraph Docker["Docker Containers"]
        DB[("ttt-database MySQL :3306")]
        RD[("ttt-redis Redis :6379")]
        KF[("ttt-kafka :9092")]
    end

    API --> DB
    API --> RD
    API --> KF
    Q --> RD
    Q --> KF
    SCH --> DB
```

| Portage App | Path | Docker Dependencies |
|---|---|---|
| **api** | `Portage-backend/apps/api/` | MySQL, Redis, Kafka |
| **queue** | `Portage-backend/apps/queue/` | Redis, Kafka |
| **scheduler** | `Portage-backend/apps/scheduler/` | MySQL |

### Environment Variables → Docker Services

> Values shown are from the actual `.env` files (secrets redacted). These are the values that map to Docker containers.

#### Root-level `.env` (`Portage-backend/.env`)

| Env Variable | Docker Target | Value (local dev) |
|---|---|---|
| `DATABASE_URL_ADMIN` | `ttt-database:3306` | `mysql://admin:secret@127.0.0.1/travel_tracker_trips` |
| `DATABASE_URL_CLIENT` | `ttt-database:3306` | `mysql://admin:secret@127.0.0.1/ez_colbert` |
| `DATABASE_PREFIX` | — | `ez_` |
| `REDIS_HOST` | `ttt-redis:6379` | `127.0.0.1` |
| `REDIS_PORT` | `ttt-redis:6379` | `6379` |
| `BACKEND_PORT` | — | `8000` |
| `FRONTEND_URL` | — | `http://ezat-local.transact.com` |
| `MAIL_DRIVER` | — | `smtp` |
| `MAIL_HOST` | *(external)* | `smtp.mailtrap.io` |
| `MAIL_PORT` | — | `2525` |

#### api app (`Portage-backend/apps/api/.env`)

| Env Variable | Docker Target | Value (local dev) |
|---|---|---|
| `DATABASE_URL_ADMIN` | `ttt-database:3306` | `mysql://admin:secret@127.0.0.1/travel_tracker_trips` |
| `DATABASE_URL_CLIENT` | `ttt-database:3306` | `mysql://admin:secret@127.0.0.1/ez_colbert` |
| `DATABASE_PREFIX` | — | `ez_` |
| `REDIS_HOST` | `ttt-redis:6379` | `127.0.0.1` |
| `REDIS_PORT` | `ttt-redis:6379` | `6379` |
| `KAFKA_BROKERS` | `ttt-kafka:9092` | `localhost:9092` |
| `BACKEND_PORT` | — | `8000` |
| `DOMAIN` | — | `traveltrackertrips.transact.com` |
| `COOKIE_DOMAIN` | — | `transact.com` |
| `COOKIE_PREFIX` | — | `ttlocal_` |
| `FRONTEND_URL` | — | `http://traveltrackertrips.transact.com:3000` |
| `LEGACY_URL` | — | `http://traveltrackertrips.transact.com:8081` |
| `MAIL_PROVIDER` | — | `smtp` |

#### queue app (`Portage-backend/apps/queue/.env`)

| Env Variable | Docker Target | Value (local dev) |
|---|---|---|
| `REDIS_HOST` | `ttt-redis:6379` | `127.0.0.1` |
| `REDIS_PORT` | `ttt-redis:6379` | `6379` |
| `KAFKA_BROKERS` | `ttt-kafka:9092` | `localhost:9092` |
| `BACKEND_PORT` | — | `8001` |
| `MAIL_PROVIDER` | — | `smtp` |

#### scheduler app (`Portage-backend/apps/scheduler/.env`)

| Env Variable | Docker Target | Value (local dev) |
|---|---|---|
| `DATABASE_URL_ADMIN` | `ttt-database:3306` | `mysql://admin:secret@127.0.0.1/travel_tracker_trips` |
| `DATABASE_URL_CLIENT` | `ttt-database:3306` | `mysql://admin:secret@127.0.0.1/ez_colbert` |
| `BACKEND_PORT` | — | `3000` |

### Skipping Kafka

If Kafka is not needed for a development session:

```env
SKIP_MICROSERVICES=true
```

This disables Kafka-dependent modules in the Portage backend.

---

## TravelTracker — Docker Dependency Mapping

TravelTracker connects to the same Docker containers via `config.json` (not `.env`).

### `config.json` → Docker Services

| Config Path | Docker Target | Value (local dev) |
|---|---|---|
| `db.server` | `ttt-database:3306` | `127.0.0.1` |
| `db.user` | — | `admin` |
| `db.database` | — | `travel_tracker_trips` |
| `db.prefix` | — | `ez_` |
| `redis.host` | `ttt-redis:6379` | `127.0.0.1` |
| `redis.port` | `ttt-redis:6379` | `6379` |
| `server.port` | — | `8081` |
| `newBackend.url` | — | `http://traveltrackertrips.transact.com:8000` |
| `newFrontend.url` | — | `http://ezat-local.transact.com:3000` |

### Cross-App Communication

```mermaid
graph LR
    TT["TravelTracker :8081 config.json"]
    API["Portage API :8000 .env"]
    FE["Portage Frontend :3001 Nuxt"]

    TT -->|"newBackend.url"| API
    TT -->|"newFrontend.url"| FE
    API -->|"LEGACY_URL"| TT
```

| Direction | Source Config | Target |
|---|---|---|
| TravelTracker → Portage API | `config.json` → `newBackend.url` | `http://traveltrackertrips.transact.com:8000` |
| TravelTracker → Portage FE | `config.json` → `newFrontend.url` | `http://ezat-local.transact.com:3000` |
| Portage API → TravelTracker | `.env` → `LEGACY_URL` | `http://traveltrackertrips.transact.com:8081` |

---

## Load Testing Monitoring Stack

**Scripts:** `Portage-backend/test/load/start_grafana.sh`, `Portage-backend/test/load/stop_grafana.sh`

Uses Docker to run Grafana + InfluxDB for k6 load test visualization.

```mermaid
graph LR
    K6["k6 Test Runner host process"]
    INF[("InfluxDB :8086")]
    GRA["Grafana :3000"]

    K6 -->|"xk6-influxdb output"| INF
    GRA -->|"queries"| INF
```

### Services

| Service | Port | Purpose |
|---|---|---|
| Grafana | `3000` | Metrics dashboard |
| InfluxDB | `8086` | Time-series data store for k6 output |

### Network

- **Name:** `monitoring-net` (created by `start_grafana.sh`)

### Configurable Parameters (set via env or defaults)

| Variable | Default | Purpose |
|---|---|---|
| `INFLUXDB_ADMIN_USER` | `admin` | InfluxDB admin username |
| `INFLUXDB_ADMIN_PASSWORD` | `admin123` | InfluxDB admin password |
| `INFLUXDB_ORG` | `my-org` | InfluxDB organization |
| `INFLUXDB_BUCKET` | `k6` | InfluxDB bucket for k6 data |
| `INFLUXDB_TOKEN` | `my-super-secret-token` | InfluxDB API token |

### Prerequisites

- **Go** — required to build the custom k6 binary with xk6 (InfluxDB v2 output plugin)
- The script installs `xk6` via `go install go.k6.io/xk6/cmd/xk6@latest` if missing

### Commands

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

### Grafana Access

- URL: `http://localhost:3000`
- InfluxDB connection: `http://localhost:8086`

---

## Port Map (All Docker Services)

| Host Port | Container Port | Service | Container Name | Used By |
|---|---|---|---|---|
| `3306` | `3306` | MySQL | `ttt-database` | Portage (all apps), TravelTracker |
| `6379` | `6379` | Redis | `ttt-redis` | Portage (api, queue), TravelTracker |
| `2181` | `2181` | Zookeeper | `ttt-zookeeper` | Kafka only |
| `9092` | `9092` | Kafka | `ttt-kafka` | Portage (api, queue) |
| `3000` | `3000` | Grafana | *(dynamic)* | Portage load testing |
| `8086` | `8086` | InfluxDB | *(dynamic)* | Portage load testing |

### Application Ports (Non-Docker, Host-Only)

| Port | Service | Notes |
|---|---|---|
| `8000` | Portage API | `BACKEND_PORT` in root + api `.env` |
| `8001` | Portage Queue | `BACKEND_PORT` in queue `.env` |
| `3000` | Portage Scheduler | `BACKEND_PORT` in scheduler `.env` — **conflicts with Grafana** |
| `3001` | Portage Frontend | Nuxt dev server default |
| `8081` | TravelTracker Server | `server.port` in `config.json` |

> **Port conflict note:** Portage scheduler uses port `3000` by default, which conflicts with Grafana. If running load tests, change `BACKEND_PORT` in `Portage-backend/apps/scheduler/.env` to something else (e.g., `3002`).

---

## Troubleshooting

### Port Already in Use

```bash
# Check what is using a port
lsof -i :3306
lsof -i :6379
lsof -i :9092

# Kill the process or stop the conflicting container
docker stop ttt-database
```

### MySQL Connection Refused

```bash
# Verify container is running
docker ps --filter "name=ttt-database"

# Check MySQL is accepting connections
docker exec ttt-database mysqladmin ping -u admin -psecret

# Check init script ran (first start only)
docker exec ttt-database mysql -u admin -psecret -e "SHOW DATABASES;"
```

### Kafka Not Reachable

```bash
# Verify Kafka and Zookeeper are both running
docker ps --filter "name=ttt-kafka" --filter "name=ttt-zookeeper"

# Check Kafka logs for startup errors
docker logs ttt-kafka 2>&1 | tail -50

# Verify advertised listener is correct
docker exec ttt-kafka kafka-broker-api-versions.sh --bootstrap-server localhost:9092
```

### Redis Connection Issues

```bash
# Test Redis connectivity
docker exec ttt-redis redis-cli ping

# Check Redis logs
docker logs ttt-redis
```

### Database Not Found (`ez_colbert`)

The init script only creates `travel_tracker_trips`. The client database `ez_colbert` must be created manually:

```bash
docker exec -it ttt-database mysql -u admin -psecret -e "CREATE DATABASE IF NOT EXISTS ez_colbert;"
```

### Stale Volumes Causing Issues

```bash
# Full reset: stop, destroy volumes, restart
cd TravelTracker/setup/docker
docker-compose down -v
docker-compose up -d
# Re-create ez_colbert if needed
docker exec ttt-database mysql -u admin -psecret -e "CREATE DATABASE IF NOT EXISTS ez_colbert;"
```

### Grafana/InfluxDB Won't Start

```bash
# Check if ports 3000 or 8086 are in use
lsof -i :3000
lsof -i :8086

# Clean up and restart
cd Portage-backend/test/load
./stop_grafana.sh
docker network rm monitoring-net 2>/dev/null || true
./start_grafana.sh
```

### Scheduler Port 3000 Conflicts with Grafana

If Grafana is running and the scheduler fails to start (or vice versa):

```bash
# Option 1: Change scheduler port
# Edit Portage-backend/apps/scheduler/.env
BACKEND_PORT=3002

# Option 2: Stop Grafana first
cd Portage-backend/test/load && ./stop_grafana.sh
```

---

## Quick Reference: Full Local Dev Startup

```mermaid
graph TD
    S1["Start Docker infrastructure"]
    S2["Create client DB ez_colbert"]
    S3["Set up .env files"]
    S4["Generate Prisma client"]
    S5["Start apps via npm run ezat"]

    S1 --> S2 --> S3 --> S4 --> S5
```

```bash
# 1. Start Docker infrastructure
cd TravelTracker/setup/docker && docker-compose up -d

# 2. Create client database if it doesn't exist
docker exec ttt-database mysql -u admin -psecret -e "CREATE DATABASE IF NOT EXISTS ez_colbert;"

# 3. Set up Portage backend env files (copy from example if missing)
cp -n Portage-backend/.env.example Portage-backend/.env
cp -n Portage-backend/apps/api/.env.example Portage-backend/apps/api/.env
cp -n Portage-backend/apps/queue/.env.example Portage-backend/apps/queue/.env
cp -n Portage-backend/apps/scheduler/.env.example Portage-backend/apps/scheduler/.env

# 4. Generate Prisma client
cd Portage-backend && npx prisma generate

# 5. Start Portage backend + frontend
cd /transAct && npm run ezat
```

### Alternative: Start Everything (All 3 Apps)

```bash
# From repo root — installs all deps and starts Portage BE, Portage FE, and TravelTracker
npm start
```

```mermaid
graph LR
    A["npm start"] --> B["preinstall-all"]
    B --> C["start:legacy-be"]
    C --> D["start:be"]
    D --> E["start:fe"]
```

This runs (sequentially):
1. `preinstall-all` — installs deps for all 3 projects (Portage BE, Portage FE, TravelTracker BE, TravelTracker UI)
2. `start:legacy-be` — TravelTracker (Express + Vue)
3. `start:be` — Portage backend (NestJS)
4. `start:fe` — Portage frontend (Nuxt)
