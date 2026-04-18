# Project Context (from Past Conversations)

## AI/ML Infrastructure {#user-wiki-project-context-from-past-conversations-ai-ml-infrastructure}

- **Local Models:** Uses llama.cpp-server, exploring Gemma variants, Bonsai-8B
- **API Providers:** OpenRouter (primary), OpenCode Go
- **Tools:** MCP tool creation, wiki system for persistent agent context
- **Interests:** AI-to-AI platforms, agent discovery protocols, enterprise AI stacks

---

## Hardware & Environment {#user-wiki-project-context-from-past-conversations-hardware-environment}

- **GPU:** NVIDIA GeForce RTX 4060
- **OS:** Ubuntu 24.04 (Kernel 6.8.x)
- **Docker:** Used for local databases (MySQL containers)
- **Email Testing:** Mailtrap sandbox for development

---

## Migration Pipeline {#user-wiki-project-context-from-past-conversations-migration-pipeline}

- **Flow:** CSV fix → DB restore → migration → post-migration scripts → DB dump → CSV validation → sanity checks
- **Key Files:** `TravelTracker/ddl/migrate.py`, `TravelTracker/app/admin/legacy-migration-csv-validator.js`, `TravelTracker/app/admin/index.js`
- **Client Structure:** `TravelTracker/ddl/ez_{client}/` directories with per-client migration logs

---

## TransAct Monorepo {#user-wiki-project-context-from-past-conversations-transact-monorepo}

- **Path:** `/transAct`
- **Projects:** Portage-backend (NestJS), Portage-frontend (Nuxt/Vue), Routing (Express/Objection.js), TravelTracker (Express/Objection.js), EZAT-Backend (NestJS)
- **Key Work:** Legacy data migrations (CSV → MySQL via Python `migrate.py`), CSV validator robustness, sanity check scripts
- **Notable Quirks:** `admin` client row required in `travel_tracker_trips.client` for email system; `global.configuration` loaded from `config.json`
- **Wiki Docs:** `/transAct/docs/WIKI.md`, `/transAct/docs/WIKI-MIGRATIONS.md`

---

