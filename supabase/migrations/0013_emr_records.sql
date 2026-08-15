-- ============================================================
-- miiCase / miiSpine AR — ModMed EMA clinical records sync (read-only)
-- 0013_emr_records.sql
-- ============================================================
-- The ModMed *clinical* (EMA) FHIR credential exposes DocumentReference +
-- Binary + Patient + Encounter/Condition/ServiceRequest (but NOT billing). This
-- migration is the landing + reconciliation layer for a READ-ONLY pull of
-- clinical records into the existing `records` table and the private
-- `medical-records` bucket from 0009 — which the attorney portal already serves
-- under the HIPAA gate + audit trail.
--
-- The edge function (supabase/functions/modmed-records) searches DocumentReference
-- per case-linked patient, uploads each document's bytes into the bucket, writes
-- the metadata into emr_record_staging (with the resulting storage_key), then
-- reconcile_emr_records() upserts them into `records` keyed on the EMR document
-- id (idempotent). Charges/payments are a separate credential (see 0011); this
-- one never writes to the EMR — READ/SEARCH scopes only.
-- ============================================================

-- ---- EMR linkage on records (idempotent upserts key off emr_document_id) ----
alter table records add column if not exists emr_document_id text;
alter table records add column if not exists emr_source      text default 'manual'
                    check (emr_source in ('manual','modmed'));
alter table records add column if not exists emr_synced_at   timestamptz;

create unique index if not exists uq_records_emr_document
  on records(emr_document_id) where emr_document_id is not null;

-- ---- Raw document staging (one row per ModMed DocumentReference) ------------
create table if not exists emr_record_staging (
  id               uuid primary key default gen_random_uuid(),
  sync_run_id      uuid references emr_sync_run(id) on delete cascade,
  emr_document_id  text not null,
  emr_patient_id   text,
  record_type      text,                  -- mapped to the records enum by the function
  doc_date         date,
  description      text,
  filename         text,
  mime_type        text,
  storage_key      text,                  -- set by the function after the bucket upload
  status_raw       text,
  raw              jsonb,
  imported         boolean default false,
  review_reason    text,
  created_at       timestamptz default now()
);
create index if not exists idx_emr_record_staging_run     on emr_record_staging(sync_run_id);
create index if not exists idx_emr_record_staging_patient on emr_record_staging(emr_patient_id);

-- ---- Reconcile: staging -> records (dedup on emr_document_id) ---------------
-- Idempotent: an already-synced document keeps its storage_key; re-runs just
-- refresh metadata. A document with a file becomes status 'uploaded' (the
-- attorney can download it); metadata-only (dry-run / fetch failed) is 'received'.
create or replace function reconcile_emr_records(p_run uuid)
returns table(records_upserted int, cases_touched int, unmatched int)
language plpgsql as $$
declare
  v_provider uuid := emr_miispine_provider();   -- from 0011
  v_upserted int := 0;
begin
  with matched as (
    select s.*, c.id as case_id, c.firm_id
    from emr_record_staging s
    join cases c on c.emr_patient_id = s.emr_patient_id
    where s.sync_run_id = p_run
  ), up as (
    insert into records
      (case_id, firm_id, provider_id, record_type, status, storage_key, filename,
       received_date, emr_document_id, emr_source, emr_synced_at, uploaded_at)
    select case_id, firm_id, v_provider,
           coalesce(record_type, 'other'),
           case when storage_key is not null then 'uploaded' else 'received' end,
           storage_key, filename,
           coalesce(doc_date, current_date), emr_document_id, 'modmed', now(),
           case when storage_key is not null then now() else null end
    from matched
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
  select count(distinct c.id)::int into cases_touched
    from emr_record_staging s join cases c on c.emr_patient_id = s.emr_patient_id
    where s.sync_run_id = p_run;
  select count(*)::int into unmatched
    from emr_record_staging where sync_run_id = p_run and review_reason = 'unmatched_patient';
  return next;
end;
$$;

-- ---- RLS: staging is miiSpine-staff-only (service role bypasses) ------------
alter table emr_record_staging enable row level security;
drop policy if exists emr_record_staging_staff on emr_record_staging;
create policy emr_record_staging_staff on emr_record_staging for all
  using (auth_is_staff()) with check (auth_is_staff());

-- ---- Records-run counters on the shared sync-run log + refreshed view -------
alter table emr_sync_run add column if not exists records_seen     int default 0;
alter table emr_sync_run add column if not exists records_upserted int default 0;
alter table emr_sync_run add column if not exists files_uploaded   int default 0;

-- Drop first: replacing in place can't insert columns mid-list (0011 defined it).
drop view if exists emr_sync_status;
create view emr_sync_status
with (security_invoker = on) as
select
  r.id, r.kind, r.status, r.resources,
  r.charges_seen, r.payments_seen, r.charges_upserted,
  r.records_seen, r.records_upserted, r.files_uploaded,
  r.cases_touched, r.unmatched, r.dry_run, r.error, r.started_at, r.finished_at,
  round(extract(epoch from (coalesce(r.finished_at, now()) - r.started_at)))::int as duration_s
from emr_sync_run r
order by r.started_at desc;
