# miiCase / miiSpine AR

An accounts-receivable engine, attorney-outreach **Autopilot**, and demand-math
dashboard for personal-injury cases at miiSpine (a Louisville, KY spine surgery
practice). Built on **Supabase** (Postgres + RLS + Edge Functions) with a
self-contained, branded web dashboard.

```
┌─────────────────────────────────────────────────────────────┐
│  app/index.html   ── branded single-file dashboard (Supabase JS)
│        │  reads ar_aging / autopilot_queue / cases / invoices (RLS)
│        ▼
│  Postgres  ── 22 tables · firm-isolation RLS · AR rollup triggers
│        ▲                              ▲
│        │ service_role (bypasses RLS)  │ reconcile_emr()
│  functions/autopilot  ── nightly:     │  functions/modmed-sync ── nightly:
│    score → draft (Claude) →           │    GET ModMed FHIR charges + payments
│    send (SendGrid) → log → reschedule │    → stage → reconcile bills/liens (read-only)
│        ▲                              ▲
│  pg_cron 06:00 UTC (0005)        pg_cron 05:30 UTC (0012)
└─────────────────────────────────────────────────────────────┘
```

## Layout

| Path | What it is |
| --- | --- |
| `supabase/migrations/0001_schema.sql` | Tables, generated columns, immutable audit log, indexes |
| `supabase/migrations/0002_rls.sql` | Row-level security — firm isolation on every firm-scoped table |
| `supabase/migrations/0003_views.sql` | `autopilot_queue` + `ar_aging` views (`security_invoker`) |
| `supabase/migrations/0004_triggers.sql` | `updated_at` stamps + AR rollup / collateral-calc sync |
| `supabase/migrations/0005_cron.sql` | Nightly pg_cron schedule for the autopilot function |
| `supabase/migrations/0006_auth.sql` | `user_profiles` mapping + access-token hook that stamps `firm_id` into the JWT |
| `supabase/migrations/0007_staff_and_import.sql` | miiSpine staff role (sees all firms) + `staging_import` / `normalize_import()` for the legacy sheet |
| `supabase/migrations/0008_lien_reconciliation.sql` | Lien = charges outstanding after PIP/insurance (trigger) + case review flags + `review_queue` |
| `supabase/migrations/0009_records_access.sql` | Private records bucket, HIPAA-gated RLS, attorney-guard trigger, `case_records` view |
| `supabase/migrations/0010_invoices.sql` | Collections invoices to the firm — sequential `MII-YYYY-NNNN` numbers, payment ledger rollup, overdue status, staff-only issuance |
| `supabase/migrations/0011_modmed_sync.sql` | ModMed EMR sync landing tables + `reconcile_emr()` — charges → bills (idempotent), payment waterfall, staff-only RLS |
| `supabase/migrations/0012_modmed_cron.sql` | Nightly pg_cron schedule for the read-only ModMed AR pull |
| `supabase/functions/modmed-sync/` | Read-only FHIR broker: pulls ModMed charges + payments into the covered DB (`index.ts`) with a tested pure-mapping module (`fhir.js`) |
| `supabase/functions/records-download/index.ts` | Mints audited, 60s signed URLs after firm + HIPAA checks |
| `tools/import_from_xlsx.js` | Extracts the legacy PI AR workbook to a staging CSV (no npm deps) |
| `supabase/seed.sql` | Demo dataset (2 firms, 6 cases, bills, PIP, milestones) |
| `supabase/functions/autopilot/index.ts` | The nightly follow-up engine |
| `app/index.html` | The AR dashboard (demo-data fallback, no build step) |
| `index.html` | The original miiSpine **outreach** CRM (Google Sheets prospecting) |

## Data model highlights

- **`cases`** is the central record. `balance_outstanding` is a stored generated
  column (`total_lien - total_collected`); the other AR totals are denormalized
  for fast dashboards and kept in sync by triggers from `medical_bills`.
- **Lien = outstanding after payments** (`0008`): a bill's `lien_amount` is the
  charges still owed after PIP and insurance —
  `max(0, billed − pip_paid − insurance_paid)` — maintained by a trigger (opt out
  with `lien_manual` for a negotiated lien). So the imported book starts as gross
  charges and the outstanding lien drops as staff reconcile payments in the app.
- **`collateral_calc`** is a live demand-math snapshot (net specials, tiered
  miiSpine lien, other liens) refreshed automatically on any bill change.
- **`pip_ledger`** tracks Kentucky $10K PIP availability, incl. post-July-2026
  HB 627 fields.
- **`audit_log`** is append-only — `ON UPDATE/DELETE DO INSTEAD NOTHING` rules
  make PHI-access rows immutable for the 6-year retention requirement.

## Medical records (attorney self-serve)

The attorney portal's headline feature: counsel can see every record on their
cases, download the ones miiSpine has uploaded, and request the rest — instead of
faxing a request and waiting blind. Because this is PHI leaving to an outside
party, the guardrails are the feature (`0009_records_access.sql`):

- Files live in a **private** Supabase Storage bucket; the browser never sees a
  raw path. Downloads go through the **`records-download` edge function**, which
  re-checks firm ownership (RLS, on the caller's JWT) **and** the client's
  `hipaa_release_on_file`, writes an immutable `audit_log` row, then mints a
  **60-second signed URL**. No release on file ⇒ download is refused.
- Attorneys can only **create request rows** — a `BEFORE INSERT` trigger strips
  any `storage_key` and forces `status='requested'`, so they can never point a
  record at another firm's file. Only miiSpine staff (`is_staff`) set
  `storage_key`, upload to the bucket, and `UPDATE`/`DELETE` records.

In the dashboard, each case's detail panel has a **Medical Records** section: a
HIPAA banner, the record checklist with live status, and per-row **Download**
(attorney, when a file is ready and release is on file), **Request** (attorney,
when missing), or **Upload** (staff).

## Invoices (collections to the firm)

Once a case is reconciled, miiSpine bills the attorney's firm for the outstanding
lien. `0010_invoices.sql` adds an `invoices` table and an `invoice_payments`
ledger:

- **Sequential numbering.** A `BEFORE INSERT` trigger stamps `MII-YYYY-NNNN` from
  a Postgres sequence (year taken from the issue date), so every invoice has a
  stable, human-readable number.
- **Payment rollup drives status.** Recording a payment writes an
  `invoice_payments` row; an `AFTER` trigger re-sums the ledger onto the invoice
  and advances `status` (`draft → sent → partial → paid`), stamping `paid_date`
  when the balance clears and reverting if a payment is removed. `balance_due` is
  a stored generated column (`amount − amount_paid`).
- **Overdue is computed, not stored.** `invoices_view` derives `effective_status
  = 'overdue'` when a `sent`/`partial` invoice is past its due date with a balance
  — so aging never needs a nightly job to flip a flag.
- **RLS mirrors records.** Firms **read** their own invoices and payments; only
  miiSpine staff (`is_staff`) **issue** invoices and **record** payments
  (`insert`/`update`/`delete` are staff-only). An attorney can see what they owe,
  never mint or alter an invoice.

In the dashboard, the **Invoices** tab lists every invoice with firm, patient,
amount, balance, and status; each case's detail panel gains an **Invoices**
section to issue one straight from the reconciled outstanding lien. The invoice
detail view records payments, voids, and prints a clean firm-facing copy.

## Auth & multi-tenancy

RLS scopes every read to a `firm_id` JWT claim. That claim is put there by a
**custom access token hook** (`0006_auth.sql`):

1. `user_profiles` maps each `auth.users` row to a `firm_id` (+ `staff`/`admin` role).
2. `public.custom_access_token_hook(event)` runs on every token issuance and
   stamps `firm_id` / `firm_role` into the JWT claims from that mapping.
3. `public.assign_user_to_firm(email, firm_id, role)` is the admin helper that
   links a signed-up user to their firm.

So a user with no profile row gets no `firm_id` claim and sees zero rows — RLS
fails closed. The hook is wired up in `config.toml` for local dev; on a hosted
project, enable it once under **Authentication → Hooks → Custom Access Token**.

**miiSpine staff** (the AR team) work the whole book, not one firm. `0007`
adds an `is_staff` flag: `assign_staff('ar@miispine.com')` gives a user a
cross-firm view (every firm-isolation policy is `is_staff() OR firm_id = claim`).
Per-firm attorney logins still work via `assign_user_to_firm` — the structure is
there to switch on attorney portals later.

## Importing the legacy spreadsheet

The old workbook is a set of worklist tabs (one row per case, attorney/carrier
as free text, PIP status and a single `Charges` figure — no line-item bills).
`0007` provides a `staging_import` landing table and `normalize_import()` that
turns those flat rows into the relational model, **deduped**, with junk routed
to a review flag instead of being coerced. All PHI stays on the box — it's a
local file → local/covered DB conversion, no third party.

```bash
# 1. Extract the workbook to a staging CSV (no npm deps; needs `unzip`)
node tools/import_from_xlsx.js Master_PI_AR_Sheet.xlsx > staging.csv

# 2. Load it and normalize (psql against your covered DB)
psql "$DATABASE_URL" -c "\copy staging_import(source_tab,source_row,patient_name,\
pip_claim,doi_raw,charges_raw,medical_insurance,lien_on_file,pip_payer,attorney,\
status_raw,last_action_raw,notes,voice_mail,assigned_to,faxed) \
from 'staging.csv' with (format csv, header true)"
psql "$DATABASE_URL" -c "select * from normalize_import();"

# 3. Reconcile before trusting it, then review flagged rows
psql "$DATABASE_URL" -c "select * from import_reconcile;"
psql "$DATABASE_URL" -c "select source_tab, patient_name, review_reason
  from staging_import where needs_review;"
```

**What it does:** splits `Last, First` names; converts Excel serial dates;
parses money; dedups firms by a normalized key (`Pittenger Law Office` ==
`Pittenger Law Office, PLLC`); collapses the same case appearing across tabs to
one (`patient` + `claim`); treats `Charges` as the miiSpine lien exposure when a
lien is on file; maps `Exhausted/Reserved/Open/PAID` to PIP + case status. The
triggers then populate the AR rollups and `collateral_calc`.

**On the de-identified reference file:** 308 data rows → **201 cases**, 171
clients, 81 firms; ~$939k billed / ~$575k outstanding (the raw row sum double-
counts, because cases repeat across tabs — dedup is the point). **24 rows
flagged** for human review (unrecognized status, missing attorney, single-token
names, unparseable charges). Two follow-ups the review pass owns, not the
importer: near-duplicate patients that carry different claim numbers, and firm
strings that bundle an individual attorney name (`Pittenger Law Office, PLLC -
Daniel Sullivan`) — the same firm, different attorney, which is where the
firm/attorney split gets untangled by hand.

## ModMed EMR sync (live, read-only)

The spreadsheet import above is the one-time cutover; the ongoing source of
truth is miiSpine's EMR, **ModMed**. Charges live on the Practice-Management
(PM) side and clinical notes on EMA. `0011_modmed_sync.sql` +
`supabase/functions/modmed-sync` pull the **AR side (charges + payments) live and
read-only** over ModMed's FHIR API, so the outstanding lien stops being a typed
figure and becomes reconciled from the billing system every night.

```
ModMed FHIR  ──GET ChargeItem / Invoice / PaymentReconciliation (paged)──┐
  (x-api-key + OAuth2 bearer, held only by the edge function)            │
                                                                         ▼
        emr_charge_staging / emr_payment_staging  ──reconcile_emr(run)──▶ medical_bills
                                                                         │  (dedup on
                                    lien + AR triggers recompute ◀───────┘   emr_charge_id)
```

**Why it's safe with live PHI:**

- The ModMed credentials — the `x-api-key` plus the OAuth2 password-grant that
  mints the bearer token — live **only in the `modmed-sync` function's secrets**.
  They never reach the browser and never leave the function. The function only
  ever **GET**s from ModMed (plus the token POST); it never writes to the EMR.
- Everything pulled lands in the **covered Supabase DB** (needs your Supabase
  BAA; ModMed is already your EMR business associate). No PHI is routed through
  Claude or any non-BAA'd service.
- The sync tables are **miiSpine-staff-only** under RLS; attorneys never see the
  EMR plumbing, only the reconciled bills on their own cases.

**How reconcile works (`reconcile_emr`):**

- **Charges → bills, idempotent.** Each ModMed `ChargeItem` (priced from the
  item or a matching `Invoice` line) upserts into `medical_bills` keyed on
  `emr_charge_id`, so re-running never duplicates. Charges whose EMR patient
  isn't linked to a case are left in staging flagged `unmatched_patient`.
- **Payments allocate as a waterfall.** Per case, the PIP and insurance totals
  are applied against the case's bills oldest-first (`min(billed, pot − billed
  before)`), then the existing lien trigger recomputes
  `max(0, billed − pip − insurance)` and the AR-rollup trigger updates the case
  totals. EMR-sourced payments are reset and re-applied each run, so it stays
  idempotent.
- Cases link to ModMed by `cases.emr_patient_id`; every run stamps
  `emr_last_synced_at` and logs to `emr_sync_run` (surfaced by the
  `emr_sync_status` view).

**Two mappings to tune against the real instance** (flagged in the code): payer
typing (PIP vs insurance) is a keyword match on the payer/coverage label because
generic FHIR doesn't label "PIP"; and payments allocate case-level totals across
bills rather than per-charge. If your ModMed exposes `ExplanationOfBenefit` with
per-line adjudication, that becomes the exact per-bill source and the waterfall
is the fallback. The pure mappers are unit-tested — run
`node supabase/functions/modmed-sync/fhir.test.mjs`.

```bash
# Deploy the read-only broker and set its secrets (server-side only)
supabase functions deploy modmed-sync --no-verify-jwt
supabase secrets set MODMED_BASE_URL=https://<env>.ema-api.com/ema-<stage>/firm/<prefix>/ema/fhir/v2
supabase secrets set MODMED_API_KEY=... MODMED_USERNAME=... MODMED_PASSWORD=...
supabase secrets set MODMED_DRY_RUN=true          # stage + report; flip to false to write bills

# Link a case to its ModMed patient, then run (dry-run first)
supabase db execute --sql "update cases set emr_patient_id='<PT-ID>' where id='<case>';"
supabase functions invoke modmed-sync            # or ?since=YYYY-MM-DD to narrow the window
supabase db execute --sql "select * from emr_sync_status limit 5;"
```

## Setup

```bash
# 1. Link the project (once)
supabase link --project-ref <your-ref>

# 2. Apply schema, RLS, views, triggers, then seed demo data
supabase db push
supabase db execute --file supabase/seed.sql   # optional demo data

# 3. Deploy the autopilot function
supabase functions deploy autopilot --no-verify-jwt

# 4. Set function secrets
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
supabase secrets set SENDGRID_API_KEY=SG....         # omit to run dry-run
supabase secrets set AUTOPILOT_DRY_RUN=true          # draft + log, don't send

# 5. Enable the nightly schedule (edit placeholders in 0005_cron.sql first)
supabase db execute --file supabase/migrations/0005_cron.sql

# 6. Enable the access-token hook (local dev picks it up from config.toml;
#    hosted projects: Dashboard → Authentication → Hooks → Custom Access Token
#    → public.custom_access_token_hook), then assign users to firms:
supabase db execute --sql "select public.assign_user_to_firm(
  'dana@morganhale.com', '11111111-1111-1111-1111-111111111111', 'admin');"
```

Copy `.env.example` → `.env` for local values. **The service-role key is
server-side only** — never ship it to the browser; the dashboard uses the anon
key under RLS.

## The dashboard

Open `app/index.html` directly and it renders against an embedded demo dataset
that mirrors `seed.sql` — no backend needed. Fill in `SUPABASE_URL` /
`SUPABASE_ANON_KEY` at the top of the inline `<script>` and it switches to the
live path:

- **AR Dashboard** reads the **`ar_aging`** view (server-computed age buckets).
- **Autopilot Queue** reads the **`autopilot_queue`** view (server-computed
  `priority_score` and ordering).
- **Cases** / detail read `cases` with embedded bills, PIP, milestones, firm and
  attorney, and compute the demand math client-side with the same formula as the
  SQL.

When a project is configured, the dashboard shows a **login screen**
(email+password or magic link, via Supabase Auth). After sign-in it reads under
RLS scoped to the user's `firm_id` claim — the header shows `Live · N cases`, and
a **Sign out** button appears. A signed-in user with no `firm_id` claim (no
`user_profiles` row) sees `Live · no cases for this firm`. If a view read fails,
that tab falls back to computing from the fetched cases; if the whole load fails,
the dashboard falls back to demo data. With no project configured it stays on the
embedded demo dataset and never prompts to sign in.

Five tabs:
- **AR Dashboard** — outstanding balances bucketed by case age (0–30 … 180+) per firm.
- **Cases** — every open case, balance, and miiSpine lien exposure; click for demand math.
- **Autopilot Queue** — tonight's outreach run, scored highest-priority first.
- **Needs Review** — cases the import flagged; the detail panel is a reconciliation
  surface (edit charges / PIP / insurance / collected, watch the outstanding lien
  recompute live, then **Mark resolved**). Writes back to Supabase in live mode.
- **Invoices** — collections invoices to the firm: issue from a case's outstanding
  lien, record payments, watch the status advance (draft → sent → partial → paid,
  or **overdue** past the due date), and print. The header badge counts overdue
  invoices. Writes back to Supabase in live mode.

## Autopilot follow-up engine

Each night the function pulls the top cases from `autopilot_queue`, gathers case
context, asks Claude to draft a short professional email to the attorney, sends
via SendGrid, logs to `outreach_log`, and reschedules `next_followup_at`.

Priority score (in the SQL view and mirrored in the dashboard):

```
priority = base(followup_priority)          -- urgent 100 / high 60 / normal 30 / low 10
         + min(days_since_last_outreach, 60) -- age factor, capped
         + balance_factor                    -- >$50k +30, >$20k +15
```

## Fixes applied to the original draft

- **Schema:** dropped the no-op `firm_id_rls GENERATED ALWAYS AS (firm_id)`
  column; made `audit_log.firm_id` `uuid` (was `text`); added FK / hot-path
  indexes; added `updated_at` triggers and AR-rollup triggers so the
  denormalized totals and `collateral_calc` can't drift.
- **RLS:** the draft only wrote one policy for `cases` with a "repeat for each
  table" comment — now every firm-scoped table (and the reference tables) has a
  real policy, keyed off a `firm_id` JWT claim.
- **Views:** `autopilot_queue` `COALESCE`s a never-contacted case's age so it
  doesn't produce a `NULL` priority score that hides the most-neglected cases;
  both views run `security_invoker` so RLS applies to portal reads.
- **Edge function:** current model id (`claude-sonnet-5`, thinking off / low
  effort for a fast bulk job); fixed the send gate (it checked
  `status !== "hold"`, but `status` is never `"hold"` — that's a
  `followup_priority`, already filtered by the view); robust JSON extraction,
  env-var validation, a `DRY_RUN` mode, and response-speed-adaptive cadence.

> Model identity is set per-run; the Claude model used for drafting is
> `claude-sonnet-5`. Swap it in `supabase/functions/autopilot/index.ts` if you
> want a different tier.
