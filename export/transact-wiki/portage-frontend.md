# Portage Frontend

## Architecture {#wiki-portage-frontend-architecture}

Nuxt 3 SPA (SSR disabled) with Vue 3 Composition API:

```
Portage-frontend/
├── pages/[client]/          # File-based routing, multi-tenant
├── modules/                 # Feature modules (trip-request, bids, dashboard, users, etc.)
├── stores/                  # Pinia stores organized by domain
├── components/              # Reusable UI components
│   ├── ui/                  # Base UI (buttons, icons, dialogs, tables)
│   ├── forms/               # Form fields (input, dropdown, checkbox, radio)
│   ├── template/            # Page layouts (list, cards, steps)
│   └── dialog/              # Modal dialogs
├── layouts/                 # Single layout (TopBar + Toast)
├── middleware/              # Global guards (auth, restricted-access, exit-prompt)
├── plugins/                 # PrimeVue, Google Maps
├── utils/                   # Helpers, types, constants
└── test/                    # Playwright e2e tests
```

---

## Key Concepts {#wiki-portage-frontend-key-concepts}



---

## Key Pages {#wiki-portage-frontend-key-pages}

| Route                           | Description                                                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `/:client/`                     | Dashboard with role-based widget counts                                                                                   |
| `/:client/trip-requests`        | Paginated list with 35+ filters, sorting, bulk actions. Responsive desktop/mobile views via `useWindowSize()`             |
| `/:client/trip-requests/create` | 8-step wizard (General → Supporting Docs). Exit prompt on navigation away                                                 |
| `/:client/trip-requests/[id]`   | View/edit with `LazyTripRequestViewEdit`. Review tabs (Approval, Comments, Emails, Audit). Exit prompt on unsaved changes |
| `/:client/bids/admin`           | Admin bid management: create periods, assign drivers                                                                      |
| `/:client/bids/driver`          | Driver-facing: browse trips, place/remove bids                                                                            |
| `/:client/settings/users`       | User management: list, add, edit, roles, approval levels                                                                  |

---

## Notable Patterns & Quirks {#wiki-portage-frontend-notable-patterns-quirks}

1. **Draft mode** — Blue background with "DRAFT" watermark when editing draft trips
2. **Exit prompt** — Promise-based dialog blocks navigation on unsaved changes
3. **Duplicate functionality** — `stores/settings/trip.ts` and `stores/trips/tripType.ts` both fetch trip types
4. **Empty store** — `stores/settings/vehicle.ts` exists but is mostly empty (only has `useFetchApi` import)
5. **SSR disabled** — Pure client-side SPA despite Nuxt
6. **Auth handled by legacy app** — Checks health via `/api/v2/auth/health`, sign-out redirects to legacy
7. **Pages use `defineAsyncComponent`** for lazy loading, not direct imports
8. **Middleware execution order** — Files prefixed with numbers execute in order (`01-`, `02-`, etc.)
9. **Component auto-imports** — PrimeVue components registered with `P` prefix, custom components without prefix

---

---

## Testing {#wiki-portage-frontend-testing}

| Type | Tool       | Location                                        | Command                  |
| ---- | ---------- | ----------------------------------------------- | ------------------------ |
| Unit | Vitest     | `components/**/*.spec.ts`, `utils/**/*.spec.ts` | `npm run test:unit`      |
| E2E  | Playwright | `test/`                                         | `npm run test:e2e:smoke` |

**Note:** Cypress exists but Playwright is the primary E2E framework. Use Playwright for new tests.

---

