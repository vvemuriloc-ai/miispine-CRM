-- ============================================================
-- miiCase / miiSpine AR — ModMed EMR live sync (read-only)
-- 0011_modmed_sync.sql
-- ============================================================
-- miiSpine's EMR is ModMed: charges live on the Practice-Management (PM) side,
-- clinical notes on EMA. This migration is the landing + reconciliation layer
-- for a READ-ONLY pull of AR data (charges + payments) over ModMed's FHIR API.
--
-- The edge function (supabase/functions/modmed-sync) authenticates to ModMed,
-- pages the FHIR resources, and writes the raw rows into the *_staging tables
-- below via the service role. reconcile_emr() then maps staging → medical_bills
-- (keyed by the EMR charge id, idempotent), allocates payments against the
-- case's bills, and lets the existing lien/AR triggers recompute. Nothing here
-- ever writes back to ModMed.
--
-- Two mappings are deliberately pragmatic and meant to be tuned to the real
-- instance (see README): payer typing (PIP vs insurance) and the fact that we
-- allocate case-level payment totals across the case's bills oldest-first
-- rather than per-charge. If ModMed exposes ExplanationOfBenefit with per-line
-- adjudication, that becomes the exact source and the waterfall is the fallback.
-- ============================================================

-- ---- EMR linkage on existing rows (idempotent upserts key off these) -------
alter table clients       add column if not exists emr_patient_id  text;
alter table cases         add column if not exists emr_patient_id  text;
alter table cases         add column if not exists emr_account_id  text;
alter table cases         add column if not exists emr_last_synced_at timestamptz;
alter table medical_bills add column if not exists emr_charge_id   text;
alter table medical_bills add column if not exists emr_source      text default 'manual'
                          check (emr_source in ('manual','modmed'));

-- A charge from ModMed appears once; nullable so manual bills stay null (many
-- NULLs are allowed in a unique constraint) and ON CONFLICT can dedup EMR bills.
create unique index if not exists uq_medical_bills_emr_charge
  on medical_bills(emr_charge_id) where emr_charge_id is not null;
create index if not exists idx_clients_emr_patient on clients(emr_patient_id);
create index if not exists idx_cases_emr_patient   on cases(emr_patient_id);

-- ---- Sync run log ----------------------------------------------------------
create table if not exists emr_sync_run (
  id             uuid primary key default gen_random_uuid(),
  kind           text default 'ar' check (kind in ('ar','records')),
  status         text default 'running'
                 check (status in ('running','ok','error','dry_run')),
  resources      text[],                 -- FHIR resource types pulled
  charges_seen   int default 0,
  payments_seen  int default 0,
  charges_upserted int default 0,
  cases_touched  int default 0,
  unmatched      int default 0,
  dry_run        boolean default false,
  error          text,
  started_at     timestamptz default now(),
  finished_at    timestamptz
);
create index if not exists idx_emr_sync_run_started on emr_sync_run(started_at desc);

-- ---- Raw charge staging (one row per ModMed ChargeItem/Invoice line) --------
create table if not exists emr_charge_staging (
  id              uuid primary key default gen_random_uuid(),
  sync_run_id     uuid references emr_sync_run(id) on delete cascade,
  emr_charge_id   text not null,
  emr_patient_id  text,
  cpt_code        text,
  description     text,
  billed_amount   numeric default 0,
  date_of_service date,
  status_raw      text,
  raw             jsonb,
  imported        boolean default false,
  review_reason   text,
  created_at      timestamptz default now()
);
create index if not exists idx_emr_charge_staging_run     on emr_charge_staging(sync_run_id);
create index if not exists idx_emr_charge_staging_patient on emr_charge_staging(emr_patient_id);

-- ---- Raw payment staging (one row per ModMed payment/adjudication) ----------
create table if not exists emr_payment_staging (
  id              uuid primary key default gen_random_uuid(),
  sync_run_id     uuid references emr_sync_run(id) on delete cascade,
  emr_payment_id  text not null,
  emr_charge_id   text,                   -- when the payment links to a charge
  emr_patient_id  text,
  amount          numeric default 0,
  payer_type      text default 'other' check (payer_type in ('pip','insurance','other')),
  payer_label     text,
  paid_on         date,
  raw             jsonb,
  imported        boolean default false,
  created_at      timestamptz default now()
);
create index if not exists idx_emr_payment_staging_run     on emr_payment_staging(sync_run_id);
create index if not exists idx_emr_payment_staging_patient on emr_payment_staging(emr_patient_id);

-- ---- Resolve (or create) the miiSpine provider row -------------------------
create or replace function emr_miispine_provider()
returns uuid language plpgsql as $$
declare v_id uuid;
begin
  select id into v_id from providers where is_miispine order by created_at limit 1;
  if v_id is null then
    insert into providers (name, type, is_miispine, emr_system)
    values ('miiSpine', 'spine_surgery', true, 'modmed')
    returning id into v_id;
  end if;
  return v_id;
end;
$$;

-- ---- Reconcile: staging -> medical_bills, then allocate payments -----------
-- Idempotent: bills dedup on emr_charge_id; EMR-sourced payments are reset and
-- re-allocated from the current staged totals on every run.
create or replace function reconcile_emr(p_run uuid)
returns table(charges_upserted int, cases_touched int, unmatched int)
language plpgsql as $$
declare
  v_provider uuid := emr_miispine_provider();
  v_upserted int := 0;
  v_unmatched int := 0;
begin
  -- 1. Upsert bills for charges whose EMR patient maps to a known case.
  with matched as (
    select s.*, c.id as case_id, c.firm_id
    from emr_charge_staging s
    join cases c on c.emr_patient_id = s.emr_patient_id
    where s.sync_run_id = p_run
  ), up as (
    insert into medical_bills
      (case_id, firm_id, provider_id, date_of_service, cpt_code, description,
       billed_amount, emr_charge_id, emr_source, bill_status)
    select case_id, firm_id, v_provider,
           coalesce(date_of_service, current_date), cpt_code, description,
           coalesce(billed_amount, 0), emr_charge_id, 'modmed', 'outstanding'
    from matched
    on conflict (emr_charge_id) where emr_charge_id is not null do update set
      billed_amount   = excluded.billed_amount,
      cpt_code        = excluded.cpt_code,
      description     = excluded.description,
      date_of_service = excluded.date_of_service,
      firm_id         = excluded.firm_id
    returning 1
  )
  select count(*) into v_upserted from up;

  -- Flag charges we could not place.
  update emr_charge_staging s set imported = true, review_reason = null
   where s.sync_run_id = p_run
     and exists (select 1 from cases c where c.emr_patient_id = s.emr_patient_id);
  update emr_charge_staging s set imported = false, review_reason = 'unmatched_patient'
   where s.sync_run_id = p_run
     and not exists (select 1 from cases c where c.emr_patient_id = s.emr_patient_id);

  -- Cases we touched this run (have at least one matched charge).
  create temporary table _emr_cases on commit drop as
    select distinct c.id as case_id
    from emr_charge_staging s join cases c on c.emr_patient_id = s.emr_patient_id
    where s.sync_run_id = p_run;

  -- 2. Reset EMR-sourced payments on those cases, then re-allocate the current
  --    staged totals oldest-first across each case's EMR bills.
  update medical_bills b set pip_paid = 0, insurance_paid = 0
   where b.emr_source = 'modmed' and b.case_id in (select case_id from _emr_cases);

  -- Case-level pot per payer type, from this run's payment staging.
  create temporary table _emr_pot on commit drop as
    select c.id as case_id,
           coalesce(sum(p.amount) filter (where p.payer_type = 'pip'), 0)       as pip_pot,
           coalesce(sum(p.amount) filter (where p.payer_type = 'insurance'), 0) as ins_pot
    from emr_payment_staging p
    join cases c on c.emr_patient_id = p.emr_patient_id
    where p.sync_run_id = p_run
    group by c.id;

  -- Waterfall allocation: each bill gets the pot minus everything billed before
  -- it (oldest DOS first), clamped to [0, billed_amount].
  with ranked as (
    select b.id, b.case_id, b.billed_amount,
           coalesce(sum(b.billed_amount) over (
             partition by b.case_id order by b.date_of_service, b.id
             rows between unbounded preceding and 1 preceding), 0) as prior
    from medical_bills b
    where b.emr_source = 'modmed' and b.case_id in (select case_id from _emr_cases)
  )
  update medical_bills b set
    pip_paid       = greatest(0, least(b.billed_amount, coalesce(pot.pip_pot,0) - r.prior)),
    insurance_paid = greatest(0, least(
                       b.billed_amount - greatest(0, least(b.billed_amount, coalesce(pot.pip_pot,0) - r.prior)),
                       coalesce(pot.ins_pot,0) - r.prior))
  from ranked r
  left join _emr_pot pot on pot.case_id = r.case_id
  where b.id = r.id;

  update emr_payment_staging p set imported = true
   where p.sync_run_id = p_run
     and exists (select 1 from cases c where c.emr_patient_id = p.emr_patient_id);

  -- 3. Stamp the sync time on touched cases.
  update cases c set emr_last_synced_at = now()
   where c.id in (select case_id from _emr_cases);

  select count(*)::int into v_unmatched
    from emr_charge_staging where sync_run_id = p_run and review_reason = 'unmatched_patient';

  charges_upserted := v_upserted;
  select count(*)::int into cases_touched from _emr_cases;
  unmatched := v_unmatched;
  return next;
end;
$$;

-- ---- RLS: EMR sync surfaces are miiSpine-staff-only -------------------------
-- (The edge function writes via the service role, which bypasses RLS. These
-- policies gate any authenticated read; attorneys never see EMR plumbing.)
alter table emr_sync_run        enable row level security;
alter table emr_charge_staging  enable row level security;
alter table emr_payment_staging enable row level security;

drop policy if exists emr_sync_run_staff on emr_sync_run;
create policy emr_sync_run_staff on emr_sync_run for all
  using (auth_is_staff()) with check (auth_is_staff());
drop policy if exists emr_charge_staging_staff on emr_charge_staging;
create policy emr_charge_staging_staff on emr_charge_staging for all
  using (auth_is_staff()) with check (auth_is_staff());
drop policy if exists emr_payment_staging_staff on emr_payment_staging;
create policy emr_payment_staging_staff on emr_payment_staging for all
  using (auth_is_staff()) with check (auth_is_staff());

-- ---- Status view for the dashboard -----------------------------------------
create or replace view emr_sync_status
with (security_invoker = on) as
select
  r.id, r.kind, r.status, r.resources,
  r.charges_seen, r.payments_seen, r.charges_upserted, r.cases_touched,
  r.unmatched, r.dry_run, r.error, r.started_at, r.finished_at,
  round(extract(epoch from (coalesce(r.finished_at, now()) - r.started_at)))::int as duration_s
from emr_sync_run r
order by r.started_at desc;
