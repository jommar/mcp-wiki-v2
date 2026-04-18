# Common Developer Tasks

## Adding a new API endpoint (Portage Backend) {#wiki-common-developer-tasks-adding-a-new-api-endpoint-portage-backend}

1. Create module: `nest g module apps/api/src/my-feature`
2. Create controller, service, DTOs
3. Register in `api.module.ts`
4. Add permissions via `@Permission()` decorator

---

## Adding a new approval level {#wiki-common-developer-tasks-adding-a-new-approval-level}

1. Insert into `approval_level` table
2. Link to trip types in `approval_level_trip_type`
3. Add criteria in `approval_level_criteria` (optional)
4. Assign approvers in `approver` table for specific locations/trip types

---

## Adding a new field to Trip Request {#wiki-common-developer-tasks-adding-a-new-field-to-trip-request}

1. Add to `client.prisma` schema (run `prisma generate` after)
2. Add to `CreateTripRequestDto` and `UpdateTripRequestDto`
3. Add to `TripRequestTransformer` for response mapping
4. Add validation rules if needed
5. Update frontend form component

---

## Debugging a failing test {#wiki-common-developer-tasks-debugging-a-failing-test}

```bash
# Portage Backend unit test
npx jest path/to/file.spec.ts --verbose

# Portage Backend integration test
npx jest --config test/integration/utils/jest-config.js -- test/integration/trips.spec.js --verbose

# Portage Frontend unit test
npx vitest run path/to/file.spec.ts
```

---

## Working with the legacy database {#wiki-common-developer-tasks-working-with-the-legacy-database}

```bash
# Connect to a client's database
mysql -h 127.0.0.1 -u root -p ez_colbert

# Check approval status for a trip
SELECT * FROM trip_approvals WHERE tripRequestId = 123;

# Check audit log
SELECT * FROM tt_audit WHERE recordType = 301 AND recordId = 123 ORDER BY created DESC;
```

---

---

