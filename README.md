# miiCase / miiSpine AR

An accounts-receivable engine, attorney-outreach **Autopilot**, and demand-math
dashboard for personal-injury cases at miiSpine (a Louisville, KY spine surgery
practice). Built on **Supabase** (Postgres + RLS + Edge Functions) with a
self-contained, branded web dashboard.

```
┌─────────────────────────────────────────────────────────────┐
│  app/index.html   ── branded single-file dashboard (Supabase JS)
│        │  reads ar_aging / autopilot_queue / cases (RLS)
│        ▼
│  Postgres  ── 15 tables · firm-isolation RLS · AR rollup triggers
│        ▲
│        │  service_role (bypasses RLS)
│  supabase/functions/autopilot  ── nightly: score → draft (Claude) →
│                                    send (SendGrid) → log → reschedule
│        ▲
│  pg_cron 06:00 UTC nightly (0005_cron.sql)
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
| `supabase/seed.sql` | Demo dataset (2 firms, 6 cases, bills, PIP, milestones) |
| `supabase/functions/autopilot/index.ts` | The nightly follow-up engine |
| `app/index.html` | The AR dashboard (demo-data fallback, no build step) |
| `index.html` | The original miiSpine **outreach** CRM (Google Sheets prospecting) |

## Data model highlights

- **`cases`** is the central record. `balance_outstanding` is a stored generated
  column (`total_lien - total_collected`); the other AR totals are denormalized
  for fast dashboards and kept in sync by triggers from `medical_bills`.
- **`collateral_calc`** is a live demand-math snapshot (net specials, tiered
  miiSpine lien, other liens) refreshed automatically on any bill change.
- **`pip_ledger`** tracks Kentucky $10K PIP availability, incl. post-July-2026
  HB 627 fields.
- **`audit_log`** is append-only — `ON UPDATE/DELETE DO INSTEAD NOTHING` rules
  make PHI-access rows immutable for the 6-year retention requirement.

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

Three tabs:
- **AR Dashboard** — outstanding balances bucketed by case age (0–30 … 180+) per firm.
- **Cases** — every open case, balance, and miiSpine lien exposure; click for demand math.
- **Autopilot Queue** — tonight's outreach run, scored highest-priority first.

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
