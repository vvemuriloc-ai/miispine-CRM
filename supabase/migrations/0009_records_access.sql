-- ============================================================
-- miiCase / miiSpine AR — Medical records access (attorney self-serve)
-- 0009_records_access.sql
-- ============================================================
-- Lets an attorney see their cases' records, download the ones miiSpine has
-- uploaded, and request the ones they don't have — the #1 PI pain point.
--
-- Security model (PHI to an outside party):
--   * Firm RLS scopes records to the attorney's own firm (staff see all).
--   * Files live in a PRIVATE storage bucket; the browser never gets a raw
--     path. Downloads go through the `records-download` edge function, which
--     re-checks firm ownership + HIPAA release, writes an audit row, and mints
--     a 60-second signed URL.
--   * Attorneys can only CREATE request rows — a trigger strips any storage_key
--     and forces status='requested', so they can never point a record at
--     another firm's file. Only miiSpine staff set storage_key (on upload).
-- ============================================================

alter table records add column if not exists filename     text;
alter table records add column if not exists requested_by  uuid;
alter table records add column if not exists uploaded_at    timestamptz;
-- A request may not name a provider yet (staff assign one on fulfillment).
alter table records alter column provider_id drop not null;

-- ---- Private storage bucket + staff-only object access ------
-- Guarded so this migration still applies on a plain Postgres (CI) that has no
-- `storage` schema; on Supabase it runs fully.
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    insert into storage.buckets (id, name, public)
      values ('medical-records', 'medical-records', false)
      on conflict (id) do nothing;

    -- Staff upload/manage files directly from the browser (their JWT carries
    -- is_staff). Attorneys get NO direct object access — downloads are minted
    -- by the edge function with the service role.
    drop policy if exists "records staff manage" on storage.objects;
    create policy "records staff manage" on storage.objects
      for all to authenticated
      using (bucket_id = 'medical-records' and auth_is_staff())
      with check (bucket_id = 'medical-records' and auth_is_staff());
  end if;
end$$;

-- ---- Finer-grained RLS on the records table ----------------
-- Replace the blanket firm_isolation policy (from 0002/0007) with:
--   select : firm or staff
--   insert : firm or staff (attorneys create requests; guard trigger below)
--   update/delete : staff only (miiSpine owns fulfillment + storage_key)
drop policy if exists firm_isolation on records;

drop policy if exists records_select on records;
create policy records_select on records
  for select using (auth_is_staff() or firm_id = auth_firm_id());

drop policy if exists records_insert on records;
create policy records_insert on records
  for insert with check (auth_is_staff() or firm_id = auth_firm_id());

drop policy if exists records_update on records;
create policy records_update on records
  for update using (auth_is_staff()) with check (auth_is_staff());

drop policy if exists records_delete on records;
create policy records_delete on records
  for delete using (auth_is_staff());

-- An attorney-created row can never carry a file pointer or a non-request state.
-- Skipped for service_role / superuser (no JWT claims) so seeds/imports are free.
create or replace function records_attorney_guard()
returns trigger language plpgsql as $$
begin
  if nullif(current_setting('request.jwt.claims', true), '') is not null
     and not auth_is_staff() then
    new.storage_key           := null;
    new.signed_url_expires_at := null;
    new.status                := 'requested';
    new.requested_date        := coalesce(new.requested_date, current_date);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_records_attorney_guard on records;
create trigger trg_records_attorney_guard
  before insert on records
  for each row execute function records_attorney_guard();

-- Convenience view: records with the case's HIPAA-release status, RLS-scoped.
create or replace view case_records
with (security_invoker = on) as
select
  r.id, r.case_id, r.firm_id, r.provider_id, r.record_type, r.status,
  r.requested_date, r.received_date, r.filename, r.uploaded_at,
  p.name as provider_name,
  cl.hipaa_release_on_file,
  (r.storage_key is not null) as has_file
from records r
join cases c    on c.id = r.case_id
join clients cl on cl.id = c.client_id
left join providers p on p.id = r.provider_id;
