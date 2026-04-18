# Summary

## 3. Missing "Funding Source" criteria label {#wiki-possible-fixes-for-funding-source-approval-issues-summary-3-missing-funding-source-criteria-label}

**Location:** `TravelTracker/app/approval-level/set-trip-approvals.js` (line 251)

```javascript
.where({ label: 'Funding Source' })
```

**Scenario:** If no `approval_level_criteria` record has `label = 'Funding Source'`, the `saveFundingSourceApproval()` function returns early without creating any funding source approvals.

**Mitigation:** Ensure the criteria table contains an entry with `label = 'Funding Source'` configured for the appropriate trip types and locations.

---

## 4. Funding source with null/empty name {#wiki-possible-fixes-for-funding-source-approval-issues-summary-4-funding-source-with-null-empty-name}

**Location:** `TravelTracker/app/approval-level/approval-level-v2.js` (line 759)

**Scenario:** If a funding source record exists with a NULL `name`, this is caught as a validation error (`hasFundingSourceIssue`) but could prevent proper approval flow.

**Mitigation:** Ensure all funding sources have valid names populated in the `funding_source` table.

---

---

## 4. Trip type / location mismatch {#wiki-possible-fixes-for-funding-source-approval-issues-summary-4-trip-type-location-mismatch}

**Location:** `TravelTracker/app/approval-level/set-trip-approvals.js` (lines 128-156)

**Scenario:** The funding source criteria is filtered by `tripTypeId` and `locationId`. If the criteria is configured for a different trip type or location than the trip request, it won't be found or applied.

**Mitigation:** Verify that the "Funding Source" criteria is properly configured for all relevant trip types and locations in the `approval_level_criteria`, `approval_level_trip_type`, and `approver` tables.

---

