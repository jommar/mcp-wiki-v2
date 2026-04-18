# Possible Fixes for Funding Source Approval Issues

## Approach 1: Insert into `approver` table (Database Fix) {#wiki-possible-fixes-for-funding-source-approval-issues-approach-1-insert-into-approver-table-database-fix}

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

---

## Approach 2: Modify `getApprover` function (Code Fix) {#wiki-possible-fixes-for-funding-source-approval-issues-approach-2-modify-getapprover-function-code-fix}

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

---

## Must Fix: Early Continue Bug (Lines 56-59) {#wiki-possible-fixes-for-funding-source-approval-issues-must-fix-early-continue-bug-lines-56-59}

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

---

## Root Cause Summary {#wiki-possible-fixes-for-funding-source-approval-issues-root-cause-summary}

The funding source approval has two main issues:

1. **INNER JOIN excludes criteria** - `getCriteria()` filters out Funding Source criteria because no approvers exist in `approver` table for level 5
2. **Early continue skips funding** - Lines 56-59 skip funding source handling entirely when no other approval levels exist
3. **Disconnected approver systems** - `funding_source.approverId` (tt_user.id) is never linked to `approver` table

---

---

## Summary {#wiki-possible-fixes-for-funding-source-approval-issues-summary}

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

---

