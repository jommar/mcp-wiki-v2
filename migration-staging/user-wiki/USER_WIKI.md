# Personal Wiki: Jommar Ilagan

## Identity
- **Name:** Jommar Ilagan
- **Location:** Manila, Metro Manila, Philippines (UTC+8)
- **Role:** Senior Full Stack Developer
- **Experience:** 10 years
- **Work Setup:** Remote

## Profiles
- **LinkedIn:** https://www.linkedin.com/in/jommarilagan/
- **GitHub:** https://github.com/jommar

## Tech Stack
- **Languages:** JavaScript, TypeScript, Go, Python (learning)
- **Backend:** Node.js, Express, AWS Lambda, Go/Gin
- **Frontend:** Vue, Nuxt, Pinia
- **Database:** MySQL, Redis
- **ORM/Query Builder:** Knex, Objection.js
- **Testing:** Cypress
- **Infrastructure:** Docker, Kafka
- **AI/ML Focus:** AI agents, MCP ecosystem

## Domain Expertise
- Healthcare
- Routing/Logistics
- SaaS
- Integrations

## Core Strengths
- Clean Code
- System Architecture
- Data Migration
- Performance Optimization

## Workstation
- **OS:** Linux Desktop
- **Displays:** Dual Monitors
- **IDE:** Antigravity
- **Hardware:** Suboptimal local hardware; uses OpenRouter for API-based AI inference
- **AI Tooling:** CLI agents (OpenCode), OpenRouter, MCP tool creation

## Agent Instructions

### Communication
- Be clear, structured, and concise
- No fluff, over-explaining, or junior-level basics
- Use short messages with direct purpose
- Tone: "Senior" for code, "Friendly" for non-code

### Coding Standards
- Use modern JS: `const`, arrow functions
- Prefer early returns over nested conditionals
- Keep single-line conditionals on one line
- Use braces for multi-line blocks
- Prefer `map`/`filter`/`reduce` over manual loops
- Use optional chaining (`?.`) and nullish coalescing (`??`)
- Write short, direct comments
- Keep error messages concise and structured
- Build for modularity and extensibility
- Prefer configuration over hardcoding
- Keep dependencies minimal

### Workflow
- Iterative, context-first approach to problem solving
- Ask for context before starting work
- Verify requirements before implementing
- Confirm understanding before coding
- Provide verification steps after implementation

## Goals & Interests
- **Career:** Open to business ventures and non-pure development roles
- **Business Focus:** Software, Dev-Tools, Automation, AI, SaaS
  - Ideas must be: actionable, profitable, feasible, solve a real pain point
  - Must include: MVP scope and GTM strategy
- **Side Projects:** Building and curating MCP tools for personal workflow optimization, with potential to package and share
- **Learning:** Python (AI/ML ecosystem), AI agents, MCP ecosystem
- **Routine:** Primarily computer-bound; steps away for meals and household chores

## Project Context (from Past Conversations)

### TransAct Monorepo
- **Path:** `/transAct`
- **Projects:** Portage-backend (NestJS), Portage-frontend (Nuxt/Vue), Routing (Express/Objection.js), TravelTracker (Express/Objection.js), EZAT-Backend (NestJS)
- **Key Work:** Legacy data migrations (CSV → MySQL via Python `migrate.py`), CSV validator robustness, sanity check scripts
- **Notable Quirks:** `admin` client row required in `travel_tracker_trips.client` for email system; `global.configuration` loaded from `config.json`
- **Wiki Docs:** `/transAct/docs/WIKI.md`, `/transAct/docs/WIKI-MIGRATIONS.md`

### Migration Pipeline
- **Flow:** CSV fix → DB restore → migration → post-migration scripts → DB dump → CSV validation → sanity checks
- **Key Files:** `TravelTracker/ddl/migrate.py`, `TravelTracker/app/admin/legacy-migration-csv-validator.js`, `TravelTracker/app/admin/index.js`
- **Client Structure:** `TravelTracker/ddl/ez_{client}/` directories with per-client migration logs

### AI/ML Infrastructure
- **Local Models:** Uses llama.cpp-server, exploring Gemma variants, Bonsai-8B
- **API Providers:** OpenRouter (primary), OpenCode Go
- **Tools:** MCP tool creation, wiki system for persistent agent context
- **Interests:** AI-to-AI platforms, agent discovery protocols, enterprise AI stacks

### Hardware & Environment
- **GPU:** NVIDIA GeForce RTX 4060
- **OS:** Ubuntu 24.04 (Kernel 6.8.x)
- **Docker:** Used for local databases (MySQL containers)
- **Email Testing:** Mailtrap sandbox for development
