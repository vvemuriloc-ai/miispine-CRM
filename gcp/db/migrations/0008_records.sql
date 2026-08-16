-- ============================================================
-- miiCase / miiSpine AR — Medical records access  (GCP / Cloud SQL + GCS)
-- 0008_records.sql
-- ============================================================
-- Same access model as the Supabase build, minus the Supabase Storage schema:
-- on GCP the files live in a PRIVATE Google Cloud Storage bucket and downloads
-- are minted as short-lived V4 signed URLs by the Cloud Run API (after firm +
-- HIPAA-release checks + an audit row). The DB only holds the record metadata
-- and the object's storage key.
--
--   select        : firm or staff
--   insert        : firm or staff (attorneys create requests; guard trigger)
--   update/delete : staff only (miiSpine owns fulfillment + storage_key)
-- ============================================================

alter table records add column if not exists filename     text;
alter table records add column if not exists requested_by  text;   -- Firebase UID
alter table records add column if not exists uploaded_at    timestamptz;
-- A request may not name a provider yet (staff assign one on fulfillment).
alter table records alter column provider_id drop not null;

-- ---- Finer-grained RLS on the records table (replaces 0003 firm_isolation) --
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
-- Fires only for an authenticated non-staff caller (app.user_id set, not staff);
-- background jobs / imports run without app.* and are unaffected.
create or replace function records_attorney_guard()
returns trigger language plpgsql as $$
begin
  if current_user_id() is not null and not auth_is_staff() then
    new.storage_key           := null;
    new.signed_url_expires_at := null;
    new.status                := 'requested';
    new.requested_date        := coalesce(new.requested_date, current_date);
    new.requested_by          := coalesce(new.requested_by, current_user_id());
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
