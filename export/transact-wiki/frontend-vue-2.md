# Frontend (Vue 2)

## Assignment Screen Data Loading & Store Cleanup {#wiki-traveltracker-legacy-frontend-vue-2-assignment-screen-data-loading-store-cleanup}

The Assignment List view (`views/Assignments/List.vue`) loads heavy data on mount:

```js
async refresh() {
  this.loading = true;
  await this[GET_TRIP_REQUESTS]();           // loads all trip requests into tripRequest store
  await this[GET_ASSIGNMENTS]({              // loads all assignments into assignment store
    tripRequestIds: this.tripRequests.map((e) => e.id)
  });
  this.filterAssignments(this.assignmentListFilters);
  this.loading = false;
}
```

**Problem:** Vuex store retains this data even after navigating away (e.g., to Invoice screen), causing memory buildup on large datasets. Unlike the Trip Request screen (which navigates to Portage and triggers a full page refresh), the Assignment screen stays within the Vue 2 SPA.

**Solution:** `router.afterEach` guard clears store data when navigating away from `/assignments`:

```js
router.afterEach((to, from) => {
  if (from.path.startsWith('/assignments') && !to.path.startsWith('/assignments')) {
    store.dispatch('assignment/clearAssignments');
    store.dispatch('tripRequest/clearTripRequests');
  }
});
```

Each store module has a corresponding `clear*` mutation + action that resets state to initial empty values (e.g., `clearAssignments` resets `assignments`, `filteredAssignmentIds`, `selectedAssignments` to `[]`).

---

## Router Guards {#wiki-traveltracker-legacy-frontend-vue-2-router-guards}

Defined in `ui/src/router/index.js` (~831 lines):

| Guard | Purpose |
|---|---|
| `beforeEach` | Role/permission checks, fetches client config, redirects to default path if access denied |
| `beforeResolve` | Sets `document.title` from route meta |
| `beforeEnter` (per-route) | Inline guards on Dashboard, Trip Requests, Driver routes for specific access checks |
| `afterEach` | Clears Vuex store data when navigating away from specific routes (e.g., `/assignments`) |

---

## Vuex Store Structure {#wiki-traveltracker-legacy-frontend-vue-2-vuex-store-structure}

Store registered in `ui/src/store/index.js` with modules for each domain. Each module follows the standard Vuex pattern:

```
store/modules/{Domain}/
├── state.js       # Reactive state object
├── mutations.js   # Synchronous state mutations
├── actions.js     # Async operations (API calls), dispatch mutations
├── getters.js     # Computed state accessors
└── store.js       # Barrel export { state, mutations, actions, getters }
```

Key modules: `assignment`, `tripRequest`, `invoice`, `user`, `vehicle`, `driver`, `fundingSource`, `approvalLevel`, `app`, `config`, `calendar`, `location`, `tripType`, `budgetCode`, `roster`, `staff`, `smsLog`, etc.

---

