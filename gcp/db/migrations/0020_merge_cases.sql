-- ============================================================
-- miiCase — merge duplicate cases
-- 0020_merge_cases.sql
-- ============================================================
-- The workbook import created a second case for some patients (same person
-- listed on two tabs). merge_cases(keep, dup) consolidates: bills, records,
-- invoices, outreach history, and milestones move to the keep case; missing
-- linkage fields (ModMed patient id, DOI, claim #, carrier) copy over when
-- the keep case lacks them; the duplicate is closed and annotated — never
-- deleted, per the retention posture.
--
--   bash gcp/db/query.sh "select merge_cases('<keep-uuid>', '<dup-uuid>');"

create or replace function merge_cases(p_keep uuid, p_dup uuid)
returns text language plpgsql as $$
declare
  v_keep cases%rowtype;
  v_dup  cases%rowtype;
  n_bills int; n_recs int; n_inv int; n_out int; n_ms int;
begin
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

  -- Fill gaps on the keep case from the duplicate (never overwrite).
  update cases set
    emr_patient_id    = coalesce(cases.emr_patient_id, v_dup.emr_patient_id),
    date_of_injury    = coalesce(cases.date_of_injury, v_dup.date_of_injury),
    claim_number      = coalesce(nullif(cases.claim_number, ''), v_dup.claim_number),
    liability_carrier = coalesce(nullif(cases.liability_carrier, ''), v_dup.liability_carrier),
    health_insurance  = coalesce(nullif(cases.health_insurance, ''), v_dup.health_insurance),
    notes             = nullif(concat_ws(' | ', cases.notes, v_dup.notes), '')
  where id = p_keep;

  -- Close out the duplicate: unlink from ModMed so syncs target the keep
  -- case only, and leave a paper trail.
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
