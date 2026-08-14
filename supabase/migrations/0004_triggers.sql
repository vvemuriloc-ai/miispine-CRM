-- ============================================================
-- miiCase / miiSpine AR — Triggers
-- 0004_triggers.sql : updated_at stamps + denormalized AR rollups
-- ============================================================
-- The `cases` AR summary columns and the `collateral_calc` snapshot are
-- denormalized for fast dashboard reads. Rather than trust callers to keep
-- them in sync, we recompute them from `medical_bills` (and `pip_ledger`)
-- whenever the underlying rows change.
-- ============================================================

-- ------------------------------------------------------------
-- updated_at auto-stamp
-- ------------------------------------------------------------
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_cases_updated_at on cases;
create trigger trg_cases_updated_at
  before update on cases
  for each row execute function set_updated_at();

drop trigger if exists trg_pip_ledger_updated_at on pip_ledger;
create trigger trg_pip_ledger_updated_at
  before update on pip_ledger
  for each row execute function set_updated_at();

-- ------------------------------------------------------------
-- Recompute the AR rollup for a single case
-- ------------------------------------------------------------
create or replace function recompute_case_ar(p_case_id uuid)
returns void
language plpgsql
as $$
declare
  v_firm_id        uuid;
  v_total_billed   numeric;
  v_total_pip_paid numeric;
  v_total_lien     numeric;
  v_total_collected numeric;
  v_insurance_paid numeric;
  v_pip_paid       numeric;
begin
  select firm_id into v_firm_id from cases where id = p_case_id;
  if v_firm_id is null then
    return;  -- case was deleted
  end if;

  select
    coalesce(sum(billed_amount), 0),
    coalesce(sum(pip_paid), 0),
    coalesce(sum(lien_amount), 0),
    coalesce(sum(collected_amount), 0),
    coalesce(sum(insurance_paid), 0)
  into v_total_billed, v_total_pip_paid, v_total_lien, v_total_collected, v_insurance_paid
  from medical_bills
  where case_id = p_case_id;

  update cases
     set total_billed    = v_total_billed,
         total_pip_paid  = v_total_pip_paid,
         total_lien      = v_total_lien,
         total_collected = v_total_collected
   where id = p_case_id;

  -- pip_ledger.total_paid is the authoritative PIP figure when present.
  select coalesce(total_paid, v_total_pip_paid) into v_pip_paid
  from pip_ledger where case_id = p_case_id;
  v_pip_paid := coalesce(v_pip_paid, v_total_pip_paid);

  -- Upsert the collateral_calc snapshot.
  insert into collateral_calc as cc (
    case_id, firm_id, total_bills, pip_paid, insurance_paid,
    collateral_deduction, other_liens, last_calculated_at
  )
  values (
    p_case_id, v_firm_id, v_total_billed, v_pip_paid, v_insurance_paid,
    v_pip_paid + v_insurance_paid, 0, now()
  )
  on conflict (case_id) do update
    set firm_id              = excluded.firm_id,
        total_bills          = excluded.total_bills,
        pip_paid             = excluded.pip_paid,
        insurance_paid       = excluded.insurance_paid,
        collateral_deduction = excluded.collateral_deduction,
        last_calculated_at   = now();
end;
$$;

-- ------------------------------------------------------------
-- Trigger: recompute on any medical_bills change
-- ------------------------------------------------------------
create or replace function trg_medical_bills_ar()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    perform recompute_case_ar(old.case_id);
    return old;
  end if;
  perform recompute_case_ar(new.case_id);
  -- A bill that moved between cases needs both recomputed.
  if tg_op = 'UPDATE' and new.case_id is distinct from old.case_id then
    perform recompute_case_ar(old.case_id);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_medical_bills_ar on medical_bills;
create trigger trg_medical_bills_ar
  after insert or update or delete on medical_bills
  for each row execute function trg_medical_bills_ar();

-- ------------------------------------------------------------
-- Trigger: PIP payments feed the collateral snapshot too
-- ------------------------------------------------------------
create or replace function trg_pip_ledger_ar()
returns trigger
language plpgsql
as $$
begin
  perform recompute_case_ar(new.case_id);
  return new;
end;
$$;

drop trigger if exists trg_pip_ledger_ar on pip_ledger;
create trigger trg_pip_ledger_ar
  after insert or update on pip_ledger
  for each row execute function trg_pip_ledger_ar();
