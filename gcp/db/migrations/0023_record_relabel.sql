-- ============================================================
-- miiCase — staff relabeling of synced records, protected from the sync
-- 0023_record_relabel.sql
-- ============================================================
-- ModMed ships many documents with no description ("other-file|123.pdf") that
-- are actually HCFA claim forms and notes — exactly what firms need. Staff
-- can now rename/reclassify a record in miiCase (meta_manual guards the edit
-- from nightly overwrites), and HCFA/CMS-1500/claim-form labels join
-- invoices in the firm-visible set.

alter table records add column if not exists meta_manual boolean default false;

-- Firm visibility: pertinent types, plus billing paperwork by label.
drop policy if exists records_select on records;
create policy records_select on records
  for select using (
    auth_is_staff()
    or (firm_id = auth_firm_id()
        and (record_type in ('op_report', 'initial_eval', 'imaging')
             or coalesce(description, '') ~* 'invoice|itemized|hcfa|cms.?1500|claim form'
             or coalesce(filename, '') ~* 'invoice|itemized|hcfa|cms.?1500|claim form'))
  );

-- Reconcile respects manual metadata: a staff-set type/description wins over
-- whatever ModMed re-stages, forever.
create or replace function reconcile_emr_records(p_run uuid)
returns table(records_upserted int, cases_touched int, unmatched int)
language plpgsql as $$
declare
  v_provider uuid := emr_miispine_provider();
  v_upserted int := 0;
begin
  create temporary table _matched on commit drop as
  select ranked.*
  from (
    select s.*, c.id as case_id, c.firm_id,
           row_number() over (
             partition by s.emr_document_id
             order by c.date_of_injury desc nulls last,
                      (c.status not in ('closed','settled')) desc,
                      c.opened_at desc nulls last, c.id
           ) as rn
    from emr_record_staging s
    join cases c on c.emr_patient_id = s.emr_patient_id
    where s.sync_run_id = p_run
      and (c.date_of_injury is null or s.doc_date is null or s.doc_date >= c.date_of_injury)
  ) ranked
  where ranked.rn = 1;

  with up as (
    insert into records
      (case_id, firm_id, provider_id, record_type, status, storage_key, filename, description,
       received_date, emr_document_id, emr_source, emr_synced_at, uploaded_at)
    select case_id, firm_id, v_provider,
           coalesce(record_type, 'other'),
           case when storage_key is not null then 'uploaded' else 'received' end,
           storage_key, filename, description,
           coalesce(doc_date, current_date), emr_document_id, 'modmed', now(),
           case when storage_key is not null then now() else null end
    from _matched
    on conflict (emr_document_id) where emr_document_id is not null do update set
      case_id       = excluded.case_id,
      firm_id       = excluded.firm_id,
      record_type   = case when records.meta_manual then records.record_type else excluded.record_type end,
      filename      = case when records.meta_manual then records.filename
                           when excluded.storage_key is not null or records.storage_key is null
                           then excluded.filename else records.filename end,
      description   = case when records.meta_manual then records.description
                           else coalesce(excluded.description, records.description) end,
      storage_key   = coalesce(excluded.storage_key, records.storage_key),
      status        = case when coalesce(excluded.storage_key, records.storage_key) is not null
                           then 'uploaded' else records.status end,
      received_date = coalesce(records.received_date, excluded.received_date),
      emr_synced_at = now(),
      uploaded_at   = case when excluded.storage_key is not null
                           then coalesce(records.uploaded_at, now()) else records.uploaded_at end
    returning 1
  )
  select count(*) into v_upserted from up;

  update emr_record_staging s set imported = true, review_reason = null
   where s.sync_run_id = p_run
     and exists (select 1 from _matched m where m.emr_document_id = s.emr_document_id);
  update emr_record_staging s set imported = false, review_reason = 'pre_doi'
   where s.sync_run_id = p_run
     and exists (select 1 from cases c where c.emr_patient_id = s.emr_patient_id)
     and not exists (select 1 from _matched m where m.emr_document_id = s.emr_document_id);
  update emr_record_staging s set imported = false, review_reason = 'unmatched_patient'
   where s.sync_run_id = p_run
     and not exists (select 1 from cases c where c.emr_patient_id = s.emr_patient_id);

  delete from records r
   using cases c
   where c.id = r.case_id
     and r.emr_source = 'modmed'
     and c.date_of_injury is not null
     and r.received_date < c.date_of_injury;

  records_upserted := v_upserted;
  select count(distinct case_id)::int into cases_touched from _matched;
  select count(*)::int into unmatched
    from emr_record_staging where sync_run_id = p_run and review_reason = 'unmatched_patient';
  return next;
end;
$$;
