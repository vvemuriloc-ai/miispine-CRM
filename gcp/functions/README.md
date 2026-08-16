# miiCase background jobs (Cloud Run)

The three nightly jobs, ported from Supabase Edge Functions to Node/TypeScript.
One Cloud Run service exposes all three; **Cloud Scheduler** POSTs to
`/jobs/<name>` on a cron. They connect to Cloud SQL as the **table owner**, which
bypasses RLS — the whole-book access these jobs need (the Supabase `service_role`
equivalent). No build step: Node runs the `.ts` sources via type-stripping.

| Endpoint | Job | Source of truth | DB work |
| --- | --- | --- | --- |
| `POST /jobs/modmed-sync` | AR pull (charges + payments) | ModMed **PM** FHIR | `reconcile_emr()` |
| `POST /jobs/modmed-records` | clinical records → GCS bucket | ModMed **EMA** FHIR | `reconcile_emr_records()` |
| `POST /jobs/autopilot` | nightly attorney outreach | `autopilot_queue` view | `outreach_log` + schedule |

The **ModMed FHIR mappers (`*/fhir.js`) are the exact modules from the Supabase
build**, unit-tested unchanged (41 checks). What was rewritten is only the job
shell: `supabase-js` → `pg`, and Supabase Storage → GCS (`@google-cloud/storage`).
Everything ModMed-specific stays read-only (GET + the token POST); nothing writes
to the EMR.

## Injectable side effects (why it's testable)

Each job's `run()` takes optional deps so the whole pipeline can be exercised
without ModMed / GCS / Claude / SendGrid:

- `modmed-sync`  — `{ fetchImpl }`
- `modmed-records` — `{ fetchImpl, uploadImpl }`
- `autopilot` — `{ draftImpl, sendImpl }`

## Test

```bash
npm run test:mappers    # 41 pure-mapper checks
# Against a fresh, migrated Postgres (owner conn):
DATABASE_URL="postgresql://postgres@localhost:5433/postgres" \
MODMED_BASE_URL="https://x.ema-api.com/ema-prod/firm/p/ema/fhir/v2" \
MODMED_API_KEY=k MODMED_USERNAME=u MODMED_PASSWORD=p \
npm test                # 10 integration checks (mock ModMed/GCS/Claude)
```

The integration test drives all three `run()`s against real SQL: charges →
bills with the waterfall lien (idempotent), DocumentReference → GCS upload →
`records` marked uploaded, and a queued case drafted + logged + rescheduled.

## Environment

| Var | Used by |
| --- | --- |
| `DATABASE_URL` | all — Cloud SQL as the owner role |
| `MODMED_BASE_URL` / `MODMED_API_KEY` / `MODMED_USERNAME` / `MODMED_PASSWORD` | modmed-* |
| `MODMED_DRY_RUN` | modmed-* (`true` = stage, skip reconcile/upload) |
| `RECORDS_BUCKET` | modmed-records (GCS bucket) |
| `ANTHROPIC_API_KEY` | autopilot |
| `SENDGRID_API_KEY` / `AUTOPILOT_FROM_EMAIL` / `AUTOPILOT_DRY_RUN` | autopilot |

## Deploy (Phase 4 infra)

```bash
gcloud run deploy miicase-jobs --source .            # private; no unauthenticated access
# One Cloud Scheduler job per endpoint, authenticated with a service account:
gcloud scheduler jobs create http modmed-records --schedule "0 5 * * *" \
  --uri "$JOBS_URL/jobs/modmed-records" --http-method POST --oidc-service-account-email …
# modmed-sync 05:30, autopilot 06:00 — same pattern.
```

Records download for attorneys is **not** here — it's an authenticated endpoint
in the API tier (`POST /api/records/:id/download`), gated by firm + HIPAA release
+ audit.
