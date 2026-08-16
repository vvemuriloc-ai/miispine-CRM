-- ============================================================
-- miiCase / miiSpine AR — Core schema
-- 0001_schema.sql : tables, generated columns, immutable audit log
-- ============================================================
-- Notes on changes from the original draft:
--   * Dropped the pointless `firm_id_rls GENERATED ALWAYS AS (firm_id)` column
--     on `cases` — RLS can reference `firm_id` directly.
--   * `audit_log.firm_id` is uuid (was text) for consistency with every other
--     firm reference in the schema.
--   * Added indexes on foreign keys and hot autopilot / dashboard query paths.
-- RLS policies live in 0002_rls.sql, views in 0003_views.sql, triggers in
-- 0004_triggers.sql.
-- ============================================================

create extension if not exists "pgcrypto";  -- gen_random_uuid()

-- FIRMS (attorney firms with portal access)
create table if not exists firms (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  phone         text,
  email         text,
  address       text,
  created_at    timestamptz default now()
);

-- ATTORNEYS (individual users within a firm)
create table if not exists attorneys (
  id            uuid primary key default gen_random_uuid(),
  firm_id       uuid references firms(id),
  name          text not null,
  email         text unique not null,
  phone         text,
  -- Responsiveness profile (built by autopilot over time)
  avg_response_days   numeric,
  voicemail_rate      numeric,
  preferred_contact   text default 'email'
                      check (preferred_contact in ('email','phone','fax')),
  created_at    timestamptz default now()
);

-- CLIENTS (PI patients)
create table if not exists clients (
  id            uuid primary key default gen_random_uuid(),
  first_name    text not null,
  last_name     text not null,
  dob           date,
  phone         text,
  email         text,
  hipaa_release_on_file boolean default false,
  created_at    timestamptz default now()
);

-- CASES (one row per PI case — the central record)
create table if not exists cases (
  id                uuid primary key default gen_random_uuid(),
  firm_id           uuid references firms(id) not null,
  attorney_id       uuid references attorneys(id),
  client_id         uuid references clients(id) not null,
  -- Identifiers
  claim_number      text,
  date_of_loss      date,
  date_of_injury    date,
  accident_type     text,            -- MVA | slip-fall | workplace | other
  liability_carrier text,
  -- Status lifecycle
  status            text default 'active'
                    check (status in (
                      'active','treatment_complete','mmi_reached',
                      'demand_sent','negotiating','settled','closed','disputed'
                    )),
  -- Key dates
  opened_at         date default current_date,
  mmi_date          date,
  demand_sent_date  date,
  settlement_date   date,
  target_close_date date,
  -- AR summary (denormalized for fast dashboard queries; kept in sync by triggers)
  total_billed        numeric default 0,
  total_pip_paid      numeric default 0,
  total_lien          numeric default 0,
  total_collected     numeric default 0,
  balance_outstanding numeric generated always as
                      (total_lien - total_collected) stored,
  -- Autopilot fields
  last_outreach_at  timestamptz,
  next_followup_at  timestamptz,
  followup_priority text default 'normal'
                    check (followup_priority in ('urgent','high','normal','low','hold')),
  -- Metadata
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

-- PIP LEDGER (one per case — tracks PIP availability)
create table if not exists pip_ledger (
  id              uuid primary key default gen_random_uuid(),
  case_id         uuid references cases(id) unique not null,
  firm_id         uuid references firms(id) not null,     -- for RLS
  carrier         text,
  claim_number    text,
  total_available numeric default 10000,   -- KY standard $10K
  total_submitted numeric default 0,
  total_paid      numeric default 0,
  total_pending   numeric default 0,
  balance_remaining numeric generated always as
                  (total_available - total_paid) stored,
  status          text default 'open'
                  check (status in ('open','reserved','exhausted','closed')),
  exhaustion_date date,
  -- Post-July 2026 HB 627 fields
  hb627_applies   boolean default true,
  wc_fee_schedule_rate numeric,            -- capped rate under new law
  updated_at      timestamptz default now()
);

-- PROVIDERS (any treating provider across a case)
create table if not exists providers (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  type          text check (type in (
                  'spine_surgery','pain_mgmt','orthopedic',
                  'chiropractic','PT','ER','imaging',
                  'neurology','other'
                )),
  npi           text,
  phone         text,
  fax           text,
  email         text,
  is_miispine   boolean default false,     -- miiSpine gets deep integration
  emr_system    text,                      -- 'modmed' | 'epic' | 'manual'
  created_at    timestamptz default now()
);

-- MEDICAL BILLS (all providers, all dates — the financial record)
create table if not exists medical_bills (
  id              uuid primary key default gen_random_uuid(),
  case_id         uuid references cases(id) not null,
  firm_id         uuid references firms(id) not null,     -- for RLS
  provider_id     uuid references providers(id) not null,
  date_of_service date not null,
  cpt_code        text,
  description     text,
  billed_amount   numeric not null default 0,
  -- Payment breakdown
  pip_submitted   numeric default 0,
  pip_paid        numeric default 0,
  insurance_paid  numeric default 0,
  -- Lien
  lien_amount     numeric default 0,
  lien_type       text check (lien_type in ('surgical','conservative','imaging','other')),
  lien_tier       text,                    -- 'tier_1' | 'tier_2' | 'tier_3' for reduction schedule
  -- Settlement
  negotiated_amount numeric,
  collected_amount  numeric default 0,
  collected_date    date,
  -- Status
  bill_status     text default 'outstanding'
                  check (bill_status in (
                    'outstanding','pip_pending','pip_paid',
                    'lien_active','negotiating','settled','written_off'
                  )),
  created_at      timestamptz default now()
);

-- RECORDS (status tracking for all medical records across providers)
create table if not exists records (
  id              uuid primary key default gen_random_uuid(),
  case_id         uuid references cases(id) not null,
  firm_id         uuid references firms(id) not null,
  provider_id     uuid references providers(id) not null,
  record_type     text check (record_type in (
                    'initial_eval','op_report','imaging','progress_notes',
                    'discharge','mmi_letter','outcome_scores','other'
                  )),
  status          text default 'pending'
                  check (status in ('pending','requested','received','uploaded')),
  requested_date  date,
  received_date   date,
  -- Document (signed URL delivery — no raw PHI in DB)
  storage_key     text,                    -- S3 / Supabase Storage path
  signed_url_expires_at timestamptz,
  created_at      timestamptz default now()
);

-- MILESTONES (treatment arc per case)
create table if not exists milestones (
  id              uuid primary key default gen_random_uuid(),
  case_id         uuid references cases(id) not null,
  firm_id         uuid references firms(id) not null,
  milestone_type  text check (milestone_type in (
                    'initial_eval','imaging_complete','injection',
                    'surgery','post_op','mmi','outcome_score',
                    'demand_ready','settlement_ready'
                  )),
  planned_date    date,
  actual_date     date,
  notes           text,
  created_at      timestamptz default now()
);

-- SETTLEMENT EVENTS (demand, offers, counters, agreement)
create table if not exists settlement_events (
  id              uuid primary key default gen_random_uuid(),
  case_id         uuid references cases(id) not null,
  firm_id         uuid references firms(id) not null,
  event_type      text check (event_type in (
                    'demand_sent','offer_received','counter_sent',
                    'mediation','agreement','disbursement'
                  )),
  amount          numeric,
  event_date      date not null,
  notes           text,
  created_at      timestamptz default now()
);

-- DEADLINES (SOL, response, mediation)
create table if not exists deadlines (
  id              uuid primary key default gen_random_uuid(),
  case_id         uuid references cases(id) not null,
  firm_id         uuid references firms(id) not null,
  deadline_type   text check (deadline_type in (
                    'statute_of_limitations','pip_180_day',
                    'demand_response','mediation','other'
                  )),
  deadline_date   date not null,
  alert_days_before int default 14,
  status          text default 'active'
                  check (status in ('active','met','missed','extended')),
  created_at      timestamptz default now()
);

-- OUTREACH LOG (every attorney communication — autopilot + manual)
create table if not exists outreach_log (
  id              uuid primary key default gen_random_uuid(),
  case_id         uuid references cases(id) not null,
  firm_id         uuid references firms(id) not null,
  attorney_id     uuid references attorneys(id),
  channel         text check (channel in ('email','phone','fax','portal_alert')),
  direction       text check (direction in ('outbound','inbound')),
  subject         text,
  body            text,
  -- Autopilot fields
  ai_generated    boolean default false,
  sent_by         text,                    -- 'autopilot' | staff name
  sent_at         timestamptz,
  response_received_at timestamptz,
  outcome         text,                    -- 'no_response','update_received','payment_promised','paid'
  created_at      timestamptz default now()
);

-- DEMAND DRAFTS (AI-generated demand letters, versioned)
create table if not exists demand_drafts (
  id              uuid primary key default gen_random_uuid(),
  case_id         uuid references cases(id) not null,
  firm_id         uuid references firms(id) not null,
  version         int default 1,
  status          text default 'draft'
                  check (status in ('draft','reviewed','sent','superseded')),
  total_specials  numeric,                 -- auto-calculated from medical_bills
  demand_amount   numeric,                 -- attorney sets this
  ai_body         text,                    -- Claude-generated narrative
  attorney_edits  text,                    -- attorney's version
  sent_date       date,
  created_at      timestamptz default now()
);

-- COLLATERAL CALC (live demand math snapshot)
create table if not exists collateral_calc (
  id              uuid primary key default gen_random_uuid(),
  case_id         uuid references cases(id) unique not null,
  firm_id         uuid references firms(id) not null,
  total_bills     numeric default 0,       -- sum of all medical_bills.billed_amount
  pip_paid        numeric default 0,       -- from pip_ledger
  insurance_paid  numeric default 0,       -- sum of insurance_paid on bills
  collateral_deduction numeric default 0,  -- pip + insurance paid
  net_specials    numeric generated always as
                  (total_bills - collateral_deduction) stored,
  miispine_lien   numeric default 0,
  miispine_reduced numeric default 0,      -- after tiered reduction
  other_liens     numeric default 0,
  total_liens     numeric generated always as
                  (miispine_reduced + other_liens) stored,
  last_calculated_at timestamptz default now()
);

-- AUDIT LOG (every PHI access — immutable, 6yr retention)
create table if not exists audit_log (
  id          uuid default gen_random_uuid() primary key,
  user_id     text not null,              -- Firebase UID (string)
  firm_id     uuid not null,
  action      text not null,
  resource_type text,                      -- 'case' | 'pip_ledger' | 'record' | etc
  resource_id uuid,
  ip_address  inet,
  user_agent  text,
  created_at  timestamptz default now()
);

-- Make audit rows immutable
drop rule if exists no_update_audit on audit_log;
drop rule if exists no_delete_audit on audit_log;
create rule no_update_audit as on update to audit_log do instead nothing;
create rule no_delete_audit as on delete to audit_log do instead nothing;

-- ============================================================
-- INDEXES — foreign keys + hot autopilot / dashboard paths
-- ============================================================
create index if not exists idx_attorneys_firm            on attorneys(firm_id);
create index if not exists idx_cases_firm                on cases(firm_id);
create index if not exists idx_cases_attorney            on cases(attorney_id);
create index if not exists idx_cases_client              on cases(client_id);
create index if not exists idx_cases_status              on cases(status);
create index if not exists idx_cases_next_followup       on cases(next_followup_at);
create index if not exists idx_cases_followup_priority   on cases(followup_priority);
create index if not exists idx_pip_ledger_firm           on pip_ledger(firm_id);
create index if not exists idx_medical_bills_case        on medical_bills(case_id);
create index if not exists idx_medical_bills_firm        on medical_bills(firm_id);
create index if not exists idx_medical_bills_provider    on medical_bills(provider_id);
create index if not exists idx_records_case              on records(case_id);
create index if not exists idx_records_firm              on records(firm_id);
create index if not exists idx_milestones_case           on milestones(case_id);
create index if not exists idx_milestones_firm           on milestones(firm_id);
create index if not exists idx_settlement_events_case    on settlement_events(case_id);
create index if not exists idx_settlement_events_firm    on settlement_events(firm_id);
create index if not exists idx_deadlines_case            on deadlines(case_id);
create index if not exists idx_deadlines_firm            on deadlines(firm_id);
create index if not exists idx_deadlines_date            on deadlines(deadline_date);
create index if not exists idx_outreach_log_case         on outreach_log(case_id);
create index if not exists idx_outreach_log_firm         on outreach_log(firm_id);
create index if not exists idx_demand_drafts_case        on demand_drafts(case_id);
create index if not exists idx_demand_drafts_firm        on demand_drafts(firm_id);
create index if not exists idx_collateral_calc_firm      on collateral_calc(firm_id);
create index if not exists idx_audit_log_firm            on audit_log(firm_id);
create index if not exists idx_audit_log_resource        on audit_log(resource_type, resource_id);
