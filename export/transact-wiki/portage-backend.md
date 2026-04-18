# Portage Backend

## API Structure {#wiki-portage-backend-api-structure}

- **Base URL:** `/api/v2` (set via `app.setGlobalPrefix('api/v2')` in `main.ts`)
- **Swagger docs:** `/doc` (non-production only)
- **Response format:** `Response200.asApiResponse(data)` or `{ statusCode, message, data }` via `@app/response-codes`
- **List operations:** `POST /api/v2/{resource}/list/get` with `{ skip, take, sortList, filters, include }`
- **CRUD:** Almost all endpoints use `@Post()` (not GET/PUT/PATCH/DELETE), with a few `@Delete()` exceptions
- **DTOs:** Validated via `class-validator` with `@IsString()`, `@IsNumber()`, `@ValidateNested()`, `@Type(() => ...)`

---

## Architecture {#wiki-portage-backend-architecture}

NestJS monorepo with **3 apps** and **9 shared libraries**:

```
Portage-backend/
├── apps/
│   ├── api/           # Main REST API (Express, session auth, Kafka microservice)
│   ├── queue/         # Background job processor (Bull queues + Kafka consumers)
│   └── scheduler/     # Cron jobs (LDAP, OneRoster, roster sync — runs daily at midnight)
├── libs/
│   ├── client/        # Multi-tenant DB resolution, Prisma clients, request middleware
│   ├── common/        # Shared types, config, Redis, exception filters, transformers
│   ├── kafka/         # Kafka producer/consumer services
│   ├── logger/        # Rollbar-based structured logging
│   ├── email/         # Email sending (per-client SMTP)
│   ├── pdf/           # PDF generation (wkhtmltopdf + Handlebars)
│   ├── aws/           # AWS S3 integration
│   ├── twilio/        # SMS via Twilio
│   └── response-codes/# Standardized API response DTOs
└── test/
    ├── integration/   # Jest integration tests (JS files)
    └── load/          # k6 performance tests
```

---

## Database {#wiki-portage-backend-database}

**Two MySQL databases managed via Prisma:**

| Database | Schema          | Models              | Purpose                                       |
| -------- | --------------- | ------------------- | --------------------------------------------- |
| Admin    | `admin.prisma`  | 6                   | Client registry, admin users, system messages |
| Client   | `client.prisma` | Many models + views | All business data                             |

**Important:** Prisma is used as the **query layer only**. Schema migrations are still managed via **Knex** (legacy). Only 3 Prisma migrations exist.

**Key domain models:**

- `trip_request` — Central entity with relations to destinations, attendees, transportation, funding, approvals
- `assignment` — Driver/vehicle links to trips
- `invoice` — With staff costs, travel costs, payments, additional charges
- `staff` / `tt_staff` — Drivers and staff with license/certification info
- `vehicle` / `vehicleextra` — Fleet with capacity, wheelchair, GPS, depot info
- `funding_source` — Budget sources with approvers
- `approval_level` / `approver` — Multi-level approval workflows
- `bidding_period` / `driver_bid` — Driver bidding system
- `roster_student` / `roster_adult` — Student/adult rosters

---

## Key Concepts {#wiki-portage-backend-key-concepts}



---

## Key Modules {#wiki-portage-backend-key-modules}

| Module            | Description                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `trip-request/`   | Largest module — CRUD, approvals, PDFs, emails, comments, audit, rescheduling, duplication |
| `invoice/`        | Invoice management with staff/travel costs, payments, custom form fields                   |
| `assignment/`     | Driver/vehicle assignment, review workflow                                                 |
| `bidding-period/` | Driver bidding periods with bid CRUD                                                       |
| `approval-level/` | Configurable multi-level approval workflows                                                |
| `vehicle/`        | Vehicle fleet CRUD                                                                         |
| `user/`           | User management, roles, permissions                                                        |
| `legacy/`         | Proxy to TravelTracker backend for unmigrated endpoints                                    |
| `event-handler/`  | Domain event handlers                                                                      |
| `dashboard/`      | Analytics and summary data                                                                 |
| `roster/`         | Student/adult roster management                                                            |
| `geo/`            | Geocoding services                                                                         |
| `notification/`   | System notifications                                                                       |

---

## Notable Patterns & Quirks {#wiki-portage-backend-notable-patterns-quirks}

1. **BigInt-to-Int remapping** — Custom Prisma middleware converts all `bigint` to regular `int` (MySQL serialization workaround)
2. **`noImplicitAny: false` and `strictNullChecks: false`** in tsconfig
3. **Integration tests are JavaScript** (`.spec.js`), not TypeScript
4. **`handlebar` package** (not `handlebars`) — different, less common package
5. **`SKIP_MICROSERVICES`** env var allows running without Kafka in dev
6. **Body parser limit: 20MB** — supports large file uploads
7. **Prisma views** use `previewFeatures = ["views"]`
8. **Some models are `@@ignore`d** — lack unique identifiers
9. **LegacyService** proxies to TravelTracker — strangler fig pattern in progress

---

---

## Testing {#wiki-portage-backend-testing}

| Type        | Tool      | Location              | Command                        |
| ----------- | --------- | --------------------- | ------------------------------ |
| Unit        | Jest      | `*.spec.ts` colocated | `npm run test`                 |
| Integration | Jest (JS) | `test/integration/`   | `npm run test:integration:all` |
| Load        | k6        | `test/load/`          | Scripts in `test/load/`        |

**Run a single test:**

```bash
npx jest path/to/file.spec.ts              # Unit
npx jest --config test/integration/utils/jest-config.js -- test/integration/trips.spec.js  # Integration
```

---

