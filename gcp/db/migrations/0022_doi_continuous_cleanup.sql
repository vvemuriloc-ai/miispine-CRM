-- ============================================================
-- miiCase — DOI filtering enforced continuously, not just at migration time
-- 0022_doi_continuous_cleanup.sql
-- ============================================================
-- 0019 removed pre-DOI records once, at apply time. But a DOI set (or
-- corrected) later left already-attached pre-accident records in place until
-- someone noticed. reconcile_emr_records now finishes every run by removing
-- synced records that predate their case's DOI — so fixing a case's DOI in
-- the dashboard cleans that case on the next nightly sync. Manual uploads
-- are never touched. The same cleanup also runs once right here, so cases
-- whose DOI was set after 0019 are corrected immediately.

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
      record_type   = excluded.record_type,
      filename      = case when excluded.storage_key is not null or records.storage_key is null
                           then excluded.filename else records.filename end,
      description   = coalesce(excluded.description, records.description),
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

  -- Continuous DOI enforcement: a DOI set or corrected after records synced
  -- removes the now-out-of-range synced records on the next run.
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

-- Apply the cleanup once now (covers DOIs set since 0019 ran — or 0019
-- never having run at all).
delete from records r
 using cases c
 where c.id = r.case_id
   and r.emr_source = 'modmed'
   and c.date_of_injury is not null
   and r.received_date < c.date_of_injury;

select count(*) filter (where date_of_injury is null) as cases_without_doi,
       count(*) as total_cases
  from cases;
