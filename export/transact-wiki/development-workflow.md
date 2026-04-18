# Development Workflow

## Database Migrations {#wiki-development-workflow-database-migrations}

```bash
# TravelTracker (Knex — per-client)
cd TravelTracker && npm run db:migration              # All clients
cd TravelTracker && npm run db:migration -- client=saraland  # Specific client
cd TravelTracker && npm run db:migration:rollback

# Portage Backend (Prisma — query layer only, Knex still manages schema)
cd Portage-backend && npx prisma generate             # Regenerate client
cd Portage-backend && npx prisma db pull              # Introspect schema changes
```

---

## Linting & Formatting {#wiki-development-workflow-linting-formatting}

```bash
# Portage Backend
cd Portage-backend && npm run lint        # ESLint --fix

# Portage Frontend
cd Portage-frontend && npm run lint:js    # ESLint
cd Portage-frontend && npm run lint:prettier  # Prettier check

# TravelTracker
cd TravelTracker && npm run lint:fix      # ESLint --fix
cd TravelTracker && npm run format        # Prettier --write
```

---

## Running Locally {#wiki-development-workflow-running-locally}

```bash
# Start everything (Portage FE + BE)
npm run ezat

# Or individually:
cd Portage-backend && npm run start:dev   # NestJS watch mode
cd Portage-frontend && npm run dev        # Nuxt dev server (localhost:3001)

# Legacy stack:
cd TravelTracker && npm run start         # PM2 backend + Vue FE watch
```

---

## Running Tests {#wiki-development-workflow-running-tests}

```bash
# Portage Backend
cd Portage-backend && npm run test                    # Unit
cd Portage-backend && npm run test:integration:trips  # Single integration suite
cd Portage-backend && npm run test:integration:all    # All integration

# Portage Frontend
cd Portage-frontend && npm run test:unit              # Vitest
cd Portage-frontend && npm run test:e2e:smoke         # Playwright smoke
cd Portage-frontend && npm run test                   # Cypress open

# TravelTracker
cd TravelTracker && npm run test                      # Gulp + Mocha
cd TravelTracker && npx cypress open                  # Cypress
```

---

---

