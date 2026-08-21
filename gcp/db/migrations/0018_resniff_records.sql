-- ============================================================
-- miiCase — trustworthy record filenames + re-download for byte-sniffing
-- 0018_resniff_records.sql
-- ============================================================
-- Two fixes:
-- 1) reconcile_emr_records overwrote filename on EVERY run. A re-run that
--    skips already-uploaded files stages placeholder names (search results
--    carry no attachment title), so each re-run downgraded good filenames to
--    "type-file|123.bin". Now the staged filename only wins on the run that
--    actually uploaded the file (or when the record has no file yet).
-- 2) Files synced before byte-sniffing landed were stored under ModMed's
--    claimed contentType — absent for generated notes, so office/procedure
--    notes saved as ".bin"/mislabeled markup that "opens as code". Clearing
--    storage_key queues them for re-download; the sync then stores the true
--    type and extension sniffed from the actual bytes.

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
             order by (c.status not in ('closed','settled')) desc, c.opened_at desc nulls last, c.id
           ) as rn
    from emr_record_staging s
    join cases c on c.emr_patient_id = s.emr_patient_id
    where s.sync_run_id = p_run
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
      record_type   = excluded.record_type,
      -- The accurate filename (attachment title / sniffed extension) only
      -- exists on the run that downloaded the file. A metadata-only re-run
      -- must not downgrade it to the search-result placeholder.
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
     and exists (select 1 from cases c where c.emr_patient_id = s.emr_patient_id);
  update emr_record_staging s set imported = false, review_reason = 'unmatched_patient'
   where s.sync_run_id = p_run
     and not exists (select 1 from cases c where c.emr_patient_id = s.emr_patient_id);

  records_upserted := v_upserted;
  select count(distinct case_id)::int into cases_touched from _matched;
  select count(*)::int into unmatched
    from emr_record_staging where sync_run_id = p_run and review_reason = 'unmatched_patient';
  return next;
end;
$$;

update records
   set storage_key = null, status = 'received', uploaded_at = null
 where emr_source = 'modmed'
   and storage_key is not null
   and (filename !~ '\.' or filename ~* '\.(bin|xml|html?)$');

-- Report what was queued for re-download (count only).
select count(*) as queued_for_resync
  from records
 where emr_source = 'modmed' and storage_key is null;
