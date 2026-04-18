# TravelTracker (Legacy)

## Architecture {#wiki-traveltracker-legacy-architecture}

Express.js backend + Vue 2 frontend (being migrated to Portage):

```
TravelTracker/
├── app/                     # Express backend
│   ├── model/               # Objection.js models
│   ├── [feature modules]/   # trip-request, assignment, invoice, etc.
│   ├── apiv2/               # Proxy to Portage backend
│   ├── ezr-sync/            # Sync with EZ Routing
│   ├── yellowfin/           # BI reporting integration
│   └── mysql-wrapper/       # Legacy raw SQL wrapper
├── ui/                      # Vue 2 frontend (Vue CLI)
│   ├── src/
│   │   ├── apis/            # Axios API clients
│   │   ├── components/      # Vue components
│   │   ├── views/           # Page directories
│   │   └── store/           # Vuex modules
├── common/                  # Shared between BE and FE (constants, email templates, calculations)
├── setup/
│   ├── knex/migrations/     # Database migrations
│   └── docker/              # Docker Compose for local MySQL + Redis
└── config.json              # Main configuration (contains dev credentials — DO NOT COMMIT)
```

---

## Frontend (Vue 2) {#wiki-traveltracker-legacy-frontend-vue-2}

- **Vue 2.7** (EOL Dec 2023) with Vuetify 2, Vuex 3, Vue Router 3
- **37+ Vuex store modules** mirroring backend domains (assignment, tripRequest, invoice, user, vehicle, etc.)
- Axios API client modules organized per domain in `src/apis/`
- Role-based route guards with `meta.checkRole` arrays
- **Hybrid routing** — Some routes (`/trip-requests`, `/dashboard`) redirect to Portage

---

## Key Concepts {#wiki-traveltracker-legacy-key-concepts}



---

## Notable Quirks {#wiki-traveltracker-legacy-notable-quirks}

1. **Three date libraries** coexist: `date-fns`, `luxon`, and `moment`
2. **`config.json` contains hardcoded credentials** — dev config, never commit
3. **Mix of response patterns** — `res.send()` and `req.response` + `next()` coexist
4. **Bluebird promises** alongside native async/await
5. **`mysql-wrapper`** (raw SQL) and Knex/Objection coexist
6. **ESLint declares globals**: `configuration`, `midware`, `appModules`
7. **`admin` client row must exist in `travel_tracker_trips.client` table** — The notification email system (`app/notification/index.js`) calls `adminMod.getClient('admin')` to retrieve SMTP settings from `client.data.emailServer`. If the `admin` row is missing, `getClient` returns `''`, causing `Cannot read properties of undefined (reading 'emailServer')`. The row's `data` JSON must include an `emailServer` object with `server`, `port`, `secure`, `email`, `username`, and `password` fields. These are normally populated from `configuration.defaultEmailServer` in `config.json` when a client is created via `createClient()`, but the `admin` client may have been created before this field existed.

---

---

## Testing {#wiki-traveltracker-legacy-testing}

| Type | Tool         | Command            |
| ---- | ------------ | ------------------ |
| Unit | Gulp + Mocha | `npm test`         |
| E2E  | Cypress      | `npx cypress open` |

---

