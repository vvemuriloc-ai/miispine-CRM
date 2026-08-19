-- ============================================================
-- miiCase — ModMed PM reality: ChargeItem + Account only
-- 0014_pm_balance.sql
-- ============================================================
-- ModMed confirmed their API exposes Account and ChargeItem, and none of the
-- FHIR payment resources (Invoice/Claim/PaymentReconciliation/EOB). So:
--   * Charges sync stays (idempotent upsert on emr_charge_id).
--   * Payments are reconciled MANUALLY in the app — reconcile_emr() must no
--     longer reset pip/insurance on EMR bills unless payments were actually
--     staged for that case this run (none will be, until ModMed ever ships a
--     payment resource). Without this gate, the nightly sync would wipe staff's
--     manual reconciliation.
--   * NEW: the PM-side patient balance from Account lands on the case
--     (emr_pm_balance) as an automatic drift detector next to our number.
-- ============================================================

alter table cases add column if not exists emr_pm_balance    numeric;
alter table cases add column if not exists emr_pm_balance_at timestamptz;

alter table emr_sync_run add column if not exists accounts_seen    int default 0;
alter table emr_sync_run add column if not exists balances_applied int default 0;

-- Re-issue reconcile_emr with the per-case payment gate.
create or replace function reconcile_emr(p_run uuid)
returns table(charges_upserted int, cases_touched int, unmatched int)
language plpgsql as $$
declare
  v_provider uuid := emr_miispine_provider();
  v_upserted int := 0;
  v_unmatched int := 0;
begin
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

  update emr_charge_staging s set imported = true, review_reason = null
   where s.sync_run_id = p_run
     and exists (select 1 from cases c where c.emr_patient_id = s.emr_patient_id);
  update emr_charge_staging s set imported = false, review_reason = 'unmatched_patient'
   where s.sync_run_id = p_run
     and not exists (select 1 from cases c where c.emr_patient_id = s.emr_patient_id);

  create temporary table _emr_cases on commit drop as
    select distinct c.id as case_id
    from emr_charge_staging s join cases c on c.emr_patient_id = s.emr_patient_id
    where s.sync_run_id = p_run;

  -- Payment pots per case, from THIS run's staging. With ModMed shipping no
  -- payment resources this is empty, and the reset/waterfall below touches
  -- nothing — manual reconciliation in the app is preserved.
  create temporary table _emr_pot on commit drop as
    select c.id as case_id,
           coalesce(sum(p.amount) filter (where p.payer_type = 'pip'), 0)       as pip_pot,
           coalesce(sum(p.amount) filter (where p.payer_type = 'insurance'), 0) as ins_pot
    from emr_payment_staging p
    join cases c on c.emr_patient_id = p.emr_patient_id
    where p.sync_run_id = p_run
    group by c.id;

  -- Reset + waterfall ONLY for cases with staged payments this run.
  update medical_bills b set pip_paid = 0, insurance_paid = 0
   where b.emr_source = 'modmed' and b.case_id in (select case_id from _emr_pot);

  with ranked as (
    select b.id, b.case_id, b.billed_amount,
           coalesce(sum(b.billed_amount) over (
             partition by b.case_id order by b.date_of_service, b.id
             rows between unbounded preceding and 1 preceding), 0) as prior
    from medical_bills b
    where b.emr_source = 'modmed' and b.case_id in (select case_id from _emr_pot)
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
