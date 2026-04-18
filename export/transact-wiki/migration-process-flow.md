# Migration Process Flow

## Step-by-Step Breakdown {#wiki-migrations-migration-process-flow-step-by-step-breakdown}

1.  **Preparation**: CSV files are exported and placed in client-specific folders under `/transAct/TravelTracker/ddl/ez_[client_name]`.
2.  **Validation**: `analyzeLegacyMigrationCSV` in `app/admin/index.js` calls the validator and counter to ensure data quality and provide row counts.
3.  **Execution**: `runLegacyMigration` triggers the process:
    *   **Pre-Migration**: Runs `legacy-fix-csv-issues.js` and `legacy-user-email-csv-check.js`.
    *   **Shell Wrapper**: Executes `migrate.sh`.
4.  **Transformation (`migrate.py`)**:
    *   Reads CSV files.
    *   Normalizes dates, times, and phone numbers.
    *   Maps legacy IDs and emails to current system records.
    *   Performs bulk inserts with `INSERT IGNORE`.
5.  **Post-Migration Cleanup (Python)**: `cleanup_post_migration()` runs 24+ SQL queries:
    1.  Delete orphan `tt_user_role` entries (no matching `tt_user` email)
    2.  Update `funding_source.budgetCodeId` from `budget_code.id`
    3.  Backfill `trip_funding.budgetCode` / `budgetCodeId` from `funding_source`
    4.  Set blank `assignmentStatus` to `'pending'`
    5.  Update `trip_request.category` from `trip_type.categoryId`
    6.  Link `funding_source.approverId` via email match to `tt_user`
    7.  Fix addresses with zip `'0'` using lat/lng matching against valid addresses
    8.  Set `trip_funding.budgetCode` to `''` where `budgetCodeId` is NULL
    9.  Link `assignment.driverEmail` / `driverId` via staff name match
    10. Fix Prime Meridian addresses (51.4769, 0.0005) by copying from valid addresses with same name
    11. Set remaining Prime Meridian addresses to default placeholder values
    12. Set `address.recordId` from matching `school.id`
    13. Delete `tt_user_role` entries for inactive schools
    14. Update `driver_trips_hours` with calculated trips and hours from assignments
    15. Update `trip_type_fiscal_data.fiscalYearId` to current fiscal year
    16. Update `vehicleextra.driverId` from `tt_staff.assignedVehicleId`
    17. Replace spaces with commas in `budget_code.code`
    18. Replace `?` placeholders in `trip_funding.budgetCode` with location codes
    19. Insert missing `invoice_payment` records with pre-filled amounts
    20. Truncate `invoice_comment` table
    21. Clear `assignment.vehicle` for vehicles not in `vwAllVehicles`
    22. Set `approval_level.created` to current fiscal year - 1 day
    23. Update `destination.category` to `'School'` when location code matches
    24. Remove `fundingSourceType` from `invoice_payment` when only one funding source exists
    *   **Vehicle type hiding**: Sets `hidden = 1` for Rental/Dealership, Contractor, Approved Charter types if not present in CSV
    *   **`submittedUser` backfill**: Batch updates `trip_request.submittedUser` from CSV email data
    *   **School activation**: Activates schools referenced in `tt_user_role`
    *   **School stop backfill**: Creates missing stops, stopextra, and addresses from school primary addresses
    *   **Approval level sequencing**: Re-sequences `approval_level.seq` in order
    *   **Trip request stop sequencing**: Re-sequences stops per trip with depart/return ordering
    *   **`sanity_checks()`**: Final internal audit for broken references
6.  **Node Post-Migration Scripts**: Orchestrated in `app/admin/index.js` using `spawn` for parallel execution:
    *   `setup/scripts/update-trip-request-assignment-status.js`: Syncs request and assignment states.
    *   `setup/scripts/set-default-requester-role.js`: Ensures all users have necessary roles.
    *   `setup/scripts/legacy-migration-report.js`: Compares CSV row counts vs Database row counts to identify missing data.
    *   `setup/scripts/legacy-fix-csv-location-depot.js`: Specific fixes for depot locations.
    *   **Final Step**: Calls `regeocode-prime-meridian-addresses.js` to fix invalid coordinates.

---

