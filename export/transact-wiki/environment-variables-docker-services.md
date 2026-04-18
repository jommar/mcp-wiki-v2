# Environment Variables → Docker Services

## api app (`Portage-backend/apps/api/.env`) {#wiki-docker-portage-backend-docker-dependency-mapping-environment-variables-docker-services-api-app-portage-backend-apps-api-env}

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

---

## queue app (`Portage-backend/apps/queue/.env`) {#wiki-docker-portage-backend-docker-dependency-mapping-environment-variables-docker-services-queue-app-portage-backend-apps-queue-env}

| Env Variable | Docker Target | Value (local dev) |
|---|---|---|
| `REDIS_HOST` | `ttt-redis:6379` | `127.0.0.1` |
| `REDIS_PORT` | `ttt-redis:6379` | `6379` |
| `KAFKA_BROKERS` | `ttt-kafka:9092` | `localhost:9092` |
| `BACKEND_PORT` | — | `8001` |
| `MAIL_PROVIDER` | — | `smtp` |

---

## Root-level `.env` (`Portage-backend/.env`) {#wiki-docker-portage-backend-docker-dependency-mapping-environment-variables-docker-services-root-level-env-portage-backend-env}

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

---

## scheduler app (`Portage-backend/apps/scheduler/.env`) {#wiki-docker-portage-backend-docker-dependency-mapping-environment-variables-docker-services-scheduler-app-portage-backend-apps-scheduler-env}

| Env Variable | Docker Target | Value (local dev) |
|---|---|---|
| `DATABASE_URL_ADMIN` | `ttt-database:3306` | `mysql://admin:secret@127.0.0.1/travel_tracker_trips` |
| `DATABASE_URL_CLIENT` | `ttt-database:3306` | `mysql://admin:secret@127.0.0.1/ez_colbert` |
| `BACKEND_PORT` | — | `3000` |

---

