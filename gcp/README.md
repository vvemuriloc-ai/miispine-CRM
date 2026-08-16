# miiCase on Google Cloud

A re-platform of miiCase from Supabase to **Google Cloud** — free BAA, ~5–10×
lower monthly cost — keeping the entire relational core (schema, triggers, lien
math, RLS, the ModMed FHIR mappers) and rebuilding only the Supabase-specific
plumbing.

## Target architecture

```
 Browser (app/index.html)
     │  Firebase ID token
     ▼
 Cloud Run API (Node/TS)  ──validates token, looks up firm──▶  sets app.* session vars
     │                                                          then queries under RLS
     ▼
 Cloud SQL for Postgres  ── 23 tables · firm-isolation RLS (session-variable) · triggers
     ▲                                   ▲
     │ owner conn (bypasses RLS)         │ V4 signed URLs
 Cloud Run jobs (autopilot, modmed-sync, modmed-records)   Google Cloud Storage (private)
     ▲                                   records bucket
 Cloud Scheduler (nightly)
```

| Supabase piece | Google Cloud replacement | Status |
| --- | --- | --- |
| Postgres + RLS (JWT claim) | **Cloud SQL Postgres + RLS (session variable)** | ✅ ported & proven |
| Auth + access-token hook | **Firebase Auth** + API-tier claim lookup | ✅ DB side; 🔜 API |
| PostgREST (browser→DB) | **Cloud Run API (Node/TS)** | ✅ built & tested |
| Supabase Storage + signed URLs | **GCS private bucket + V4 signed URLs** | 🔜 Phase 3 |
| Edge Functions (Deno) ×4 | **Cloud Run services/jobs (Node/TS)** | 🔜 Phase 3 |
| pg_cron + pg_net | **Cloud Scheduler → Cloud Run** | 🔜 Phase 3 |

## The tenancy contract (the one thing that changed)

Supabase RLS read the tenant from a JWT claim. On Cloud SQL the **API tier sets
three session variables** at the start of each request, and RLS reads those:

```sql
SET LOCAL app.user_id  = '<firebase-uid>';
SET LOCAL app.firm_id  = '<uuid or empty>';
SET LOCAL app.is_staff = 'true' | 'false';
```

`auth_firm_id()` / `auth_is_staff()` / `current_user_id()` (in `0002_auth.sql`)
read them. RLS is still enforced **inside the database**, so an API bug can't
leak one firm's PHI to another — defense in depth is preserved. Background jobs
connect as the **table owner** (no `app.*`), which bypasses RLS for the
whole-book access they need — the equivalent of Supabase's `service_role`. See
`db/roles.sql`.

## Layout

```
gcp/
  db/migrations/   11 Cloud-SQL migrations (portable Postgres + session-var RLS)
  db/roles.sql     miicase_app (API, RLS applies) vs owner (jobs, bypasses)
  db/test_rls.sql  session-variable isolation smoke test
  api/             Cloud Run API tier (Node/TS)          — Phase 2
  functions/       Cloud Run jobs (Node/TS)              — Phase 3
  infra/           Terraform / gcloud setup              — Phase 4
```

The migrations mirror the Supabase set one-to-one, minus the four
Supabase-only pieces (the token hook, the Supabase Storage schema, and the three
pg_cron files) — those move to the API / GCS / Cloud Scheduler.

## Apply + verify locally

```bash
# Against a local or Cloud SQL Postgres, as an owner/superuser:
for f in gcp/db/migrations/0*.sql; do psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"; done
psql "$DATABASE_URL" -f gcp/db/roles.sql
psql "$DATABASE_URL" -f gcp/db/test_rls.sql   # prove firm isolation
```

## Status

- **Phase 1 — DB foundation: done.** All 11 migrations apply clean on Postgres
  16; session-variable RLS proven (firm isolation, staff bypass, fails-closed,
  records guard). Nothing here is Supabase-specific anymore.
- **Phase 2 — API tier: done.** `gcp/api` — Node/TS on Cloud Run, no build step
  (native type-stripping). Firebase token → profile → `app.*` → RLS. Integration
  test drives the real server and proves isolation + the records guard + bill
  reconciliation end to end (20 checks). See `gcp/api/README.md`.
- Next: **Phase 3** — GCS signed-URL records download + the 4 background jobs
  (autopilot, modmed-sync, modmed-records) as Cloud Run on Cloud Scheduler.
