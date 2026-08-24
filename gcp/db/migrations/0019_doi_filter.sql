-- ============================================================
-- miiCase — records respect the date of injury
-- 0019_doi_filter.sql
-- ============================================================
-- Patients treated before their accident were syncing their FULL ModMed
-- history onto the PI case — pre-accident treatment does not belong in the
-- case file or in front of counsel. Reconcile now:
--   * only attaches a document to a case when doc_date >= the case's DOI
--     (documents with no date, or cases with no DOI, still attach);
--   * for repeat clients with multiple cases, assigns each document to the
--     episode whose DOI most recently precedes it (then prefers active);
--   * marks documents predating every eligible case 'pre_doi' in staging
--     instead of attaching them anywhere.
-- Existing pre-DOI records are removed from cases below (rows only — the
-- source documents remain in ModMed, and staging keeps the audit trail).

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
      -- Episode assignment is authoritative: a repeat client's document moves
      -- to the case whose DOI most recently precedes it.
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
  -- Known patient, but the document predates every eligible case.
  update emr_record_staging s set imported = false, review_reason = 'pre_doi'
   where s.sync_run_id = p_run
     and exists (select 1 from cases c where c.emr_patient_id = s.emr_patient_id)
     and not exists (select 1 from _matched m where m.emr_document_id = s.emr_document_id);
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

-- Remove already-attached pre-DOI records from cases (synced rows only —
-- manual uploads are never touched).
delete from records r
 using cases c
 where c.id = r.case_id
   and r.emr_source = 'modmed'
   and c.date_of_injury is not null
   and r.received_date < c.date_of_injury;

select count(*) as remaining_modmed_records from records where emr_source = 'modmed';
