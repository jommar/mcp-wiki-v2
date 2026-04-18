# TransAct Monorepo — Developer Onboarding Wiki

## Overview

This monorepo contains the **EZ Activity Trips** platform — a school district transportation management system. We are actively migrating from a legacy stack (TravelTracker) to a modern stack (Portage).

| Project              | Path                | Stack                              | Status                  |
| -------------------- | ------------------- | ---------------------------------- | ----------------------- |
| **Portage Backend**  | `Portage-backend/`  | NestJS, TypeScript, Prisma, Kafka  | Active development      |
| **Portage Frontend** | `Portage-frontend/` | Nuxt 3, Vue 3, Pinia, Tailwind     | Active development      |
| **TravelTracker**    | `TravelTracker/`    | Express, Vue 2, Knex, Objection.js | Legacy (being migrated) |

---

## Quick Start

### Prerequisites

- **Node.js** >= 20.18.0 (check `.nvmrc` per project)
- **MySQL** (two databases: admin + client)
- **Redis**
- **Kafka** (optional for local dev — set `SKIP_MICROSERVICES=`)
- **Docker** (optional, for local MySQL + Redis via TravelTracker's `setup/docker/`)

### Root-Level Commands

```bash
npm run ezat          # Start Portage FE + BE in parallel
npm run ezr           # Start Routing FE + BE in parallel
npm run ezat:be       # Portage backend only
npm run ezat:fe       # Portage frontend only
```

### Environment Setup

1. Copy `.env.example` to `.env` in each project
2. Configure database URLs, Redis, Kafka, and GDIC auth URL
3. Run `npx prisma generate` in `Portage-backend/`

---

## Portage Backend

### Architecture

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

### Key Concepts

#### Multi-Tenant Database Pattern

- Each client (school district) has its **own MySQL database**: `ez_<clientname>`
- A shared **admin database** holds client registry and system-wide data
- `ClientMiddleware` reads the `client-database` header on every request
- `ClientService` maintains a **connection cache** (`Map<string, PrismaClient>`) keyed by client name
- Connections are dynamically constructed: `base_url + prefix + client_name`

#### Request Context (`TtContext`)

Attached to every Express request:

```typescript
interface TtContext {
  client: string;
  prisma: PrismaClientService;
  cookie?: string;
  user?: AuthenticatedUser;
  asTransaction: (prismaTransaction: Prisma.TransactionClient) => TtContext;
  clone: () => Promise<TtContext>;
}
```

#### Authentication

- **Session-based** (not JWT) — `express-session` with Redis store
- External auth via **GDIC** (Global Digital Identity Center)
- `AuthGuard` checks: `@Public()` routes → session user → `@Permission()` feature access
- Environment-specific session timeout: 60 min (dev) / 15 min (prod)

#### Permission System

- Role-based with many role types (Super Admin → Funding Manager)
- Features: ADMIN, USER, TRIP_REQUEST, INVOICE, VEHICLE, etc.
- Sub-features for granular access (TRIPS_GENERAL, INVOICE_STAFF_COST, etc.)
- Permission types: VIEW, ADD, EDIT, DELETE, APPROVE, CONFIG, etc.
- Field-level permissions for trip request forms (pending/approved/assigned states)
- Decorator usage: `@Permission({ feature: RefFeature.TRIP_REQUEST, type: RefPermission.VIEW })`

#### Event-Driven Architecture

- Internal: NestJS `EventEmitter` for domain events (TRIP_REQUEST_CREATE, ASSIGNMENT_DELETE, etc.)
- External: Kafka for inter-app communication (API ↔ Queue)
- Topics: `queue.sms.email`, `queue.check.health.event`, health check topics
- Custom event classes (e.g., `TripRequestCreateEvent`) wrap `TtContext` + payload

### Database

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

### API Structure

- **Base URL:** `/api/v2` (set via `app.setGlobalPrefix('api/v2')` in `main.ts`)
- **Swagger docs:** `/doc` (non-production only)
- **Response format:** `Response200.asApiResponse(data)` or `{ statusCode, message, data }` via `@app/response-codes`
- **List operations:** `POST /api/v2/{resource}/list/get` with `{ skip, take, sortList, filters, include }`
- **CRUD:** Almost all endpoints use `@Post()` (not GET/PUT/PATCH/DELETE), with a few `@Delete()` exceptions
- **DTOs:** Validated via `class-validator` with `@IsString()`, `@IsNumber()`, `@ValidateNested()`, `@Type(() => ...)`

### Key Modules

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

### Testing

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

### Notable Patterns & Quirks

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

## Portage Frontend

### Architecture

Nuxt 3 SPA (SSR disabled) with Vue 3 Composition API:

```
Portage-frontend/
├── pages/[client]/          # File-based routing, multi-tenant
├── modules/                 # Feature modules (trip-request, bids, dashboard, users, etc.)
├── stores/                  # Pinia stores organized by domain
├── components/              # Reusable UI components
│   ├── ui/                  # Base UI (buttons, icons, dialogs, tables)
│   ├── forms/               # Form fields (input, dropdown, checkbox, radio)
│   ├── template/            # Page layouts (list, cards, steps)
│   └── dialog/              # Modal dialogs
├── layouts/                 # Single layout (TopBar + Toast)
├── middleware/              # Global guards (auth, restricted-access, exit-prompt)
├── plugins/                 # PrimeVue, Google Maps
├── utils/                   # Helpers, types, constants
└── test/                    # Playwright e2e tests
```

### Key Concepts

#### Multi-Tenant Routing

- All routes scoped under `/:client/` — client slug from URL validated against backend
- `client` header sent with every API request
- Sign-out redirects to legacy app

#### Feature Module Pattern

- `modules/` is the heart of the app — organized by domain
- Pages are thin shells that delegate to feature modules via `defineAsyncComponent`
- Components use `<script setup lang="ts">` throughout

#### State Management (Pinia)

**Pinia stores organized by domain:**

| Domain   | Stores                                                                                                                    | Purpose                                      |
| -------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Core     | `auth`, `config`, `dashboard`, `geo`, `notifications`                                                                     | Session, permissions, client config, widgets |
| Trips    | `tripRequest`, `list`, `tripApproval`, `tripType`, `tripEvent`, `batch`                                                   | Multi-step form, list, approvals             |
| Bids     | `forms`, `calendar`, `summary`, `assignment`, `driver`, `config`                                                          | Bidding periods, driver view, calendar       |
| Settings | `users`, `destination`, `location`, `fundingSource`, `vehicleType`, `roster`, `approvalLevel`, `additionalTransportation` | Reference data management                    |
| UI       | `exitPrompt`                                                                                                              | Promise-based navigation guard               |

**Caching pattern:** Manual time-based caching (5-10 min) for reference data using module-scope variables.

#### API Integration Layer

`useFetchApi` helper wraps Nuxt's `useFetch`:

- Base URL from `runtimeConfig.public.apiBase`
- Auto-attaches `client` header from auth store
- `credentials: 'include'` for cookie-based auth
- Blob download support with `Content-Disposition` parsing
- Automatic error toasts for 400, 403, 404, 500 (skippable with `skipToast`)
- AbortController for request cancellation
- Returns `{ data: data.value?.data, pending, error, refresh, userError, cancel }` — note `data` is unwrapped one level

#### UI Library

| Library                | Purpose                                                         |
| ---------------------- | --------------------------------------------------------------- |
| **PrimeVue** (v3.53)   | UI components with `P` prefix (`PButton`, `PDataTable`, etc.)   |
| **Tailwind CSS**       | Custom brand colors, numeric font sizes, responsive breakpoints |
| **Vuelidate**          | Form validation                                                 |
| **Google Maps JS API** | Places autocomplete, geocoding                                  |

**Component auto-import:** Components registered with `pathPrefix: false` — `<ButtonPrimary>` works directly, no prefix needed.

### Key Pages

| Route                           | Description                                                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `/:client/`                     | Dashboard with role-based widget counts                                                                                   |
| `/:client/trip-requests`        | Paginated list with 35+ filters, sorting, bulk actions. Responsive desktop/mobile views via `useWindowSize()`             |
| `/:client/trip-requests/create` | 8-step wizard (General → Supporting Docs). Exit prompt on navigation away                                                 |
| `/:client/trip-requests/[id]`   | View/edit with `LazyTripRequestViewEdit`. Review tabs (Approval, Comments, Emails, Audit). Exit prompt on unsaved changes |
| `/:client/bids/admin`           | Admin bid management: create periods, assign drivers                                                                      |
| `/:client/bids/driver`          | Driver-facing: browse trips, place/remove bids                                                                            |
| `/:client/settings/users`       | User management: list, add, edit, roles, approval levels                                                                  |

### Testing

| Type | Tool       | Location                                        | Command                  |
| ---- | ---------- | ----------------------------------------------- | ------------------------ |
| Unit | Vitest     | `components/**/*.spec.ts`, `utils/**/*.spec.ts` | `npm run test:unit`      |
| E2E  | Playwright | `test/`                                         | `npm run test:e2e:smoke` |

**Note:** Cypress exists but Playwright is the primary E2E framework. Use Playwright for new tests.

### Notable Patterns & Quirks

1. **Draft mode** — Blue background with "DRAFT" watermark when editing draft trips
2. **Exit prompt** — Promise-based dialog blocks navigation on unsaved changes
3. **Duplicate functionality** — `stores/settings/trip.ts` and `stores/trips/tripType.ts` both fetch trip types
4. **Empty store** — `stores/settings/vehicle.ts` exists but is mostly empty (only has `useFetchApi` import)
5. **SSR disabled** — Pure client-side SPA despite Nuxt
6. **Auth handled by legacy app** — Checks health via `/api/v2/auth/health`, sign-out redirects to legacy
7. **Pages use `defineAsyncComponent`** for lazy loading, not direct imports
8. **Middleware execution order** — Files prefixed with numbers execute in order (`01-`, `02-`, etc.)
9. **Component auto-imports** — PrimeVue components registered with `P` prefix, custom components without prefix

---

## TravelTracker (Legacy)

### Architecture

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

### Key Concepts

#### Global State Pattern

- `global.configuration` — Loaded from `config.json` at startup, mutated at runtime
- `global.midware` — Permission middleware factory: `midware('action|model')`
- `global.appModules` — Feature flag configuration
- All modules rely on these globals

#### Multi-Tenancy

- Per-client databases: `ez_<clientname>`
- Central `travel_tracker_trips` DB holds client registry
- Knex connections cached per-client in a Map
- Hot-reload via `/api/init/:name` (localhost only)

#### API Structure

- Route pattern: `app.get('/api/{resource}', midware('action|model'), handler)`
- Permission middleware: `midware('view|triprequest')`, `midware('add|invoice')`, etc.
- Response pattern: Controllers set `req.error` or `req.response`, call `next()`, final middleware handles formatting
- **API v2 proxy** (`app/apiv2/`) forwards certain requests to Portage backend

#### Objection.js Models

- Many models with extensive relations (`HasManyRelation`, `ManyToManyRelation` with `through`)
- `AuditBaseModel` — Auto-logs to `tt_audit` via lifecycle hooks
- Heavy use of **static modifiers** for complex queries
- View models: `VwAllDrivers`, `VwAllLocations`, `VwAllVehicles`, `VwAllotments`, `VwSemesterFiscalYearMap`

#### Record Types (Code-Defined, Not in Database)

The `recordTypes` object in `app/shared/index.js` defines integer IDs for all entities. These are **not stored in the database** — they're used at runtime to identify entity types in audit logs and cross-system communication.

**Usage:**

```javascript
// In app/shared/index.js
const recordTypes = {
  school: 2,
  stop: 4,
  driver: 5,
  staff: 5, // driver/staff used interchangeably
  vehicle: 6,
  user: 10,
  address: 12,
  triprequest: 301,
  triptype: 302,
  tripevent: 303,
  destination: 304,
  budgetcode: 305,
  fundingsource: 306,
  location: 307,
  approvallevel: 310,
  approver: 311,
  assignment: 320,
  vehicletype: 322,
  additionaltransportation: 324,
  vehicleCondition: 327,
  invoice: 359,
  // ... more types
};

// Convert string to ID
shared.getRecordType('triprequest'); // returns 301

// Convert ID to string (reverse lookup)
shared.getRecordTypeKey(301); // returns 'triprequest'
```

**Common record types:**

| ID  | Entity        | Used In                    |
| --- | ------------- | -------------------------- |
| 2   | school        | Schools, locations         |
| 4   | stop          | Bus stops                  |
| 5   | driver/staff  | Drivers, staff members     |
| 6   | vehicle       | Vehicles                   |
| 10  | user          | User accounts              |
| 12  | address       | Addresses                  |
| 301 | triprequest   | Trip requests              |
| 302 | triptype      | Trip types                 |
| 304 | destination   | Trip destinations          |
| 306 | fundingsource | Funding sources            |
| 307 | location      | Locations (depots)         |
| 310 | approvallevel | Approval levels            |
| 311 | approver      | Approver assignments       |
| 320 | assignment    | Driver/vehicle assignments |
| 322 | vehicletype   | Vehicle types              |
| 359 | invoice       | Invoices                   |
| 96  | email         | Email records              |
| 99  | backup        | Backup records             |

**Audit logging:**
The `tt_audit` table stores `recordType` as an integer. The `auditMethodsMap` defines action types:

```javascript
shared.auditMethodsMap = {
  tripApproval: 104,
};
```

#### Real-Time Communication

- Socket.IO with Redis adapter for multi-node support
- Events: `login`, `disconnect`, `broadcast`, `server-started`
- Redis pub/sub for cross-node messaging

#### Scheduled Jobs

- Single `setInterval(1000ms)` loop checking time-based triggers
- Runs at specific times: 3 AM (sync, cleanup), 8 AM (notifications), 11 AM (user emails), 6:35 PM (assignment notifications)
- Redis distributed locks prevent duplicate execution

### Frontend (Vue 2)

- **Vue 2.7** (EOL Dec 2023) with Vuetify 2, Vuex 3, Vue Router 3
- **37+ Vuex store modules** mirroring backend domains (assignment, tripRequest, invoice, user, vehicle, etc.)
- Axios API client modules organized per domain in `src/apis/`
- Role-based route guards with `meta.checkRole` arrays
- **Hybrid routing** — Some routes (`/trip-requests`, `/dashboard`) redirect to Portage

#### Vuex Store Structure

Store registered in `ui/src/store/index.js` with modules for each domain. Each module follows the standard Vuex pattern:

```
store/modules/{Domain}/
├── state.js       # Reactive state object
├── mutations.js   # Synchronous state mutations
├── actions.js     # Async operations (API calls), dispatch mutations
├── getters.js     # Computed state accessors
└── store.js       # Barrel export { state, mutations, actions, getters }
```

Key modules: `assignment`, `tripRequest`, `invoice`, `user`, `vehicle`, `driver`, `fundingSource`, `approvalLevel`, `app`, `config`, `calendar`, `location`, `tripType`, `budgetCode`, `roster`, `staff`, `smsLog`, etc.

#### Router Guards

Defined in `ui/src/router/index.js` (~831 lines):

| Guard | Purpose |
|---|---|
| `beforeEach` | Role/permission checks, fetches client config, redirects to default path if access denied |
| `beforeResolve` | Sets `document.title` from route meta |
| `beforeEnter` (per-route) | Inline guards on Dashboard, Trip Requests, Driver routes for specific access checks |
| `afterEach` | Clears Vuex store data when navigating away from specific routes (e.g., `/assignments`) |

#### Assignment Screen Data Loading & Store Cleanup

The Assignment List view (`views/Assignments/List.vue`) loads heavy data on mount:

```js
async refresh() {
  this.loading = true;
  await this[GET_TRIP_REQUESTS]();           // loads all trip requests into tripRequest store
  await this[GET_ASSIGNMENTS]({              // loads all assignments into assignment store
    tripRequestIds: this.tripRequests.map((e) => e.id)
  });
  this.filterAssignments(this.assignmentListFilters);
  this.loading = false;
}
```

**Problem:** Vuex store retains this data even after navigating away (e.g., to Invoice screen), causing memory buildup on large datasets. Unlike the Trip Request screen (which navigates to Portage and triggers a full page refresh), the Assignment screen stays within the Vue 2 SPA.

**Solution:** `router.afterEach` guard clears store data when navigating away from `/assignments`:

```js
router.afterEach((to, from) => {
  if (from.path.startsWith('/assignments') && !to.path.startsWith('/assignments')) {
    store.dispatch('assignment/clearAssignments');
    store.dispatch('tripRequest/clearTripRequests');
  }
});
```

Each store module has a corresponding `clear*` mutation + action that resets state to initial empty values (e.g., `clearAssignments` resets `assignments`, `filteredAssignmentIds`, `selectedAssignments` to `[]`).

### Testing

| Type | Tool         | Command            |
| ---- | ------------ | ------------------ |
| Unit | Gulp + Mocha | `npm test`         |
| E2E  | Cypress      | `npx cypress open` |

### Notable Quirks

1. **Three date libraries** coexist: `date-fns`, `luxon`, and `moment`
2. **`config.json` contains hardcoded credentials** — dev config, never commit
3. **Mix of response patterns** — `res.send()` and `req.response` + `next()` coexist
4. **Bluebird promises** alongside native async/await
5. **`mysql-wrapper`** (raw SQL) and Knex/Objection coexist
6. **ESLint declares globals**: `configuration`, `midware`, `appModules`
7. **`admin` client row must exist in `travel_tracker_trips.client` table** — The notification email system (`app/notification/index.js`) calls `adminMod.getClient('admin')` to retrieve SMTP settings from `client.data.emailServer`. If the `admin` row is missing, `getClient` returns `''`, causing `Cannot read properties of undefined (reading 'emailServer')`. The row's `data` JSON must include an `emailServer` object with `server`, `port`, `secure`, `email`, `username`, and `password` fields. These are normally populated from `configuration.defaultEmailServer` in `config.json` when a client is created via `createClient()`, but the `admin` client may have been created before this field existed.

---

## Trip Request Lifecycle

The trip request is the core domain entity. Here's the complete lifecycle from creation to completion.

### Status Flow

```mermaid
flowchart TD
    subgraph Main_Flow
        A[DRAFT<br>status=0] -->|Create, edit, validate| B[SUBMITTED<br>status=1]
        B -->|All levels approved| C[approved=1<br>pendingApprovalLevel=0]
        C -->|Assignment workflow| D[COMPLETED<br>status=2<br>assignmentStatus=completed]
    end

    subgraph Approval_Actions
        B -->|POST /approve| E[approved=1 on level]
        B -->|POST /deny| F[DENIED<br>status=-2]
        B -->|POST /request-change| G[RESUBMIT<br>status=-1]
    end

    subgraph Side_Branches
        F -->|REINSTATE| B
        G -->|Re-edit| B
        H[CANCELLED<br>status=-3] -.->|REINSTATE| B
    end

    subgraph Assignment_Status
        I[pending] --> J[readyToAssign]
        J --> K[partiallyAssigned]
        K --> D
    end

    style A fill:#f9f,stroke:#333,stroke-width:2px
    style D fill:#9f9,stroke:#333,stroke-width:2px
    style F fill:#f99,stroke:#333,stroke-width:2px
    style G fill:#ff9,stroke:#333,stroke-width:2px
    style H fill:#f99,stroke:#333,stroke-width:2px
```

**Status constants** (`libs/common/constants/trip-request.constants.ts`):

```typescript
export const TRIP_STATUS = {
  DRAFT: 0,
  SUBMITTED: 1,
  COMPLETED: 2,
  RESUBMIT: -1,
  DENIED: -2,
  CANCELLED: -3,
};
```

**Display statuses** (computed in SQL query):

- `not_submitted` — status 0 (draft)
- `pending_approval` — submitted but not all levels approved
- `approved` — all levels approved, not yet assigned
- `approved_and_assigned` — all levels approved + assignmentStatus = 'completed'
- `change_requested` — status -1 (resubmit)
- `canceled` — status -3
- `denied` — status -2
- `completed` — status 2

**Assignment statuses** (`libs/common/constants/assignment.constants.ts`):

- `pending` — no assignments yet
- `readyToAssign` — trip is approved, ready for driver/vehicle assignment
- `partiallyAssigned` — some but not all drivers/vehicles assigned
- `partiallyAssignedDriver` — drivers assigned, vehicles pending
- `partiallyAssignedVehicle` — vehicles assigned, drivers pending
- `completed` — all drivers and vehicles assigned

### Backend Endpoints

| Method   | Endpoint                                               | Purpose                                       |
| -------- | ------------------------------------------------------ | --------------------------------------------- |
| `POST`   | `/trip-request`                                        | Create a new trip (as DRAFT)                  |
| `POST`   | `/trip-request/update`                                 | Update a trip request                         |
| `POST`   | `/trip-request/validate`                               | Validate a full trip request                  |
| `POST`   | `/trip-request/validate-section/:section`              | Validate a single section                     |
| `POST`   | `/trip-request/submit/:id`                             | Submit a trip (validates first, then submits) |
| `POST`   | `/trip-request/reschedule`                             | Reschedule an existing trip                   |
| `POST`   | `/trip-request/duplicate/:id`                          | Duplicate a trip (creates new DRAFT)          |
| `DELETE` | `/trip-request/:id`                                    | Delete a trip request                         |
| `POST`   | `/trip-request/operation/cancel`                       | Cancel one or more trips                      |
| `POST`   | `/trip-request/reinstate/:id`                          | Reinstate a cancelled trip back to SUBMITTED  |
| `POST`   | `/trip-request/operation/change-submitter`             | Change the submitter                          |
| `POST`   | `/trip-request/list/get`                               | List trips with filters                       |
| `POST`   | `/trip-request/get/:id`                                | Get single trip by ID                         |
| `POST`   | `/trip-request/request-quote`                          | Request a trip estimate/quote                 |
| `POST`   | `/trip-request/trip-estimate/download`                 | Download trip estimate PDF                    |
| `POST`   | `/trip-request/permission-slip/download`               | Download permission slip                      |
| `POST`   | `/trip-request/comment/add`                            | Add comment to trip                           |
| `POST`   | `/trip-request/comment/list/:id`                       | Get comments for a trip                       |
| `POST`   | `/trip-request/audit-history/:id`                      | Get audit history for a trip                  |
| `POST`   | `/trip-request/email-history/:id`                      | Get email history for a trip                  |
| `POST`   | `/trip-request/operation/send-scheduled-notifications` | Send scheduled notifications                  |
| `POST`   | `/trip-request/save-recurrence`                        | Save recurring trip pattern                   |

### Event Handlers

Every lifecycle action emits a domain event handled by `TripRequestHandlerService`:

| Event                           | Handler                              | What it does                                                                                                                          |
| ------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `TRIP_REQUEST_CREATE`           | `handleOnTripRequestCreate`          | Logs audit entry if part of a batch                                                                                                   |
| `TRIP_REQUEST_UPDATE`           | `handleOnTripRequestUpdate`          | Updates assignment status, syncs funding to invoices, logs field changes, refreshes approval levels if status=SUBMITTED               |
| `TRIP_REQUEST_SUBMIT`           | `handleOnTripRequestSubmit`          | Logs audit ("Submitted" or "Resubmitted"), sets `pendingApprovalLevel` or `approved: 1`, creates recurring trips, sends notifications |
| `TRIP_REQUEST_CANCEL`           | `handleOnTripRequestCancel`          | Deletes all assignments, sends cancellation notifications, logs audit with reason                                                     |
| `TRIP_REQUEST_RESCHEDULE`       | `handleOnTripRequestReschedule`      | Logs audit with old/new dates                                                                                                         |
| `TRIP_REQUEST_DUPLICATED`       | `handleOnTripRequestDuplicate`       | Logs audit "Duplicated from Trip #X"                                                                                                  |
| `TRIP_REQUEST_REINSTATE`        | `handleOnTripRequestReinstate`       | Logs audit "Trip Request Reinstated"                                                                                                  |
| `TRIP_REQUEST_CHANGE_SUBMITTER` | `handleOnTripRequestChangeSubmitter` | Logs audit for each trip with old/new submitter names                                                                                 |
| `TRIP_REQUEST_DELETE`           | `handleOnTripRequestDelete`          | Logs audit "Trip Request Deleted"                                                                                                     |

### Frontend Flow

1. **Create** — `TripRequestCreate.vue` (8-step wizard), saves as draft via `tripRequestStore.saveTrip()`
2. **Submit** — `TripRequestViewEdit.vue` calls `tripRequestStore.submitTrip(id)` after validating all sections
3. **List** — `TripRequestList.vue` with 35+ filters, color-coded status badges, context menu actions
4. **View/Edit** — `TripRequestViewEdit.vue` with tabbed sidebar (details, approvals, assignments, invoice, comments, emails, audit)
5. **Approve** — `TripActionBar.vue` with Approve/Deny/Request Changes buttons, calls `tripApprovalStore`
6. **Bulk Approve** — `DialogBulkApprove.vue` for mass approval of trips matching filter criteria
7. **Cancel** — `DialogCancelTrip.vue` (single) or `DialogCancelTripRequests.vue` (bulk) modal with reason input
8. **Reschedule** — `DialogRescheduleTrip.vue` modal with new date pickers
9. **Duplicate** — `DialogCreateDuplicate.vue` modal
10. **Change Submitter** — `DialogChangeSubmitterAllTrips.vue` for reassigning submitter across multiple trips
11. **Mass Assign** — `DialogMassAssign.vue` for bulk driver/vehicle assignment
12. **Exit prompt** — Middleware `03-trip-create-exit-prompt.global.ts` blocks navigation on unsaved changes

**Key Vue components** (`modules/trip-request/`):

| Component                        | Purpose                                            |
| -------------------------------- | -------------------------------------------------- |
| `TripRequestCreate.vue`          | 8-step trip creation wizard                        |
| `TripRequestViewEdit.vue`        | Main trip view/edit with tabbed interface          |
| `TripRequestList.vue`            | Paginated list with filters, sorting, bulk actions |
| `TripActionBar.vue`              | Action buttons (Approve, Deny, Request Changes)    |
| `DialogBulkApprove.vue`          | Bulk approval modal                                |
| `DialogCancelTrip.vue`           | Cancel single trip modal                           |
| `DialogCancelTripRequests.vue`   | Cancel multiple trips modal                        |
| `DialogRescheduleTrip.vue`       | Reschedule modal                                   |
| `DialogCreateDuplicate.vue`      | Duplicate trip modal                               |
| `review-tabs/ApprovalStatus.vue` | Approval level status display                      |
| `review-tabs/TripDetails.vue`    | Trip details display                               |
| `review-tabs/AssignmentTab.vue`  | Assignment management                              |
| `review-tabs/InvoiceTab.vue`     | Invoice/estimate tab                               |
| `review-tabs/CommentsTab.vue`    | Comments thread                                    |
| `review-tabs/EmailsTab.vue`      | Email history                                      |
| `review-tabs/AuditTab.vue`       | Audit log                                          |

---

## Approval Workflow Deep Dive

The approval system is multi-level, criteria-based, and sequential. A trip may need to pass through multiple approvers before it can be assigned.

### Data Models

**`approval_level`** — Defines an approval stage:

```prisma
model approval_level {
  id                Int                        @id @default(autoincrement())
  name              String                     @VarChar(255)
  incOvernightOOS   Int                        @default(0) @TinyInt
  assignBusses      Int                        @default(0) @TinyInt
  boardReport       Int                        @default(0) @TinyInt
  notify            Int                        @default(0) @TinyInt
  seq               Int?
  created           Int
  approvalTripTypes approval_level_trip_type[]
  approvalCriteria  approval_level_criteria[]
}
```

**`approval_level_criteria`** — Conditional rules for when a level applies:

```prisma
model approval_level_criteria {
  id              Int            @id @default(autoincrement())
  approvalLevelId Int
  func            String?        @VarChar(1024)   // JS expression string
  label           String?        @VarChar(1024)
  approvalLevel   approval_level @relation(fields: [approvalLevelId], references: [id])
}
```

**`approval_level_trip_type`** — Which trip types trigger this level:

```prisma
model approval_level_trip_type {
  id              Int            @id @default(autoincrement())
  approvalLevelId Int
  tripTypeId      Int
  approvalLevel   approval_level @relation(fields: [approvalLevelId], references: [id])
  @@unique([approvalLevelId, tripTypeId])
}
```

**`approver`** — User assigned to approve at a specific level:

```prisma
model approver {
  id              Int     @id @default(autoincrement())
  uuid            String  @VarChar(36)
  userId          Int
  userEmail       String  @VarChar(255)
  approvalLevelId Int
  locationId      Int
  tripTypeId      Int
  isPrimary       Int     @default(0) @TinyInt
  user            tt_user @relation(fields: [userId], references: [id])
  @@unique([userId, userEmail, approvalLevelId, locationId, tripTypeId])
}
```

**Implementation note:** `approver.id` is an internal surrogate key and is **not** the primary join target for approval flow queries. In practice, approval matching uses `approvalLevelId + locationId + tripTypeId` and `userId` (joined to `tt_user.id`).

**`trip_approvals`** — Approval records per trip request:

```prisma
model trip_approvals {
  approvalLevelId Int
  tripRequestId   Int
  fundingSourceId Int          @default(0)
  approved        Int          @default(0)   // 0=pending, 1=approved, 2=denied, 3=changes_requested
  comments        String?      @VarChar(255)
  createdAt       DateTime?    @default(now())
  approvedAt      DateTime?
  approvedBy      Int?
  trip_request    trip_request @relation(...)
  tt_user         tt_user?     @relation(fields: [approvedBy], references: [id])

  @@id([approvalLevelId, tripRequestId, fundingSourceId])
}
```

**`level_approval`** — Audit trail for approval actions:

```prisma
model level_approval {
  id              Int    @id @default(autoincrement())
  tripRequestId   Int
  approvalLevelId Int
  approved        Int    @TinyInt   // 0=pending, 1=approved, 2=denied, 3=changes
  userId          Int
  timestamp       Int
  comments        String @Text
}
```

**`trip_request` relevant fields:**

```prisma
model trip_request {
  id                  Int
  status              Int?     // 0=draft, 1=submitted, 2=completed, -1=resubmit, -2=denied, -3=cancelled
  approved            Int?     @default(0)   // 0=not fully approved, 1=fully approved
  pendingApprovalLevel Int?    @default(0)   // ID of level awaiting approval, 0 if fully approved
  // ... other fields
}
```

### Configuring Approval Levels

Each approval level has these properties:

| Property            | Purpose                                                        |
| ------------------- | -------------------------------------------------------------- |
| `name`              | Display name (e.g. "Principal", "Transportation Director")     |
| `seq`               | Ordering — lower `seq` = earlier in the chain                  |
| `approvalTripTypes` | Which trip types trigger this level (many-to-many)             |
| `approvalCriteria`  | Additional conditions that must be met for this level to apply |
| `assignBusses`      | Whether vehicle assignment can happen at this level            |
| `notify`            | Whether to notify the next approver when this level approves   |
| `incOvernightOOS`   | Overnight/out-of-state handling                                |
| `boardReport`       | Board report inclusion                                         |

**Approver assignment** is done via `UserFormApprovalLevels.vue` where an admin assigns a user as an approver for specific:

- Approval Level
- Location(s) (or "All Locations" = `0`)
- Trip Type(s)
- Primary flag (one primary per level+location+tripType combo)

### How Criteria Work

Criteria are **JavaScript expression strings** stored in `approval_level_criteria.func` that are evaluated against a trip request:

```javascript
// Simple boolean field check
func = `tripRequest.outOfState`;

// Destination check
func = `prospectiveDestinationIds.includes(tripRequest.destinationId)`;

// Field comparison
func = `tripRequest.fieldName == 'value'`;
func = `tripRequest.fieldName > 10`;

// Custom form field
func = `tripRequest.customFormFields[Object.keys(tripRequest.customFormFields).find(e => e == 'fieldName')]`;
```

**Special criterion: "Funding Source"** — when a criteria label is "Funding Source", the system dynamically creates an approval level per funding source on the trip, using the funding source's designated approver.

### Approval Processing Flow

The approval system uses a **hybrid architecture** where Portage backend acts as an API gateway, delegating actual approval logic to the legacy TravelTracker backend via `LegacyService`.

```mermaid
flowchart LR
    subgraph Portage_Frontend
        A[Vue 3 SPA]
    end

    subgraph Portage_BE["Portage Backend (NestJS)"]
        B[trip-request-approval.controller]
        C[LegacyService<br/>HTTP Proxy]
    end

    subgraph Legacy_BE["Legacy Backend (TravelTracker)"]
        D[Approval Logic<br/>Criteria Evaluation<br/>Approver Matching]
    end

    A -->|"POST /approve|deny|request-change"| B
    B -->|"/api/trip-request/approve"| C
    C --> D
    D --> C
    C -->|"response"| B
    B -->|"response"| A
```

**Approval flow:**

```
1. Trip is submitted → submitTripRequest()
   ├── Sets status = SUBMITTED, resets trip_approvals to approved=0
   ├── Calls legacyService.refreshTripApprovalLevel() → proxies to legacy API
   └── Event: TRIP_REQUEST_SUBMIT → handleOnTripRequestSubmit()

2. Legacy backend processes:
   ├── Evaluates approval_level_criteria (JS expressions)
   ├── Matches approvers by approvalLevelId + locationId + tripTypeId
   ├── Handles funding source approvals (creates entries per funding source)
   └── Saves to trip_approvals table

3. Approval actions (Portage BE → LegacyService proxy):
   ├── POST /trip-request-approval/approve
   │   └── Proxies to /api/trip-request/approve with { approved: 1 }
   ├── POST /trip-request-approval/deny
   │   └── Proxies with { approved: 2 }
   ├── POST /trip-request-approval/request-change
   │   └── Proxies with { approved: 3 }
   ├── POST /trip-request-approval/bulk-approve
   │   └── Proxies to /api/trip-request/bulk-approve
   └── POST /trip-request-approval/reset-approval
       └── Proxies to /api/trip-request/reset-approval

4. Post-action handlers (Portage BE):
   ├── handleOnTripRequestSubmit() sets pendingApprovalLevel or approved=1
   ├── Creates recurring trips (createRecurringTrips)
   ├── Auto-assigns vehicles (LegacyService.isTripRequestReadyToAssign)
   └── Sends notifications via TripRequestNotificationService
```

**Approval state values** (`trip_approvals.approved`):

| Value | Status            | Description       |
| ----- | ----------------- | ----------------- |
| 0     | pending           | Awaiting approval |
| 1     | approved          | Approved          |
| 2     | denied            | Denied            |
| 3     | changes_requested | Request changes   |

**Approval action values** (sent to legacy API):

| Value | Action          | Effect                            |
| ----- | --------------- | --------------------------------- |
| 1     | APPROVE         | Approves the level                |
| 2     | DENY            | Denies the trip                   |
| 3     | REQUEST_CHANGES | Requests changes, resets to draft |

**Key LegacyService methods for approvals:**

```typescript
// In apps/api/src/legacy/legacy.service.ts
async updateApprovalOnTripRequest(data, options)   // Single approval
async bulkUpdateApprovalOnTripRequest(data, options) // Bulk approve
async resetApprovalOnTripRequest(options)           // Reset to level N
async refreshTripApprovalLevel({ tripRequestIds, recompute }, options)  // Refresh levels
```

### Determining Fully Approved

A trip is fully approved when:

1. **Every** `trip_approvals` record has `approved = 1` (or there are no approval levels)
2. `trip_request.approved = 1`
3. `trip_request.pendingApprovalLevel = 0`

```sql
-- Check: all levels approved
SELECT COUNT(*) as totalLevels,
       SUM(ta.approved = 1) as approvedLevels
FROM trip_approvals ta
WHERE ta.tripRequestId = ?

-- Trip is fully approved when: totalLevels = approvedLevels
-- Or when totalLevels = 0 (auto-approved, no matching approval levels)
```

**Auto-approval**: If no approval levels match a trip (no criteria met, no approvers configured), the trip is **auto-approved** with `pendingApprovalLevel = 0` and `approved = 1` set by `handleOnTripRequestSubmit()`.

### Frontend Approval Components

| File                                                  | Purpose                                                               |
| ----------------------------------------------------- | --------------------------------------------------------------------- |
| `modules/trip-request/component/TripActionBar.vue`    | Approve/Deny/Request Changes buttons; calls `tripApprovalStore`       |
| `modules/trip-request/review-tabs/ApprovalStatus.vue` | Displays approval level table with status, approver names, dates      |
| `modules/users/form/UserFormApprovalLevels.vue`       | Assign users as approvers for specific levels/locations/trip types    |
| `stores/settings/approvalLevel.ts`                    | Pinia store for fetching and filtering approval levels                |
| `stores/trips/tripApproval.ts`                        | Approval actions: approve, deny, request changes, bulk approve, reset |

**API endpoints for approval (Portage BE):**

| Method | Endpoint                                | Purpose                              |
| ------ | --------------------------------------- | ------------------------------------ |
| `POST` | `/trip-request-approval/approve`        | Approve a single level               |
| `POST` | `/trip-request-approval/deny`           | Deny the trip                        |
| `POST` | `/trip-request-approval/request-change` | Request changes                      |
| `POST` | `/trip-request-approval/bulk-approve`   | Bulk approve all matching trips      |
| `POST` | `/trip-request-approval/reset-approval` | Reset approval from a specific level |

### Key Architectural Notes

1. **Hybrid architecture**: Portage backend acts as an API gateway, delegating approval mutations to TravelTracker via `LegacyService` HTTP calls. The actual approval computation (criteria evaluation, approver matching) lives in TravelTracker.

2. **Approval state is stored in two places**:
   - `trip_approvals` table: Persistent approval records (managed by legacy, synced to Portage via Prisma)
   - `trip_request` fields: `approved` (0/1), `pendingApprovalLevel` (level ID)

3. **Sequential chain**: Levels ordered by `seq`. System finds first `approved = 0` as `awaitingApproval`. When approved, moves to next level.

4. **Primary vs Secondary approvers**: Primary approvers (`approver.isPrimary = 1`) can act on approvals. Secondary approvers are CC'd/visible in the UI.

5. **Funding source approvals**: When criteria has label "Funding Source", the system dynamically creates a separate approval level entry per funding source on the trip.

6. **Reset/Reinitiate**: Admin can reinitiate approval from level N — resets all levels from N onward to `approved = 0`, sets status back to `submitted`, notifies the first non-approved level's approver.

7. **Bulk approve**: Admin can approve all pending trips matching filter criteria in one operation via `POST /trip-request-approval/bulk-approve`.

### Known Edge Cases for Funding Source Approval

Based on codebase analysis and database verification, there are scenarios where funding source approval may NOT be triggered:

#### 1. Funding Source Criteria Excluded Due to INNER JOIN with Approver (ROOT CAUSE - CONFIRMED)

**Location:** `TravelTracker/app/approval-level/set-trip-approvals.js` (lines 144-153)

```javascript
// The getCriteria function does INNER JOIN with approver
.joinRelated({
  al: {
    $relation: 'approval_level',
    a: {
      $relation: 'approver',  // <-- INNER JOIN filters out criteria with no approvers!
      ...
    },
  },
})
```

**Database verification (ez_newportva):**
```sql
-- Criteria EXISTS but has no approvers
SELECT id, label, approvalLevelId FROM approval_level_criteria WHERE label = 'Funding Source';
-- Result: id=3, label='Funding Source', approvalLevelId=5

SELECT COUNT(*) FROM approver WHERE approvalLevelId = 5;
-- Result: 0 -- NO APPROVERS ASSIGNED

-- Because of INNER JOIN, criteria for level 5 is EXCLUDED from getCriteria query
SELECT COUNT(*) FROM trip_approvals WHERE approvalLevelId = 5;
-- Result: 0
```

**Scenario:**
1. `approval_level_criteria` has record with `label = 'Funding Source'` → level 5
2. `approver` table has **NO entries** for `approvalLevelId = 5`
3. `getCriteria()` does **INNER JOIN** with `approver` table
4. Since no approvers exist, the Funding Source criteria is **filtered out completely**
5. `evaluateTripRequestCriteria()` never sees the criteria
6. No approval entry is created for level 5

**Impact:** Funding source approval is completely bypassed in production because the INNER JOIN with `approver` excludes criteria that has no approvers.

---

#### 1b. Funding Approval Skipped When No Other Approval Levels Exist (JIRA VALIDATED)

**Location:** `TravelTracker/app/approval-level/set-trip-approvals.js` (lines 56-59)

```javascript
if (!criteriaList.length && !approverList.length) {
  await deleteTripsApproval({ context, tripRequestId: tr.tripRequestId });
  continue;  // <-- SKIPS funding source handling!
}
```

**This is the root cause described in the Jira ticket:**

> *"Funding approval configured at the Funding Source level does not appear in the trip request approval workflow unless another approval level is configured."*

**Logic flow:**
1. `getCriteria()` returns empty list (Funding Source criteria filtered out by INNER JOIN)
2. `getApprover()` returns empty list (no other approval levels for this trip type/location)
3. Both lists are empty → `deleteTripsApproval()` is called, then `continue`
4. **Never reaches `saveFundingSourceApproval()`** because it skips entirely!

**Database verification (ez_newportva):**
```sql
-- Trips with funding sources but NO approval entries
SELECT tr.id, tr.tripTypeId, tr.locationId, tr.status
FROM trip_request tr
LEFT JOIN trip_approvals ta ON tr.id = ta.tripRequestId
WHERE tr.status = 1 AND ta.tripRequestId IS NULL
ORDER BY tr.id DESC LIMIT 5;

-- Results: 70910, 70909, 70908, 70907, 70906 all have NO approval entries!
```

**Impact:** Funding approvals are bypassed when no other approval levels are configured for the trip type/location combination.

**Validation:** This exactly matches the Jira ticket description:
- ✅ "Funding approval does not appear in the approval workflow unless another approval level is configured"
- ✅ "When another approval level is configured, funding approval begins appearing"
- ✅ "Trip is automatically approved" (no approvals exist)

**Mitigation options:**
1. **Quick fix:** Assign at least one approver to the Funding Source approval level (level 5)
2. **Code fix 1:** Move `saveFundingSourceApproval()` call BEFORE the empty check (lines 56-59)
3. **Code fix 2:** Change INNER JOIN to LEFT JOIN so criteria is returned even without approvers
4. **Code fix 3:** Add special handling for "Funding Source" label criteria (don't require approver)

---

#### 2. Individual Funding Source Has No approverId

**Location:** `TravelTracker/app/approval-level/set-trip-approvals.js` (line 270)

```javascript
.andWhere('fs.approverId', '>', 0);
```

**Scenario:** If a funding source is added to a trip request but the `funding_source` table record has `approverId = 0` or NULL, the approval entry will NOT be created.

**Database verification (ez_newportva):**
```sql
SELECT COUNT(*) FROM funding_source WHERE approverId = 0 OR approverId IS NULL;
-- Result: 26 funding sources with no approver

SELECT id, name FROM funding_source WHERE approverId = 0 LIMIT 5;
-- id  name
-- 10  Admin Building - CNI - Elementary
-- 92  Athletics - High School
-- 93  Athletics - Middle School
-- ...
```

**Flow:**
1. `hasFundingSource` will be `true` (funding exists in `trip_funding`)
2. `saveFundingSourceApproval()` is called
3. Query filters out funding sources where `approverId <= 0`
4. Returns empty array → no approval entry created

**Mitigation:** Ensure every funding source that should require approval has a valid `approverId` set in the `funding_source` table.

---

#### 3. Funding Source Approver vs Approval Level Approver Are Disconnected

**Location:** `TravelTracker/app/approval-level/set-trip-approvals.js` (lines 158-172)

```javascript
const getApprover = async ({ context, tripTypeId, locationId }) => {
  const approvers = await Approver.query(knex)
    .where({ locationId, tripTypeId, 'ap.isPrimary': 1 });
  return approvers;
};
```

**Problem:** The system uses **two different approver sources** that are never connected:

| Approver Type | Stored In | Example |
|--------------|-----------|---------|
| **Funding Source approver** | `funding_source.approverId` | Funding source 29 has `approverId = 297` |
| **Approval Level approver** | `approver` table | User 297 might not be in `approver` table for level 5 |

**Scenario:**
1. Funding source 29 has `approverId = 297` (person A)
2. But `approver` table has NO entry for `approvalLevelId = 5` with `userId = 297`
3. Even if Funding Source criteria is included, there's no way to match the funding source's approver to the approval level

**Current logic:**
- `getCriteria()` gets criteria (if it weren't filtered by INNER JOIN)
- `getApprover()` gets approvers from `approver` table (approval level approvers)
- `filterApprovers()` matches approvers to criteria
- **Never uses `funding_source.approverId`!**

**Database verification (ez_newportva):**
```sql
-- Funding source 29 has approverId = 297
SELECT id, name, approverId FROM funding_source WHERE id = 29;
-- Result: id=29, approverId=297

-- But there's NO entry in approver table for level 5 with userId = 297!
SELECT * FROM approver WHERE approvalLevelId = 5 AND userId = 297;
-- Result: Empty (no match)
```

**Impact:** Even if the code properly includes funding source criteria, there's no connection between the funding source's approver and the approval workflow.

**Mitigation:** This requires a design decision:
1. **Option A:** Add approvers to level 5 in `approver` table that match `funding_source.approverId`
2. **Option B:** Modify code to use `funding_source.approverId` directly for funding source approvals
3. **Option C:** Create a mapping between `funding_source.approverId` and `approver` table entries

---

## Possible Fixes for Funding Source Approval Issues

### Root Cause Summary

The funding source approval has two main issues:

1. **INNER JOIN excludes criteria** - `getCriteria()` filters out Funding Source criteria because no approvers exist in `approver` table for level 5
2. **Early continue skips funding** - Lines 56-59 skip funding source handling entirely when no other approval levels exist
3. **Disconnected approver systems** - `funding_source.approverId` (tt_user.id) is never linked to `approver` table

---

### Approach 1: Insert into `approver` table (Database Fix)

**SQL Fix:**

```sql
-- Insert funding source approvers into approver table
-- Note: approver.uuid is used to group same user's multiple approval entries
-- The code uses 'funding-approver' as a marker for funding approvers
INSERT INTO approver (userId, approvalLevelId, locationId, tripTypeId, isPrimary, uuid)
SELECT 
    fs.approverId AS userId,
    alc.approvalLevelId,
    0 AS locationId,        -- All locations
    0 AS tripTypeId,        -- All trip types  
    1 AS isPrimary,
    'funding-approver' AS uuid  -- Same marker used in code (approver.js lines 113, 182)
FROM funding_source fs
JOIN approval_level_criteria alc ON alc.label = 'Funding Source'
WHERE fs.approverId > 0
AND NOT EXISTS (
    SELECT 1 FROM approver ap 
    WHERE ap.userId = fs.approverId AND ap.approvalLevelId = alc.approvalLevelId
);
```

**Note:** The code shows `uuid: 'funding-approver'` is used as a marker for funding approvers (see `approver.js` lines 113, 182). This same uuid groups all of a user's funding approval entries together.

**Database verification (ez_newportva):**
- 109 funding sources have `approverId > 0` but NOT in `approver` table
- 5 funding sources have `approverId > 0` and ARE in `approver` table

**Pros:**
- Works with existing code
- No code changes needed

**Cons:**
- Still need to fix the early continue bug (lines 56-59)
- Duplication of data (approver info in two places)

---

### Approach 2: Modify `getApprover` function (Code Fix)

**Code Fix in `set-trip-approvals.js`:**

```javascript
const getApprover = async ({ context, tripTypeId, locationId }) => {
  const { knex } = context;
  
  // Existing: get approvers from approver table
  const approvers = await Approver.query(knex)
    .alias('ap')
    .select({
      userId: 'ap.userId',
      userEmail: 'ap.userEmail',
      isPrimary: 'ap.isPrimary',
      approvalLevelId: 'ap.approvalLevelId',
      tripTypeId: 'ap.tripTypeId',
    })
    .joinRelated({ al: { $relation: 'approvalLevel' }, u: { $relation: 'ttUser' } })
    .where({ locationId, tripTypeId, 'ap.isPrimary': 1 });
  
  // NEW: Also get funding source approvers
  const fundingApprovers = await TripFunding.query(knex)
    .alias('tf')
    .select({
      userId: 'fs.approverId',
      approvalLevelId: knex.raw('?'),
      tripTypeId: 'tf.tripRequestId',
    })
    .joinRelated({ fs: { $relation: 'fundingSource' } })
    .where('fs.approverId', '>', 0)
    .andWhere('tf.tripRequestId', tripRequestId);
  
  return [...approvers, ...fundingApprovers];
};
```

**Pros:**
- No database changes needed
- More direct fix - brings funding approvers into the existing flow

**Cons:**
- Still need to fix the early continue bug
- Need to handle duplicate detection

---

### Must Fix: Early Continue Bug (Lines 56-59)

Both approaches need to fix this bug regardless:

**Current code (broken):**
```javascript
if (!criteriaList.length && !approverList.length) {
  await deleteTripsApproval({ context, tripRequestId: tr.tripRequestId });
  continue;  // <-- NEVER reaches saveFundingSourceApproval()!
}
```

**Fix Option A - Move funding source handling BEFORE check:**
```javascript
// handle funding source FIRST (before the empty check)
let fundingSourceApproval = [];
if (tr.hasFundingSource) {
  fundingSourceApproval = (await saveFundingSourceApproval({ context, tripRequest: tr })) || [];
}

// Now check - but consider funding source approvals
if (!criteriaList.length && !approverList.length && !fundingSourceApproval.length) {
  await deleteTripsApproval({ context, tripRequestId: tr.tripRequestId });
  continue;
}
```

**Fix Option B - Add special check for funding sources:**
```javascript
// Check if there are any funding sources with valid approvers
const hasFundingSourcesWithApprovers = tr.hasFundingSource && 
  (await saveFundingSourceApproval({ context, tripRequest: tr }));

if (!criteriaList.length && !approverList.length && !hasFundingSourcesWithApprovers) {
  await deleteTripsApproval({ context, tripRequestId: tr.tripRequestId });
  continue;
}
```

---

### Summary

| Issue | Fix | Location |
|-------|-----|----------|
| INNER JOIN excludes criteria | Insert into approver table OR modify getCriteria() | DB or code |
| Funding approvers not linked | Use approverId from funding_source | Code |
| Early continue skips funding | Move saveFundingSourceApproval() before check | Code (lines 56-59) |

**Location:** `TravelTracker/app/approval-level/set-trip-approvals.js` (line 270)

```javascript
.andWhere('fs.approverId', '>', 0);
```

**Scenario:** If a funding source is added to a trip request but the `funding_source` table record has `approverId = 0` or NULL, the approval entry will NOT be created.

**Database verification (ez_newportva):**
```sql
SELECT COUNT(*) FROM funding_source WHERE approverId = 0 OR approverId IS NULL;
-- Result: 26 funding sources with no approver

SELECT id, name FROM funding_source WHERE approverId = 0 LIMIT 5;
-- id  name
-- 10  Admin Building - CNI - Elementary
-- 92  Athletics - High School
-- 93  Athletics - Middle School
-- ...
```

**Flow:**
1. `hasFundingSource` will be `true` (funding exists in `trip_funding`)
2. `saveFundingSourceApproval()` is called
3. Query filters out funding sources where `approverId <= 0`
4. Returns empty array → no approval entry created

**Mitigation:** Ensure every funding source that should require approval has a valid `approverId` set in the `funding_source` table.

---

#### 3. Missing "Funding Source" criteria label

**Location:** `TravelTracker/app/approval-level/set-trip-approvals.js` (line 251)

```javascript
.where({ label: 'Funding Source' })
```

**Scenario:** If no `approval_level_criteria` record has `label = 'Funding Source'`, the `saveFundingSourceApproval()` function returns early without creating any funding source approvals.

**Mitigation:** Ensure the criteria table contains an entry with `label = 'Funding Source'` configured for the appropriate trip types and locations.

#### 4. Trip type / location mismatch

**Location:** `TravelTracker/app/approval-level/set-trip-approvals.js` (lines 128-156)

**Scenario:** The funding source criteria is filtered by `tripTypeId` and `locationId`. If the criteria is configured for a different trip type or location than the trip request, it won't be found or applied.

**Mitigation:** Verify that the "Funding Source" criteria is properly configured for all relevant trip types and locations in the `approval_level_criteria`, `approval_level_trip_type`, and `approver` tables.

#### 4. Funding source with null/empty name

**Location:** `TravelTracker/app/approval-level/approval-level-v2.js` (line 759)

**Scenario:** If a funding source record exists with a NULL `name`, this is caught as a validation error (`hasFundingSourceIssue`) but could prevent proper approval flow.

**Mitigation:** Ensure all funding sources have valid names populated in the `funding_source` table.

---

## Migration Status

### What's Migrated to Portage

- Trip request CRUD (create, view, edit, list, filters)
- Approval workflow (view, approve, deny, request changes)
- User management (CRUD, roles)
- Dashboard (summary counts, role-based widgets)
- Bidding system (admin + driver views)
- Settings (destinations, locations, funding sources, vehicle types, approval levels)
- Notifications
- Multi-tenant database resolution
- Session-based authentication

### What Remains in TravelTracker

- Yellowfin BI reporting integration
- Permission slip / trip estimate DOCX generation
- Trip ticket PDF generation
- LDAP/OneRoster roster synchronization (being migrated to Portage scheduler)
- Traversa import
- Complex invoice cost calculations with modifiers
- Scheduled notification system
- EZR bi-directional sync
- Legacy migration CSV import
- Client management (Super Admin)
- Real-time Socket.IO communication
- **Approval computation logic** (evaluates criteria, matches approvers, creates trip_approvals records)

### CSV Migration Notes (Legacy)

- In `TravelTracker/ddl/migrate.py`, `migrate_approvers()` inserts into `approver` with `id = NULL` (auto-increment).
- This means source CSV `approver.id` values are **not preserved** during migration.

### Migration Bridge

- `TravelTracker/app/apiv2/` proxies requests to Portage
- Portage `apps/api/src/legacy/` proxies back to TravelTracker for unmigrated endpoints
- Both systems share the same MySQL databases
- Frontend routes in TravelTracker redirect to Portage for migrated features

---

## Key Architectural Differences

| Aspect           | TravelTracker           | Portage                       |
| ---------------- | ----------------------- | ----------------------------- |
| Backend          | Express.js (JavaScript) | NestJS (TypeScript)           |
| ORM              | Objection.js + Knex     | Prisma                        |
| Frontend         | Vue 2 + Vuetify 2       | Nuxt 3 + Vue 3 + Tailwind     |
| State Management | Vuex                    | Pinia                         |
| Testing          | Gulp + Mocha / Cypress  | Jest / Vitest / Playwright    |
| Auth             | External auth service   | GDIC (being migrated)         |
| Real-Time        | Socket.IO + Redis       | TBD                           |
| Code Style       | CommonJS, globals       | ES modules, strict TypeScript |
| Error Handling   | `req.error` + `next()`  | Exception filters + Rollbar   |

---

## External Integrations

| Service                  | Used In                          | Purpose                        |
| ------------------------ | -------------------------------- | ------------------------------ |
| **GDIC**                 | Portage                          | External authentication        |
| **LDAP**                 | TravelTracker, Portage scheduler | User directory sync            |
| **OneRoster**            | TravelTracker, Portage scheduler | Student roster sync            |
| **Twilio**               | Both                             | SMS notifications              |
| **Mailgun / Nodemailer** | Both                             | Email delivery                 |
| **AWS S3**               | Both                             | File storage                   |
| **Rollbar**              | Both                             | Error tracking                 |
| **EZ Routing**           | TravelTracker                    | Trip data sync                 |
| **Yellowfin BI**         | TravelTracker                    | Embedded reporting             |
| **Google Maps**          | Both                             | Geocoding, Places autocomplete |
| **FindMySchool**         | TravelTracker                    | School boundary lookup         |

---

## Development Workflow

### Running Locally

```bash
# Start everything (Portage FE + BE)
npm run ezat

# Or individually:
cd Portage-backend && npm run start:dev   # NestJS watch mode
cd Portage-frontend && npm run dev        # Nuxt dev server (localhost:3001)

# Legacy stack:
cd TravelTracker && npm run start         # PM2 backend + Vue FE watch
```

### Linting & Formatting

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

### Database Migrations

```bash
# TravelTracker (Knex — per-client)
cd TravelTracker && npm run db:migration              # All clients
cd TravelTracker && npm run db:migration -- client=saraland  # Specific client
cd TravelTracker && npm run db:migration:rollback

# Portage Backend (Prisma — query layer only, Knex still manages schema)
cd Portage-backend && npx prisma generate             # Regenerate client
cd Portage-backend && npx prisma db pull              # Introspect schema changes
```

### Running Tests

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

## Environment Variables

### Portage Backend (`.env`)

```bash
BACKEND_PORT=8000
DATABASE_URL_ADMIN=mysql://user:pass@host/travel_tracker_trips
DATABASE_URL_CLIENT=mysql://user:pass@host/ez_colbert
DATABASE_PREFIX=
REDIS_HOST=localhost
REDIS_PORT=6379
KAFKA_BROKERS=localhost:9092
SKIP_MICROSERVICES=
GDIC_URL=
GDIC_TOKEN=
MAIL_DRIVER=smtp
MAIL_HOST=
MAIL_PORT=
MAIL_USERNAME=
MAIL_PASSWORD=
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_S3_BUCKET=travel.tracker
TWILIO_MODE=LIVE
ROLLBAR=
LEGACY_URL=                    # TravelTracker backend URL
FRONTEND_URL=http://ezat-local.transact.com
COOKIE_PREFIX=
COOKIE_DOMAIN=transact.com
```

### Portage Frontend (`.env`)

```bash
ENVIRONMENT=local
NUXT_PUBLIC_API_BASE=http://ezat-local.transact.com:8000
DEV_HOST=ezat-local.transact.com
DEV_PORT=3000
LEGACY_URL=http://ezat-local.transact.com
GOOGLE_MAPS_API_KEY=
```

### TravelTracker (`config.json`)

```json
{
  "server": { "port": 8081 },
  "database": {
    "server": "127.0.0.1",
    "user": "root",
    "password": "",
    "prefix": "ez_",
    "database": "travel_tracker_trips"
  },
  "domain": "traveltrackertrips.transact.com:8081",
  "cookie": { "prefix": "ttlocal_", "domain": "transact.com" },
  "auth": { "url": "", "token": "" },
  "redis": { "host": "127.0.0.1", "port": 6379 },
  "aws": { "accessKeyId": "", "secretAccessKey": "", "s3Bucket": "travel.tracker" },
  "messaging": { "twilioSid": "", "twilioToken": "", "twilioPhone": "" },
  "newBackend": { "url": "http://ezat-local.transact.com:8000" },
  "newFrontend": { "url": "http://ezat-local.transact.com:3001" }
}
```

---

## Code Examples

### Portage Backend — Creating a NestJS Module

**1. Generate the module:**

```bash
nest g module apps/api/src/my-feature
nest g controller apps/api/src/my-feature
nest g service apps/api/src/my-feature
```

**2. Controller with permissions and Swagger (real pattern from trip-request.controller.ts):**

```typescript
// apps/api/src/my-feature/my-feature.controller.ts
import { Controller, Post, Body, Req, Delete, Param } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Request } from 'express';
import { Permission } from '../common/decorator/auth.decorator';
import { RefFeature, RefPermission } from '@app/common/types';
import { MyFeatureService } from './my-feature.service';
import { CreateMyFeatureDto } from './dto/create-my-feature.dto';
import { GetListMyFeatureDto } from './dto/get-list-my-feature.dto';
import { Response200 } from '@app/response-codes';

@ApiTags('My Feature')
@Controller('my-feature')
export class MyFeatureController {
  constructor(private readonly service: MyFeatureService) {}

  @Post()
  @Permission({ feature: RefFeature.MY_FEATURE, type: RefPermission.ADD })
  @ApiOperation({ summary: 'Create a new record' })
  async create(@Body() dto: CreateMyFeatureDto, @Req() req: Request) {
    const result = await this.service.create(req.context, dto);
    return Response200.asApiResponse(result);
  }

  @Post('list/get')
  @Permission({ feature: RefFeature.MY_FEATURE, type: RefPermission.VIEW })
  @ApiOperation({ summary: 'List records with pagination' })
  async list(@Body() dto: GetListMyFeatureDto, @Req() req: Request) {
    const result = await this.service.getList(req.context, dto);
    return Response200.asApiResponse(result);
  }

  @Post('get/:id')
  @Permission({ feature: RefFeature.MY_FEATURE, type: RefPermission.VIEW })
  async findOne(@Param('id') id: number, @Req() req: Request) {
    const result = await this.service.findOne(req.context, id);
    return Response200.asApiResponse(result);
  }

  @Post('update')
  @Permission({ feature: RefFeature.MY_FEATURE, type: RefPermission.EDIT })
  async update(@Body() dto: UpdateMyFeatureDto, @Req() req: Request) {
    const result = await this.service.update(req.context, dto);
    return Response200.asApiResponse(result);
  }

  @Delete(':id')
  @Permission({ feature: RefFeature.MY_FEATURE, type: RefPermission.DELETE })
  async remove(@Param('id') id: number, @Req() req: Request) {
    await this.service.remove(req.context, id);
    return Response200.asApiResponse(null);
  }
}
```

**3. Service with Prisma and context (real pattern from trip-request.service.ts):**

```typescript
// apps/api/src/my-feature/my-feature.service.ts
import { Injectable } from '@nestjs/common';
import { TtContext } from '@app/common';
import { CreateMyFeatureDto } from './dto/create-my-feature.dto';
import { GetListMyFeatureDto } from './dto/get-list-my-feature.dto';

@Injectable()
export class MyFeatureService {
  async create(ctx: TtContext, dto: CreateMyFeatureDto) {
    return ctx.prisma.my_feature.create({
      data: {
        ...dto,
        created: Math.floor(Date.now() / 1000),
      },
    });
  }

  async getList(ctx: TtContext, dto: GetListMyFeatureDto) {
    const { skip, take, sortList, filters } = dto;

    const where = this.buildWhere(filters);
    const orderBy = this.buildOrderBy(sortList);

    const [records, totalCount] = await Promise.all([
      ctx.prisma.my_feature.findMany({
        where,
        orderBy,
        skip,
        take,
      }),
      ctx.prisma.my_feature.count({ where }),
    ]);

    return { records, totalCount };
  }

  async findOne(ctx: TtContext, id: number) {
    return ctx.prisma.my_feature.findUnique({
      where: { id },
      include: { relations: true },
    });
  }

  async update(ctx: TtContext, dto: UpdateMyFeatureDto) {
    const { id, ...data } = dto;
    return ctx.prisma.my_feature.update({
      where: { id },
      data: { ...data },
    });
  }

  async remove(ctx: TtContext, id: number) {
    return ctx.prisma.my_feature.delete({ where: { id } });
  }

  private buildWhere(filters: Record<string, any>) {
    const where: any = {};
    for (const [field, value] of Object.entries(filters)) {
      if (value) {
        where[field] = { contains: value };
      }
    }
    return where;
  }

  private buildOrderBy(sortList: { field: string; direction: string }[]) {
    if (!sortList?.length) return { created: 'desc' };
    return sortList.reduce(
      (acc, s) => ({
        ...acc,
        [s.field]: s.direction === 'desc' ? 'desc' : 'asc',
      }),
      {}
    );
  }
}
```

**4. DTO with validation (real pattern from create-trip-request.dto.ts):**

```typescript
// apps/api/src/my-feature/dto/create-my-feature.dto.ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsInt, Min, IsBoolean, IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateMyFeatureDto {
  @ApiProperty()
  @IsString()
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty()
  @IsInt()
  @Min(1)
  location_id: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}

export class GetListMyFeatureDto {
  @ApiProperty({ default: 0 })
  @IsInt()
  @Min(0)
  skip: number;

  @ApiProperty({ default: 20 })
  @IsInt()
  @Min(1)
  take: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  sortList?: { field: string; direction: string }[];

  @ApiPropertyOptional()
  @IsOptional()
  filters?: Record<string, any>;
}
```

**5. Register in api.module.ts:**

```typescript
import { MyFeatureModule } from './my-feature/my-feature.module';

@Module({
  imports: [
    // ... existing modules
    MyFeatureModule,
  ],
})
export class ApiModule {}
```

---

### Portage Backend — Emitting a Domain Event

**Define the event class:**

```typescript
// apps/api/src/event-handler/my-feature/my-feature-create.event.ts
import { TtContext } from '@app/common';
import { my_feature } from '@app/client';

export class MyFeatureCreateEvent {
  constructor(
    public ttContext: TtContext,
    public newValue: my_feature
  ) {}
}
```

**Emit from a service:**

```typescript
import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { TtContext } from '@app/common';
import { TtEventType } from '../event-handler/event.type';
import { MyFeatureCreateEvent } from '../event-handler/my-feature/my-feature-create.event';

@Injectable()
export class MyFeatureService {
  constructor(private eventEmitter: EventEmitter2) {}

  async create(ctx: TtContext, dto: CreateMyFeatureDto) {
    const record = await ctx.prisma.my_feature.create({
      data: { ...dto, created: Math.floor(Date.now() / 1000) },
    });

    this.eventEmitter.emit(TtEventType.MY_FEATURE_CREATE, new MyFeatureCreateEvent(ctx, record));

    return record;
  }
}
```

**Handle the event:**

```typescript
// apps/api/src/event-handler/my-feature/my-feature-handler.service.ts
import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { TtEventType } from '../event.type';
import { MyFeatureCreateEvent } from './my-feature-create.event';

@Injectable()
export class MyFeatureHandlerService {
  @OnEvent(TtEventType.MY_FEATURE_CREATE)
  async handleCreate(event: MyFeatureCreateEvent) {
    const { ttContext, newValue } = event;
    // Send notification, update audit log, sync to other systems, etc.
  }

  @OnEvent(TtEventType.MY_FEATURE_UPDATE)
  async handleUpdate(event: MyFeatureUpdateEvent) {
    const { ttContext, newValue, oldValue } = event;
    // Log field-level changes, trigger downstream updates
  }
}
```

---

### Portage Backend — Using Kafka to Queue a Job

**API app — producer (using KafkaApiService):**

```typescript
import { Injectable } from '@nestjs/common';
import { KafkaApiService, QueueEventTopic } from '@app/kafka';
import { TtContext } from '@app/common';

@Injectable()
export class NotificationService {
  constructor(private kafka: KafkaApiService) {}

  async queueEmail(ctx: TtContext, to: string, subject: string, body: string) {
    await this.kafka.send(QueueEventTopic.SEND_EMAIL, {
      clientId: ctx.client,
      to,
      subject,
      body,
    });
  }

  async queueSms(ctx: TtContext, phone: string, message: string) {
    await this.kafka.send(QueueEventTopic.SEND_SMS, {
      clientId: ctx.client,
      phone,
      message,
    });
  }
}
```

**Queue app — consumer (using Bull + Kafka):**

```typescript
import { Process, Processor } from '@nestjs/bull';
import { Job } from 'bull';
import { Injectable } from '@nestjs/common';

@Processor('email-queue')
@Injectable()
export class EmailConsumer {
  @Process('send-email')
  async handleSendEmail(job: Job) {
    const { clientId, to, subject, body } = job.data;
    // Process the email send
  }
}
```

---

### Portage Frontend — Creating a Page

**Real pattern from `pages/[client]/trip-requests/index.vue`:**

```vue
<!-- pages/[client]/my-feature/index.vue -->
<script setup lang="ts">
import { defineAsyncComponent } from 'vue';

const MyFeatureList = defineAsyncComponent(() => import('../../../modules/my-feature/MyFeatureList.vue'));
</script>

<template>
  <MyFeatureList />
</template>
```

**Real pattern from `pages/[client]/trip-requests/[id].vue`:**

```vue
<!-- pages/[client]/my-feature/[id].vue -->
<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router';
import { defineAsyncComponent } from 'vue';

const MyFeatureViewEdit = defineAsyncComponent(() => import('../../../modules/my-feature/MyFeatureViewEdit.vue'));

const route = useRoute();
const router = useRouter();

const id = computed(() => {
  const param = route.params.id;
  return Array.isArray(param) ? Number(param[0]) : Number(param);
});

const goBack = () => {
  router.push(`/${route.params.client}/my-feature`);
};
</script>

<template>
  <MyFeatureViewEdit :id="id" @goBack="goBack" />
</template>
```

---

### Portage Frontend — Creating a Pinia Store

**Real pattern from `stores/trips/tripRequest.ts` and `stores/trips/tripApproval.ts`:**

```typescript
// stores/my-feature.ts
import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { MyFeatureRecord } from '~/utils/types';

export const useMyFeatureStore = defineStore('myFeature', () => {
  const items = ref<MyFeatureRecord[]>([]);
  const loading = ref(false);
  const totalCount = ref(0);
  const currentItem = ref<MyFeatureRecord | null>(null);

  async function fetchList(params = {}) {
    loading.value = true;
    const { data, error } = await useFetchApi('/api/v2/my-feature/list/get', {
      method: 'POST',
      body: { skip: 0, take: 20, sortList: [], filters: {}, ...params },
    });
    loading.value = false;

    if (data.value) {
      items.value = data.value.records;
      totalCount.value = data.value.totalCount;
    }
  }

  async function fetchOne(id: number) {
    const { data } = await useFetchApi(`/api/v2/my-feature/get/${id}`, {
      method: 'POST',
    });
    if (data.value) {
      currentItem.value = data.value;
    }
    return { data, error };
  }

  async function createItem(dto: CreateMyFeatureDto) {
    const { data, error } = await useFetchApi('/api/v2/my-feature', {
      method: 'POST',
      body: dto,
    });
    if (data.value) {
      await fetchList();
    }
    return { data, error };
  }

  async function updateItem(dto: UpdateMyFeatureDto) {
    const { data, error } = await useFetchApi('/api/v2/my-feature/update', {
      method: 'POST',
      body: dto,
    });
    if (data.value) {
      await fetchList();
    }
    return { data, error };
  }

  async function deleteItem(id: number) {
    const { data, error } = await useFetchApi(`/api/v2/my-feature/${id}`, {
      method: 'DELETE',
    });
    if (data.value) {
      await fetchList();
    }
    return { data, error };
  }

  function resetState() {
    items.value = [];
    currentItem.value = null;
    totalCount.value = 0;
  }

  return {
    items,
    loading,
    totalCount,
    currentItem,
    fetchList,
    fetchOne,
    createItem,
    updateItem,
    deleteItem,
    resetState,
  };
});
```

---

### Portage Frontend — API Call Patterns

**Real patterns from `useFetchApi.ts`:**

```typescript
// List with filters
const { data, pending, refresh } = useFetchApi('/api/v2/my-feature/list/get', {
  method: 'POST',
  body: {
    skip: 0,
    take: 50,
    sortList: [{ field: 'name', direction: 'asc' }],
    filters: { name: 'test' },
  },
});

// Create
const { data, error } = await useFetchApi('/api/v2/my-feature', {
  method: 'POST',
  body: { name: 'Test', location_id: 1 },
});

// Update
const { data, error } = await useFetchApi('/api/v2/my-feature/update', {
  method: 'POST',
  body: { id: 123, name: 'Updated Name' },
});

// Delete
const { data, error } = await useFetchApi('/api/v2/my-feature/123', {
  method: 'DELETE',
});

// Blob download (PDF, CSV, etc.)
const { data, contentDisposition } = await useFetchApi(
  '/api/v2/my-feature/export',
  { method: 'POST', body: { filters: {} } },
  { responseType: 'blob' }
);
// data is a Blob, contentDisposition has the filename

// Note: useFetchApi returns unwrapped data:
// return { data: data.value?.data, pending, error, refresh, userError, cancel }
// So data.value is already one level deep from the API response
```

---

### Portage Frontend — Using the Exit Prompt

**Real pattern from `stores/ui/exitPrompt.ts` and `03-trip-create-exit-prompt.global.ts`:**

```typescript
// In a page component — wire up the dialog
<script setup lang="ts">
import { useExitPromptStore } from '~/stores/ui/exitPrompt';

const exitPromptStore = useExitPromptStore();
const { showDialog } = storeToRefs(exitPromptStore);

function onConfirmExit() {
  exitPromptStore.resolveDialog(true);
}
function onCancelExit() {
  exitPromptStore.resolveDialog(false);
}
</script>

<template>
  <!-- Your page content -->
  <DialogModal v-model:visible="showDialog">
    <template #header>Leave Page</template>
    <div><p>Are you sure you want to leave?</p></div>
    <template #footer>
      <ButtonSecondary class="mr-2" @click="onCancelExit()">Stay</ButtonSecondary>
      <ButtonPrimary @click="onConfirmExit()">Leave</ButtonPrimary>
    </template>
  </DialogModal>
</template>
```

```typescript
// In middleware — check for unsaved changes
export default defineNuxtRouteMiddleware(async (to, from) => {
  if (from.path.includes('my-feature/create') && to.path !== from.path) {
    const exitPromptStore = useExitPromptStore();
    const shouldExit = await exitPromptStore.showExitPrompt();
    if (!shouldExit) return navigateTo(from.path);
  }
});
```

---

### TravelTracker — Understanding the Module Pattern

**Real pattern from TravelTracker's Express modules:**

```javascript
// app/my-feature/api.js
const { midware } = global;
const myFeatureService = require('./service');

module.exports = function (app) {
  app.get('/api/my-feature', midware('view|myfeature'), async (req, res, next) => {
    try {
      const result = await myFeatureService.list(req);
      req.response = result;
      next();
    } catch (err) {
      req.error = err;
      next();
    }
  });

  app.post('/api/my-feature', midware('add|myfeature'), async (req, res, next) => {
    try {
      const result = await myFeatureService.save(req);
      req.response = result;
      next();
    } catch (err) {
      req.error = err;
      next();
    }
  });
};
```

---

### TravelTracker — Objection.js Model Pattern

**Real pattern from TravelTracker's models:**

```javascript
// app/model/my-feature.model.js
const { Model } = require('objection');
const AuditBaseModel = require('./audit-base.model');

class MyFeature extends AuditBaseModel {
  static get tableName() {
    return 'my_feature';
  }

  static get relationMappings() {
    const Related = require('./related.model');

    return {
      related: {
        relation: Model.HasManyRelation,
        modelClass: Related,
        join: {
          from: 'my_feature.id',
          to: 'related.my_feature_id',
        },
      },
    };
  }

  static get modifiers() {
    return {
      filterByStatus(query, status) {
        if (status) query.where('status', status);
      },
      withRelations(query) {
        query.withGraphFetched('[related]');
      },
    };
  }
}

module.exports = MyFeature;
```

---

## Useful Patterns

### Adding a New Feature Module (Portage Backend)

1. Generate module: `nest g module apps/api/src/your-feature`
2. Create DTOs in `dto/` with `class-validator` decorators
3. Add Swagger decorators (`@ApiOperation`, `@ApiResponse`, `@ApiTags`)
4. Use `@Permission({ feature: RefFeature.X, type: RefPermission.Y })` for access control
5. Use `@Public()` if no auth needed
6. Access context via `req.context` (typed as `TtContext` on Express Request)
7. Add to `api.module.ts` imports
8. Add event types to `TtEventType` enum if emitting events
9. Write integration test in `test/integration/`

### Adding a New Page (Portage Frontend)

1. Create page in `pages/[client]/your-feature/index.vue` using `defineAsyncComponent`
2. Create feature module in `modules/your-feature/`
3. Create Pinia store in `stores/your-feature/` (composition API style)
4. Use `useFetchApi` for API calls — returns `{ data, pending, error, refresh, userError, cancel }`
5. Add route middleware if auth/permission needed
6. Write Playwright test in `test/`

### Calling the API from Frontend

```typescript
const { data, pending, refresh } = useFetchApi('/api/v2/trip-request/list/get', {
  method: 'POST',
  body: { skip: 0, take: 20, sortList: [], filters: {}, include: {} },
});
```

### Emitting a Domain Event (Portage Backend)

```typescript
this.eventEmitter.emit(TtEventType.TRIP_REQUEST_CREATE, new TripRequestCreateEvent(ctx, trip));
```

---

## Troubleshooting

| Issue                                                     | Solution                                                                                                                                                                                                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Prisma client not found                                   | Run `npx prisma generate` in `Portage-backend/`                                                                                                                                                                                                        |
| Kafka connection errors                                   | Set `SKIP_MICROSERVICES=` in `.env` for local dev                                                                                                                                                                                                      |
| Session not persisting                                    | Verify Redis is running and `REDIS_HOST`/`REDIS_PORT` are correct                                                                                                                                                                                      |
| Client database not found                                 | Check `client-database` header matches a client in the admin DB                                                                                                                                                                                        |
| Portage FE can't reach BE                                 | Verify `NUXT_PUBLIC_API_BASE` matches backend URL                                                                                                                                                                                                      |
| TravelTracker config not loading                          | Ensure `config.json` exists (copy from `config.template.json`)                                                                                                                                                                                         |
| Migration fails on specific client                        | Run with `client=<name>` flag to target one database                                                                                                                                                                                                   |
| `req.context` is undefined                                | Ensure `ClientMiddleware` is registered and request has `client-database` header                                                                                                                                                                       |
| `useFetchApi` returns `data.value` as undefined           | Check that the API response has the `{ statusCode, message, data }` shape — `useFetchApi` unwraps one level                                                                                                                                            |
| Trip Approval tab shows no approvers for a submitted trip | Check `trip_approvals` rows first. Approval computation happens in the legacy TravelTracker backend, which filters trips by leave date; past-date trips may not have computed approval rows. Use the "Refresh" button in Portage to trigger recompute. |

### Approval Troubleshooting Checklist (Legacy Backend / Portage UI)

Use this when a trip should have approvers (for example Funding Source) but Approval tab is empty/missing expected users.

1. **Confirm trip is submitted**
   - `trip_request.status` should be `1` (submitted).

2. **Check computed approval rows exist**
   - Query `trip_approvals` for `tripRequestId`.
   - If `0` rows, Portage Approval tab has nothing to render.

3. **Trigger approval recompute**
   - In Portage UI, click the "Refresh" button on the trip to call `refreshTripApprovalLevel()`.
   - Or use `POST /trip-request-approval/reset-approval` then re-submit the trip.

4. **Verify trip date**
   - The legacy backend may filter trips by leave date (`leaveDate >= DATE(NOW())`).
   - Check `trip_request_leave_return.leaveDate` against current date.

5. **Validate Funding Source approver mapping (if applicable)**
   - `trip_funding` contains funding sources for the trip.
   - `funding_source.approverId` is populated.
   - `tt_user` record exists for that approver (email/displayName).

6. **Check criteria/config for Funding Source level**
   - `approval_level_criteria.label = 'Funding Source'` exists.
   - Confirm level is mapped to the trip type (`approval_level_trip_type`).

7. **Check non-funding approvers (location/trip type)**
   - `approver` table has primary approver rows for `locationId + tripTypeId`.
   - The `approver.isPrimary` flag must be `1` for the approver to appear.

8. **Check LegacyService connectivity**
   - Portage BE proxies to legacy via `LEGACY_URL` environment variable.
   - Verify the legacy backend is accessible from Portage.

---

## Common Developer Tasks

### Adding a new API endpoint (Portage Backend)

1. Create module: `nest g module apps/api/src/my-feature`
2. Create controller, service, DTOs
3. Register in `api.module.ts`
4. Add permissions via `@Permission()` decorator

### Adding a new field to Trip Request

1. Add to `client.prisma` schema (run `prisma generate` after)
2. Add to `CreateTripRequestDto` and `UpdateTripRequestDto`
3. Add to `TripRequestTransformer` for response mapping
4. Add validation rules if needed
5. Update frontend form component

### Adding a new approval level

1. Insert into `approval_level` table
2. Link to trip types in `approval_level_trip_type`
3. Add criteria in `approval_level_criteria` (optional)
4. Assign approvers in `approver` table for specific locations/trip types

### Debugging a failing test

```bash
# Portage Backend unit test
npx jest path/to/file.spec.ts --verbose

# Portage Backend integration test
npx jest --config test/integration/utils/jest-config.js -- test/integration/trips.spec.js --verbose

# Portage Frontend unit test
npx vitest run path/to/file.spec.ts
```

### Working with the legacy database

```bash
# Connect to a client's database
mysql -h 127.0.0.1 -u root -p ez_colbert

# Check approval status for a trip
SELECT * FROM trip_approvals WHERE tripRequestId = 123;

# Check audit log
SELECT * FROM tt_audit WHERE recordType = 301 AND recordId = 123 ORDER BY created DESC;
```

---

## Related Projects

| Project                  | Path            | Description                                                        |
| ------------------------ | --------------- | ------------------------------------------------------------------ |
| **EZ Routing**           | `Routing/`      | Route planning and logistics platform (syncs with TravelTracker)   |
| **EZAT Backend (older)** | `EZAT-Backend/` | Older version of EZ Activity Trips backend (superseded by Portage) |
