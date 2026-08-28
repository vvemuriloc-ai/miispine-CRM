-- ============================================================
-- miiCase — merge duplicates from the dashboard (staff)
-- 0024_merge_from_app.sql
-- ============================================================
-- 0020's merge_cases() could only run as the DB owner from Cloud Shell.
-- Recreated SECURITY DEFINER with an in-function staff check, so the API
-- (miicase_app) can offer a Merge button to staff — moving a duplicate's
-- bills, records, invoices, outreach, and milestones onto the keeper and
-- closing the duplicate with an audit note. Never callable by firm users.

create or replace function merge_cases(p_keep uuid, p_dup uuid)
returns text language plpgsql security definer as $$
declare
  v_keep cases%rowtype;
  v_dup  cases%rowtype;
  n_bills int; n_recs int; n_inv int; n_out int; n_ms int;
begin
  -- Staff-only: jobs/owner sessions have no app.user_id and pass; an
  -- authenticated non-staff app session is rejected.
  if current_setting('app.user_id', true) is not null
     and current_setting('app.user_id', true) <> ''
     and not coalesce(current_setting('app.is_staff', true)::boolean, false) then
    raise exception 'staff only';
  end if;

  if p_keep = p_dup then raise exception 'keep and dup are the same case'; end if;
  select * into v_keep from cases where id = p_keep;
  if not found then raise exception 'keep case % not found', p_keep; end if;
  select * into v_dup from cases where id = p_dup;
  if not found then raise exception 'dup case % not found', p_dup; end if;

  update medical_bills set case_id = p_keep, firm_id = v_keep.firm_id where case_id = p_dup;
  get diagnostics n_bills = row_count;
  update records set case_id = p_keep, firm_id = v_keep.firm_id where case_id = p_dup;
  get diagnostics n_recs = row_count;
  update invoices set case_id = p_keep, firm_id = v_keep.firm_id where case_id = p_dup;
  get diagnostics n_inv = row_count;
  update outreach_log set case_id = p_keep, firm_id = v_keep.firm_id where case_id = p_dup;
  get diagnostics n_out = row_count;
  update milestones set case_id = p_keep where case_id = p_dup;
  get diagnostics n_ms = row_count;

  update cases set
    emr_patient_id    = coalesce(cases.emr_patient_id, v_dup.emr_patient_id),
    date_of_injury    = coalesce(cases.date_of_injury, v_dup.date_of_injury),
    claim_number      = coalesce(nullif(cases.claim_number, ''), v_dup.claim_number),
    liability_carrier = coalesce(nullif(cases.liability_carrier, ''), v_dup.liability_carrier),
    health_insurance  = coalesce(nullif(cases.health_insurance, ''), v_dup.health_insurance),
    notes             = nullif(concat_ws(' | ', cases.notes, v_dup.notes), '')
  where id = p_keep;

  update cases set
    status = 'closed',
    emr_patient_id = null,
    notes = nullif(concat_ws(' | ', cases.notes, 'MERGED into case ' || p_keep::text || ' on ' || current_date), '')
  where id = p_dup;
  delete from pip_ledger where case_id = p_dup;

  return format('merged: %s bills, %s records, %s invoices, %s outreach, %s milestones moved; duplicate closed',
                n_bills, n_recs, n_inv, n_out, n_ms);
end;
$$;

grant execute on function merge_cases(uuid, uuid) to miicase_app;
