# Troubleshooting

## Database Not Found (`ez_colbert`) {#wiki-docker-troubleshooting-database-not-found-ez-colbert}

The init script only creates `travel_tracker_trips`. The client database `ez_colbert` must be created manually:

```bash
docker exec -it ttt-database mysql -u admin -psecret -e "CREATE DATABASE IF NOT EXISTS ez_colbert;"
```

---

## Grafana/InfluxDB Won't Start {#wiki-docker-troubleshooting-grafana-influxdb-won-t-start}

```bash
# Check if ports 3000 or 8086 are in use
lsof -i :3000
lsof -i :8086

# Clean up and restart
cd Portage-backend/test/load
./stop_grafana.sh
docker network rm monitoring-net 2>/dev/null || true
./start_grafana.sh
```

---

## Kafka Not Reachable {#wiki-docker-troubleshooting-kafka-not-reachable}

```bash
# Verify Kafka and Zookeeper are both running
docker ps --filter "name=ttt-kafka" --filter "name=ttt-zookeeper"

# Check Kafka logs for startup errors
docker logs ttt-kafka 2>&1 | tail -50

# Verify advertised listener is correct
docker exec ttt-kafka kafka-broker-api-versions.sh --bootstrap-server localhost:9092
```

---

## MySQL Connection Refused {#wiki-docker-troubleshooting-mysql-connection-refused}

```bash
# Verify container is running
docker ps --filter "name=ttt-database"

# Check MySQL is accepting connections
docker exec ttt-database mysqladmin ping -u admin -psecret

# Check init script ran (first start only)
docker exec ttt-database mysql -u admin -psecret -e "SHOW DATABASES;"
```

---

## Port Already in Use {#wiki-docker-troubleshooting-port-already-in-use}

```bash
# Check what is using a port
lsof -i :3306
lsof -i :6379
lsof -i :9092

# Kill the process or stop the conflicting container
docker stop ttt-database
```

---

## Redis Connection Issues {#wiki-docker-troubleshooting-redis-connection-issues}

```bash
# Test Redis connectivity
docker exec ttt-redis redis-cli ping

# Check Redis logs
docker logs ttt-redis
```

---

## Scheduler Port 3000 Conflicts with Grafana {#wiki-docker-troubleshooting-scheduler-port-3000-conflicts-with-grafana}

If Grafana is running and the scheduler fails to start (or vice versa):

```bash
# Option 1: Change scheduler port
# Edit Portage-backend/apps/scheduler/.env
BACKEND_PORT=3002

# Option 2: Stop Grafana first
cd Portage-backend/test/load && ./stop_grafana.sh
```

---

---

## Stale Volumes Causing Issues {#wiki-docker-troubleshooting-stale-volumes-causing-issues}

```bash
# Full reset: stop, destroy volumes, restart
cd TravelTracker/setup/docker
docker-compose down -v
docker-compose up -d
# Re-create ez_colbert if needed
docker exec ttt-database mysql -u admin -psecret -e "CREATE DATABASE IF NOT EXISTS ez_colbert;"
```

---

## Approval Troubleshooting Checklist (Legacy Backend / Portage UI) {#wiki-troubleshooting-approval-troubleshooting-checklist-legacy-backend-portage-ui}

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

---

