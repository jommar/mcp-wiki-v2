# Quick Start

## Environment Setup {#wiki-quick-start-environment-setup}

1. Copy `.env.example` to `.env` in each project
2. Configure database URLs, Redis, Kafka, and GDIC auth URL
3. Run `npx prisma generate` in `Portage-backend/`

---

---

## Prerequisites {#wiki-quick-start-prerequisites}

- **Node.js** >= 20.18.0 (check `.nvmrc` per project)
- **MySQL** (two databases: admin + client)
- **Redis**
- **Kafka** (optional for local dev — set `SKIP_MICROSERVICES=`)
- **Docker** (optional, for local MySQL + Redis via TravelTracker's `setup/docker/`)

---

## Root-Level Commands {#wiki-quick-start-root-level-commands}

```bash
npm run ezat          # Start Portage FE + BE in parallel
npm run ezr           # Start Routing FE + BE in parallel
npm run ezat:be       # Portage backend only
npm run ezat:fe       # Portage frontend only
```

---

