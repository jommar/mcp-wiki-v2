# Known Edge Cases for Funding Source Approval

## 1b. Funding Approval Skipped When No Other Approval Levels Exist (JIRA VALIDATED) {#wiki-approval-workflow-deep-dive-known-edge-cases-for-funding-source-approval-1b-funding-approval-skipped-when-no-other-approval-levels-exist-jira-validated}

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

---

## 1. Funding Source Criteria Excluded Due to INNER JOIN with Approver (ROOT CAUSE - CONFIRMED) {#wiki-approval-workflow-deep-dive-known-edge-cases-for-funding-source-approval-1-funding-source-criteria-excluded-due-to-inner-join-with-approver-root-cause-confirmed}

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

---

## 2. Individual Funding Source Has No approverId {#wiki-approval-workflow-deep-dive-known-edge-cases-for-funding-source-approval-2-individual-funding-source-has-no-approverid}

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

---

## 3. Funding Source Approver vs Approval Level Approver Are Disconnected {#wiki-approval-workflow-deep-dive-known-edge-cases-for-funding-source-approval-3-funding-source-approver-vs-approval-level-approver-are-disconnected}

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

---

