# Key Concepts

## Authentication {#wiki-portage-backend-key-concepts-authentication}

- **Session-based** (not JWT) — `express-session` with Redis store
- External auth via **GDIC** (Global Digital Identity Center)
- `AuthGuard` checks: `@Public()` routes → session user → `@Permission()` feature access
- Environment-specific session timeout: 60 min (dev) / 15 min (prod)

---

## Event-Driven Architecture {#wiki-portage-backend-key-concepts-event-driven-architecture}

- Internal: NestJS `EventEmitter` for domain events (TRIP_REQUEST_CREATE, ASSIGNMENT_DELETE, etc.)
- External: Kafka for inter-app communication (API ↔ Queue)
- Topics: `queue.sms.email`, `queue.check.health.event`, health check topics
- Custom event classes (e.g., `TripRequestCreateEvent`) wrap `TtContext` + payload

---

## Multi-Tenant Database Pattern {#wiki-portage-backend-key-concepts-multi-tenant-database-pattern}

- Each client (school district) has its **own MySQL database**: `ez_<clientname>`
- A shared **admin database** holds client registry and system-wide data
- `ClientMiddleware` reads the `client-database` header on every request
- `ClientService` maintains a **connection cache** (`Map<string, PrismaClient>`) keyed by client name
- Connections are dynamically constructed: `base_url + prefix + client_name`

---

## Permission System {#wiki-portage-backend-key-concepts-permission-system}

- Role-based with many role types (Super Admin → Funding Manager)
- Features: ADMIN, USER, TRIP_REQUEST, INVOICE, VEHICLE, etc.
- Sub-features for granular access (TRIPS_GENERAL, INVOICE_STAFF_COST, etc.)
- Permission types: VIEW, ADD, EDIT, DELETE, APPROVE, CONFIG, etc.
- Field-level permissions for trip request forms (pending/approved/assigned states)
- Decorator usage: `@Permission({ feature: RefFeature.TRIP_REQUEST, type: RefPermission.VIEW })`

---

## Request Context (`TtContext`) {#wiki-portage-backend-key-concepts-request-context-ttcontext}

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

---

## API Integration Layer {#wiki-portage-frontend-key-concepts-api-integration-layer}

`useFetchApi` helper wraps Nuxt's `useFetch`:

- Base URL from `runtimeConfig.public.apiBase`
- Auto-attaches `client` header from auth store
- `credentials: 'include'` for cookie-based auth
- Blob download support with `Content-Disposition` parsing
- Automatic error toasts for 400, 403, 404, 500 (skippable with `skipToast`)
- AbortController for request cancellation
- Returns `{ data: data.value?.data, pending, error, refresh, userError, cancel }` — note `data` is unwrapped one level

---

## Feature Module Pattern {#wiki-portage-frontend-key-concepts-feature-module-pattern}

- `modules/` is the heart of the app — organized by domain
- Pages are thin shells that delegate to feature modules via `defineAsyncComponent`
- Components use `<script setup lang="ts">` throughout

---

## Multi-Tenant Routing {#wiki-portage-frontend-key-concepts-multi-tenant-routing}

- All routes scoped under `/:client/` — client slug from URL validated against backend
- `client` header sent with every API request
- Sign-out redirects to legacy app

---

## State Management (Pinia) {#wiki-portage-frontend-key-concepts-state-management-pinia}

**Pinia stores organized by domain:**

| Domain   | Stores                                                                                                                    | Purpose                                      |
| -------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Core     | `auth`, `config`, `dashboard`, `geo`, `notifications`                                                                     | Session, permissions, client config, widgets |
| Trips    | `tripRequest`, `list`, `tripApproval`, `tripType`, `tripEvent`, `batch`                                                   | Multi-step form, list, approvals             |
| Bids     | `forms`, `calendar`, `summary`, `assignment`, `driver`, `config`                                                          | Bidding periods, driver view, calendar       |
| Settings | `users`, `destination`, `location`, `fundingSource`, `vehicleType`, `roster`, `approvalLevel`, `additionalTransportation` | Reference data management                    |
| UI       | `exitPrompt`                                                                                                              | Promise-based navigation guard               |

**Caching pattern:** Manual time-based caching (5-10 min) for reference data using module-scope variables.

---

## UI Library {#wiki-portage-frontend-key-concepts-ui-library}

| Library                | Purpose                                                         |
| ---------------------- | --------------------------------------------------------------- |
| **PrimeVue** (v3.53)   | UI components with `P` prefix (`PButton`, `PDataTable`, etc.)   |
| **Tailwind CSS**       | Custom brand colors, numeric font sizes, responsive breakpoints |
| **Vuelidate**          | Form validation                                                 |
| **Google Maps JS API** | Places autocomplete, geocoding                                  |

**Component auto-import:** Components registered with `pathPrefix: false` — `<ButtonPrimary>` works directly, no prefix needed.

---

## API Structure {#wiki-traveltracker-legacy-key-concepts-api-structure}

- Route pattern: `app.get('/api/{resource}', midware('action|model'), handler)`
- Permission middleware: `midware('view|triprequest')`, `midware('add|invoice')`, etc.
- Response pattern: Controllers set `req.error` or `req.response`, call `next()`, final middleware handles formatting
- **API v2 proxy** (`app/apiv2/`) forwards certain requests to Portage backend

---

## Global State Pattern {#wiki-traveltracker-legacy-key-concepts-global-state-pattern}

- `global.configuration` — Loaded from `config.json` at startup, mutated at runtime
- `global.midware` — Permission middleware factory: `midware('action|model')`
- `global.appModules` — Feature flag configuration
- All modules rely on these globals

---

## Multi-Tenancy {#wiki-traveltracker-legacy-key-concepts-multi-tenancy}

- Per-client databases: `ez_<clientname>`
- Central `travel_tracker_trips` DB holds client registry
- Knex connections cached per-client in a Map
- Hot-reload via `/api/init/:name` (localhost only)

---

## Objection.js Models {#wiki-traveltracker-legacy-key-concepts-objection-js-models}

- Many models with extensive relations (`HasManyRelation`, `ManyToManyRelation` with `through`)
- `AuditBaseModel` — Auto-logs to `tt_audit` via lifecycle hooks
- Heavy use of **static modifiers** for complex queries
- View models: `VwAllDrivers`, `VwAllLocations`, `VwAllVehicles`, `VwAllotments`, `VwSemesterFiscalYearMap`

---

## Real-Time Communication {#wiki-traveltracker-legacy-key-concepts-real-time-communication}

- Socket.IO with Redis adapter for multi-node support
- Events: `login`, `disconnect`, `broadcast`, `server-started`
- Redis pub/sub for cross-node messaging

---

## Record Types (Code-Defined, Not in Database) {#wiki-traveltracker-legacy-key-concepts-record-types-code-defined-not-in-database}

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

---

## Scheduled Jobs {#wiki-traveltracker-legacy-key-concepts-scheduled-jobs}

- Single `setInterval(1000ms)` loop checking time-based triggers
- Runs at specific times: 3 AM (sync, cleanup), 8 AM (notifications), 11 AM (user emails), 6:35 PM (assignment notifications)
- Redis distributed locks prevent duplicate execution

---

