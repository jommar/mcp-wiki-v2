# Post-Migration Node.js Orchestration

## 1. Assignment Status Sync (`update-trip-request-assignment-status.js`) {#wiki-migrations-post-migration-node-js-orchestration-1-assignment-status-sync-update-trip-request-assignment-status-js}

- **Action**: Queries all `trip_request` records with a `leaveDate` in the future.
- **Logic**: Calls the internal `trip-request` module to recalculate and update the `assignmentStatus` field based on the state of linked assignments (e.g., transitioning from `pending` to `assigned` or `partially-assigned`).

---

## 2. Role Normalization (`set-default-requester-role.js`) {#wiki-migrations-post-migration-node-js-orchestration-2-role-normalization-set-default-requester-role-js}

- **Action**: Enforces standard security and role constraints across all migrated users.
- **Logic**:
  - Deletes all existing "Requester" (Role ID 19) entries to prevent duplicates.
  - Updates "Super Admin" (Role 1) and "Transport Admin" (Role 2) to ensure their `locationId` is `0` (global access).
  - Automatically grants the "Requester" role (Role 19) with `locationId: 0` to any user who is NOT a Super Admin or Transport Admin.

---

## 3. Data Integrity Reporting (`legacy-migration-report.js`) {#wiki-migrations-post-migration-node-js-orchestration-3-data-integrity-reporting-legacy-migration-report-js}

- **Action**: Generates a JSON audit report comparing the source CSVs to the resulting database state.
- **Logic**:
  - Iterates through `TABLES_TO_CHECK` (e.g., `tt_user`, `trip_request`, `assignment`).
  - Extracts expected row counts from CSVs using `papaparse`.
  - Queries actual row counts from the client database.
  - **Output**: Writes `migration-report.json`. If `csvRows > dbRows`, it flags a warning indicating potential data loss or ingestion failure.

---

## 4. Final Geocoding Fix (`regeocode-prime-meridian-addresses.js`) {#wiki-migrations-post-migration-node-js-orchestration-4-final-geocoding-fix-regeocode-prime-meridian-addresses-js}

- **Action**: Triggered as the final step after all parallel scripts finish.
- **Logic**: Attempts to resolve the "Prime Meridian" coordinates (51.4769, 0.0005) for addresses that could not be matched during the Python migration by using the application's geocoding provider.

---

