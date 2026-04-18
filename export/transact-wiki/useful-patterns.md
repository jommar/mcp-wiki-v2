# Useful Patterns

## Adding a New Feature Module (Portage Backend) {#wiki-useful-patterns-adding-a-new-feature-module-portage-backend}

1. Generate module: `nest g module apps/api/src/your-feature`
2. Create DTOs in `dto/` with `class-validator` decorators
3. Add Swagger decorators (`@ApiOperation`, `@ApiResponse`, `@ApiTags`)
4. Use `@Permission({ feature: RefFeature.X, type: RefPermission.Y })` for access control
5. Use `@Public()` if no auth needed
6. Access context via `req.context` (typed as `TtContext` on Express Request)
7. Add to `api.module.ts` imports
8. Add event types to `TtEventType` enum if emitting events
9. Write integration test in `test/integration/`

---

## Adding a New Page (Portage Frontend) {#wiki-useful-patterns-adding-a-new-page-portage-frontend}

1. Create page in `pages/[client]/your-feature/index.vue` using `defineAsyncComponent`
2. Create feature module in `modules/your-feature/`
3. Create Pinia store in `stores/your-feature/` (composition API style)
4. Use `useFetchApi` for API calls — returns `{ data, pending, error, refresh, userError, cancel }`
5. Add route middleware if auth/permission needed
6. Write Playwright test in `test/`

---

## Calling the API from Frontend {#wiki-useful-patterns-calling-the-api-from-frontend}

```typescript
const { data, pending, refresh } = useFetchApi('/api/v2/trip-request/list/get', {
  method: 'POST',
  body: { skip: 0, take: 20, sortList: [], filters: {}, include: {} },
});
```

---

## Emitting a Domain Event (Portage Backend) {#wiki-useful-patterns-emitting-a-domain-event-portage-backend}

```typescript
this.eventEmitter.emit(TtEventType.TRIP_REQUEST_CREATE, new TripRequestCreateEvent(ctx, trip));
```

---

---

