-- ============================================================
-- miiCase / miiSpine AR — Lien reconciliation model + review flags
-- 0008_lien_reconciliation.sql
-- ============================================================
-- Corrects what a "lien" means: it is the charges still OUTSTANDING after
-- payments are reconciled — including PIP. So the outstanding lien on a bill is
--     lien_amount = max(0, billed_amount − pip_paid − insurance_paid)
-- maintained automatically, and balance_outstanding (= total_lien −
-- total_collected) then reflects what miiSpine is truly still owed after PIP,
-- health insurance, and any settlement collections.
--
-- A negotiated / manually-set lien can opt out of the formula with
-- lien_manual = true (e.g. a reduced lien agreed with the attorney).
-- ============================================================

alter table medical_bills add column if not exists lien_manual boolean default false;

-- Case-level review workflow (fed by the importer, cleared in the UI).
alter table cases add column if not exists review_status text default 'ok';
alter table cases drop constraint if exists cases_review_status_chk;
alter table cases add constraint cases_review_status_chk
  check (review_status in ('ok','needs_review','resolved'));
alter table cases add column if not exists review_reason text;

-- ---- Derive the outstanding lien from billed − PIP − insurance ----
create or replace function recompute_bill_lien()
returns trigger language plpgsql as $$
begin
  if not coalesce(new.lien_manual, false) then
    new.lien_amount := greatest(0,
      coalesce(new.billed_amount, 0) - coalesce(new.pip_paid, 0) - coalesce(new.insurance_paid, 0));
  end if;
  return new;
end;
$$;

drop trigger if exists trg_recompute_bill_lien on medical_bills;
create trigger trg_recompute_bill_lien
  before insert or update on medical_bills
  for each row execute function recompute_bill_lien();

-- Recompute any bills already loaded (no-op on a fresh DB; the trigger fires).
update medical_bills set lien_amount = lien_amount where not coalesce(lien_manual, false);

-- ============================================================
-- Corrected importer: outstanding lien is derived (not charges), payments start
-- unreconciled (PIP/insurance = 0), and the case carries its review status.
-- Reconciliation happens in the app, where staff enter the real PIP/insurance
-- figures and the outstanding lien recomputes.
-- ============================================================
create or replace function normalize_import()
returns table(cases_created int, firms_total int, rows_flagged int)
language plpgsql as $$
declare
  v_prov uuid; rec record;
  v_firm uuid; v_client uuid; v_case uuid;
  v_first text; v_last text; v_charges numeric; v_lien boolean;
  v_doi date; v_las date; v_pip text; v_paid boolean;
  v_review boolean; v_reason text;
  n_imp int := 0; n_rev int := 0;
begin
  insert into providers(name, type, is_miispine, emr_system)
    values ('miiSpine Surgery Center', 'spine_surgery', true, 'modmed')
    on conflict (lower(name)) do nothing;
  select id into v_prov from providers where lower(name) = 'miispine surgery center' limit 1;

  insert into firms(name)
    select distinct on (import_firm_key(attorney)) import_firm_display(attorney)
    from staging_import
    where import_firm_display(attorney) is not null
    order by import_firm_key(attorney)
    on conflict (import_firm_key(name)) do nothing;
  insert into firms(name) values ('Unassigned (import)')
    on conflict (import_firm_key(name)) do nothing;

  for rec in
    select distinct on (lower(trim(patient_name)), coalesce(nullif(lower(trim(pip_claim)), ''), '~n~')) *
    from staging_import
    where coalesce(trim(patient_name), '') <> ''
    order by lower(trim(patient_name)),
             coalesce(nullif(lower(trim(pip_claim)), ''), '~n~'),
             import_is_paid(status_raw) desc,
             import_parse_date(last_action_raw) desc nulls last, id
  loop
    v_review := false; v_reason := '';
    v_last  := trim(split_part(rec.patient_name, ',', 1));
    v_first := nullif(trim(split_part(rec.patient_name, ',', 2)), '');
    if v_first is null then v_review := true; v_reason := v_reason || 'no-comma-name; '; v_first := ''; end if;

    v_charges := import_parse_money(rec.charges_raw);
    if v_charges is null then v_review := true; v_reason := v_reason || 'charges-unparsed; '; v_charges := 0; end if;

    v_lien := import_lien(rec.lien_on_file);
    v_doi  := import_parse_date(rec.doi_raw);
    v_las  := import_parse_date(rec.last_action_raw);
    v_pip  := import_pip_status(rec.status_raw);
    if v_pip is null then v_review := true; v_reason := v_reason || 'status-unrecognized; '; v_pip := 'open'; end if;
    v_paid := import_is_paid(rec.status_raw);

    if import_firm_display(rec.attorney) is null then
      v_review := true; v_reason := v_reason || 'no-attorney; ';
      select id into v_firm from firms where import_firm_key(name) = import_firm_key('Unassigned (import)') limit 1;
    else
      select id into v_firm from firms where import_firm_key(name) = import_firm_key(rec.attorney) limit 1;
    end if;

    select id into v_client from clients
      where lower(last_name) = lower(v_last)
        and lower(coalesce(first_name, '')) = lower(coalesce(v_first, '')) limit 1;
    if v_client is null then
      insert into clients(first_name, last_name) values (coalesce(v_first, ''), v_last) returning id into v_client;
    end if;

    select id into v_case from cases
      where client_id = v_client
        and coalesce(claim_number, '') = coalesce(nullif(trim(rec.pip_claim), ''), '')
        and firm_id = v_firm limit 1;

    if v_case is null then
      insert into cases(firm_id, client_id, claim_number, date_of_injury, liability_carrier,
                        status, opened_at, last_outreach_at, followup_priority,
                        assigned_to, notes, health_insurance, review_status, review_reason)
        values (v_firm, v_client, nullif(trim(rec.pip_claim), ''), v_doi, nullif(trim(rec.pip_payer), ''),
                case when v_paid then 'settled' else 'active' end,
                coalesce(v_doi, v_las, current_date), v_las::timestamptz, 'normal',
                nullif(trim(rec.assigned_to), ''), nullif(trim(rec.notes), ''), nullif(trim(rec.medical_insurance), ''),
                case when v_review then 'needs_review' else 'ok' end, nullif(v_reason, ''))
        returning id into v_case;

      insert into pip_ledger(case_id, firm_id, carrier, claim_number, status, total_available, total_paid)
        values (v_case, v_firm, nullif(trim(rec.pip_payer), ''), nullif(trim(rec.pip_claim), ''),
                case when v_paid then 'closed' else v_pip end,
                10000, case when v_pip = 'exhausted' then 10000 else 0 end)
        on conflict (case_id) do nothing;

      -- Charges are GROSS. PIP/insurance start unreconciled (0), so the derived
      -- outstanding lien = charges until staff reconcile payments in the app.
      -- lien_type flags that a lien is on file; the dollar amount is derived.
      insert into medical_bills(case_id, firm_id, provider_id, date_of_service, description,
                               billed_amount, pip_paid, insurance_paid, lien_type,
                               collected_amount, bill_status)
        values (v_case, v_firm, v_prov, coalesce(v_doi, v_las, current_date), 'Imported aggregate charges',
                v_charges, 0, 0,
                case when coalesce(v_lien, false) then 'other' else null end,
                case when v_paid then v_charges else 0 end,
                case when v_paid then 'settled'
                     when coalesce(v_lien, false) then 'lien_active' else 'outstanding' end);

      if nullif(trim(rec.notes), '') is not null then
        insert into outreach_log(case_id, firm_id, channel, direction, body, ai_generated, sent_by, sent_at)
          values (v_case, v_firm, 'portal_alert', 'outbound', rec.notes, false,
                  nullif(trim(rec.assigned_to), ''), v_las::timestamptz);
      end if;

      n_imp := n_imp + 1;
    end if;

    if v_review then n_rev := n_rev + 1; end if;
    update staging_import set imported_case_id = v_case, needs_review = v_review,
                              review_reason = nullif(v_reason, '') where id = rec.id;
  end loop;

  return query select n_imp, (select count(*)::int from firms), n_rev;
end;
$$;

-- Cases needing attention, for the app's Needs-Review screen (RLS-scoped).
create or replace view review_queue
with (security_invoker = on) as
select
  c.id, c.firm_id, c.review_status, c.review_reason,
  cl.first_name, cl.last_name,
  f.name as firm_name,
  c.claim_number, c.status, c.liability_carrier, c.assigned_to,
  c.total_billed, c.total_pip_paid, c.balance_outstanding
from cases c
join clients cl on cl.id = c.client_id
join firms f   on f.id = c.firm_id
where c.review_status = 'needs_review';
