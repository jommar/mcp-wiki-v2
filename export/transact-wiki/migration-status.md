# Migration Status

## CSV Migration Notes (Legacy) {#wiki-migration-status-csv-migration-notes-legacy}

- In `TravelTracker/ddl/migrate.py`, `migrate_approvers()` inserts into `approver` with `id = NULL` (auto-increment).
- This means source CSV `approver.id` values are **not preserved** during migration.

---

## Migration Bridge {#wiki-migration-status-migration-bridge}

- `TravelTracker/app/apiv2/` proxies requests to Portage
- Portage `apps/api/src/legacy/` proxies back to TravelTracker for unmigrated endpoints
- Both systems share the same MySQL databases
- Frontend routes in TravelTracker redirect to Portage for migrated features

---

---

## What Remains in TravelTracker {#wiki-migration-status-what-remains-in-traveltracker}

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

---

## What's Migrated to Portage {#wiki-migration-status-what-s-migrated-to-portage}

- Trip request CRUD (create, view, edit, list, filters)
- Approval workflow (view, approve, deny, request changes)
- User management (CRUD, roles)
- Dashboard (summary counts, role-based widgets)
- Bidding system (admin + driver views)
- Settings (destinations, locations, funding sources, vehicle types, approval levels)
- Notifications
- Multi-tenant database resolution
- Session-based authentication

---

