# miiCase API tier (Cloud Run)

The Node/TypeScript service that replaces Supabase's PostgREST. It verifies a
Firebase ID token, resolves the caller's firm, sets the `app.*` session
variables, and runs every query under RLS on Cloud SQL. No build step — Node
executes the `.ts` sources directly via `--experimental-strip-types`.

## Request flow

```
Bearer <firebase-id-token>
   │  verifyToken()  (firebase-admin, or mock:<uid> in tests)
   ▼  → uid
loadProfile(uid)  → { firmId, isStaff }        (from user_profiles, cached ~60s)
   ▼
withTenant()  → BEGIN; set_config('app.user_id'|'app.firm_id'|'app.is_staff'); …; COMMIT
   ▼
handler runs its queries on that connection — RLS scopes everything
```

Isolation is the **database's** job: the pool connects as `miicase_app` (not the
table owner), so even a buggy handler can't cross firms. `firm_id` values in a
request body are never trusted for scoping — only for the row being written,
which RLS then checks.

## Endpoints

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/api/health` | liveness (no auth) |
| GET | `/api/me` | caller's profile (`firmId`, `isStaff`, `role`) |
| GET | `/api/cases` | cases (firm-scoped) with firm/attorney/client + AR totals |
| GET | `/api/cases/:id` | one case + bills, pip, records, invoices, milestones |
| GET | `/api/ar-aging` | `ar_aging` view |
| GET | `/api/autopilot-queue` | `autopilot_queue` view |
| GET | `/api/invoices` | `invoices_view` |
| GET | `/api/review-queue` | `review_queue` view |
| POST | `/api/records` | create a record (attorney → request; staff → any) |
| PATCH | `/api/bills/:id` | reconcile a bill (lien/AR recompute via triggers) |

All routes except `/api/health` require `Authorization: Bearer <token>`. An
unknown user (no `user_profiles` row) gets `403`; a cross-firm row is simply
invisible (`404`), never `403`, because RLS hides it.

## Run locally

```bash
npm install
# Point at a migrated DB; connect as miicase_app so RLS applies.
AUTH_MODE=mock \
DATABASE_URL="postgresql://miicase_app@localhost:5432/mydb" \
npm start
# Then: curl -H 'authorization: Bearer mock:uid-staff' localhost:8080/api/cases
```

`AUTH_MODE=mock` accepts `mock:<uid>` tokens (local/testing only). In production
leave it unset (`firebase`); the service uses `firebase-admin` with Application
Default Credentials on Cloud Run.

## Test

```bash
# Against a fresh, migrated Postgres with roles.sql applied:
AUTH_MODE=mock \
DATABASE_URL="postgresql://miicase_app@localhost:5433/postgres" \
OWNER_URL="postgresql://postgres@localhost:5433/postgres" \
npm test
```

The integration test drives the real server and asserts firm isolation across
`/api/cases`, cross-firm 404s, the records guard, and trigger-backed bill
reconciliation — 20 checks.

## Environment

| Var | Purpose |
| --- | --- |
| `DATABASE_URL` | Cloud SQL connection as `miicase_app` |
| `AUTH_MODE` | `firebase` (default) or `mock` |
| `CORS_ORIGIN` | dashboard origin (default `*`) |
| `PROFILE_TTL_MS` | profile cache TTL (default 60000) |
| `PORT` | listen port (Cloud Run sets 8080) |

Deploy: `gcloud run deploy miicase-api --source .` with `DATABASE_URL` from
Secret Manager and the Cloud SQL connection attached (Phase 4 infra).
