-- ============================================================
-- miiCase — fix reconcile_emr_records for patients with multiple cases
-- 0015_records_multi_case.sql
-- ============================================================
-- reconcile_emr_records() joined emr_record_staging to `cases` on
-- emr_patient_id. A patient with more than one open case (common — repeat
-- clients with a new claim) produced one staging row per case for the SAME
-- ModMed document, all sharing emr_document_id. The INSERT ... ON CONFLICT
-- (emr_document_id) then tried to update that one unique row twice in a
-- single statement, which Postgres rejects outright:
--   "ON CONFLICT DO UPDATE command cannot affect row a second time"
-- First surfaced on a live sync run: 238 cases across 202 linked patients.
--
-- Fix: pick exactly ONE case per document, deterministically — the client's
-- most recently opened case not yet closed/settled (falling back to the
-- most recent overall). Good-enough default for "which claim is this
-- treatment for"; a firm-level review UI is a natural follow-up if multi-
-- case clients turn out to need per-claim splitting.
-- ============================================================

create or replace function reconcile_emr_records(p_run uuid)
returns table(records_upserted int, cases_touched int, unmatched int)
language plpgsql as $$
declare
  v_provider uuid := emr_miispine_provider();
  v_upserted int := 0;
begin
  -- Exactly one (case_id, document) pairing per document, so the upsert below
  -- never targets the same unique row twice in one statement.
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
      (case_id, firm_id, provider_id, record_type, status, storage_key, filename,
       received_date, emr_document_id, emr_source, emr_synced_at, uploaded_at)
    select case_id, firm_id, v_provider,
           coalesce(record_type, 'other'),
           case when storage_key is not null then 'uploaded' else 'received' end,
           storage_key, filename,
           coalesce(doc_date, current_date), emr_document_id, 'modmed', now(),
           case when storage_key is not null then now() else null end
    from _matched
    on conflict (emr_document_id) where emr_document_id is not null do update set
      record_type   = excluded.record_type,
      filename      = excluded.filename,
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
