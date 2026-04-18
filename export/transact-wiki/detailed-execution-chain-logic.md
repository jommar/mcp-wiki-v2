# Detailed Execution Chain & Logic

## Data Mapping Strategy {#wiki-migrations-detailed-execution-chain-logic-data-mapping-strategy}

- **Reference Resolution**: Most legacy IDs are resolved using `toById` or `toByName` maps created from companion CSV files (e.g., `tt_user.csv`, `fiscal_year.csv`).
- **Missing Coordinates**: Records missing geodata are assigned the **Prime Meridian** default:
  - Lat: `51.4769`, Lng: `0.0005`
  - Post-migration Node/SQL tasks attempt to fix these via re-geocoding.

---

## Python Utilities (`migrate.py`) {#wiki-migrations-detailed-execution-chain-logic-python-utilities-migrate-py}

The Python script employs several normalization and mapping utilities to handle legacy data inconsistencies:

| Function | Logic | Purpose |
|---|---|---|
| `get_24h_time(time_str)` | Regex/strptime: `%I:%M:%S %p` or `%I:%M %p` | Normalizes 12h AM/PM strings to 24h `HH:MM`. |
| `to_phone_no(val)` | Strips non-digits; enforces 10-digit length | Standardizes phone numbers; defaults to `5555555555`. |
| `get_date(date_str)` | `%m/%d/%Y` -> `%Y-%m-%d` | Normalizes date formats for MySQL. |
| `bulk_insert` | Chunks records (1000) with error fallback | Attempts strict insert; fallbacks to individual `INSERT IGNORE` on failure. |

---

## Stage 1: Validation & Preparation {#wiki-migrations-detailed-execution-chain-logic-stage-1-validation-preparation}

**Triggered by:** `analyzeLegacyMigrationCSV(req)` in `app/admin/index.js`

1.  **`findMigrationFolder(client)`**:
    *   Calls `ddl/copy.sh` to pull CSVs from the source server to the local `ddl/ez_[client]` directory.
2.  **`validator.run({ dir, client })`** (in `legacy-migration-csv-validator.js`):
    *   **Logic**: Iterates through each CSV, checking against a strict schema.
    *   **Key Checks**: `FK_NOT_FOUND` (checks if IDs in `trip_request.csv` exist in `tt_user.csv`), `DATE_FORMAT`, and `REQUIRED_FIELD`.
3.  **`counter.run({ dir })`** (in `legacy-migration-csv-counter.js`):
    *   Provides raw row counts for the UI and initial reconciliation.

---

## Stage 2: Pre-Migration Repairs {#wiki-migrations-detailed-execution-chain-logic-stage-2-pre-migration-repairs}

**Triggered by:** `runLegacyMigration(req)` -> `runPreMigrationChecks()`

1.  **`legacyFixCsvIssues({ context })`** (in `legacy-fix-csv-issues.js`):
    *   **`handlers.trip_request`**: Fixes malformed quotes that break CSV parsers.
    *   **`handlers.trip_event`**: Splits semicolon-delimited `tripTypeId` values into separate rows.
2.  **`legacyTtUserEmailFix({ dir })`** (in `legacy-user-email-csv-check.js`):
    *   Ensures consistent casing and format for user emails in the CSVs to prevent join failures during migration.

---

## Stage 3: Core Python Migration {#wiki-migrations-detailed-execution-chain-logic-stage-3-core-python-migration}

**Triggered by:** `execSync('sh ./ddl/migrate.sh ...')`

1.  **`migrate.sh`**:
    *   Wrapper that passes database credentials and the client-specific path to the Python environment.
    *   Usage: `sh ./ddl/migrate.sh ddl/ez_<client> <routing_bool> ez_<client> <dbUser> <dbPass> <dbHost>`
2.  **`migrate.py`** — Table migration order (strict dependency chain):
    1.  **Semester** — Resets and seeds `2025 ~ 2026` / `2026 ~ 2027` (non-routing clients)
    2.  **Stop / Stopextra** — Built from address + trip_request_stop CSVs
    3.  **VehicleType** — Migrated from CSV
    4.  **Vehicle / tt_vehicle** — With semester and stop linkage
    5.  **Staff / tt_staff** — With location, vehicle, fiscal year linkage
    6.  **Location / School** — Loaded, then removed from csv_dict
    7.  **Destination** — Migrated, then dict refreshed from DB
    8.  **Address** — Bulk migration with trip_request_stop cross-reference
    9.  **Budget Code** — Simple insert
    10. **Funding Source** — With approver email → tt_user linkage
    11. **Staff / tt_staff** — Second pass
    12. **Approver** — With location and trip type linkage
    13. **tt_user_role** — Site level authorities
    14. **Trip Request Stop** — Trip-level stops
    15. **Trip Request** — Core trip data with full foreign key resolution
    16. **Assignment** — Linked to trip_request, staff, vehicles
    17. **Driver Log** — Updated from assignment data
    18. **Remaining tables** — All non-skip tables via generic `migrate_table()`
    19. **Trip Funding** — Migrated after trip_request exists
    20. **Trip Approvals** — With user email resolution
    21. **Invoices** — Migrated last (after all dependencies: assignment, trip_request, staff, etc.)
    22. **Config** — Final tt_config update with trip events, approval levels, vehicle types, roles
3.  **`migrate.py`** — Key mechanisms:
    *   **`toById()` / `toByName()`**: Loads companion CSVs (Users, Fiscal Years, etc.) into memory-efficient hash maps.
    *   **`bulk_insert(cursor, sql, rows)`**: The primary engine. It tries a strict batch insert first; if it fails, it retries with `INSERT IGNORE` on individual records to isolate bad data.
    *   **`trip_request_event` handling** (lines 1230-1657):
        *   Junction records are derived entirely from the `tripEventIds` field on each trip request row (line 1559). The field is split by `;`, each event name is looked up in `trip_events_by_name`, and if not found (`found == 0`), a new `trip_event` row is created via `INSERT IGNORE`. The resulting `(tripRequestId, tripEventId)` pair is appended to `to_insert_trip_request_event`.
        *   The table is truncated and bulk-inserted at lines 1654-1657 with only the accumulated `to_insert_trip_request_event` list. The standalone `trip_request_event.csv` is not used as the source of truth — the `tripEventIds` field on the trip request is authoritative.

---

## Stage 4: Node.js Post-Migration Orchestration {#wiki-migrations-detailed-execution-chain-logic-stage-4-node-js-post-migration-orchestration}

**Triggered by:** `runPostMigrationScript(client)` (using `spawn` for parallel execution)

1.  **`update-trip-request-assignment-status.js`**:
    *   Uses the `TripRequest` model to refresh statuses (Assigned/Pending) for future trips.
2.  **`set-default-requester-role.js`**:
    *   Logic: Ensures all users have at least a "Requester" role and fixes Admin permissions.
3.  **`legacy-migration-report.js`**:
    *   **`fileNameToTableName()`**: Maps `123_tt_user.csv` to `tt_user` table.
    *   **`run()`**: Performs the final reconciliation (CSV rows vs. DB rows).
4.  **`regeocode-prime-meridian-addresses.js`**:
    *   **`reverseGeocodeLatLngSet()`**: Sends coordinates to the Google/Bing API for any address still stuck at the "Prime Meridian" (51.4769, 0.0005).

---

## Stage 5: Finalization {#wiki-migrations-detailed-execution-chain-logic-stage-5-finalization}

1.  **`setClientMigrationStatus(client, 'complete')`**:
    *   Updates the `client` table in the `admin` database to mark the process as finished.

---

