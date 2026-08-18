-- ============================================================
-- miiCase — staff write access to reference tables
-- 0013_staff_writes.sql
-- ============================================================
-- The app's "New Case" flow (and future admin edits) has miiSpine staff
-- creating firms/clients/providers from the API, which connects as
-- miicase_app (RLS enforced). Those tables only had SELECT policies, so
-- inserts were rejected. Staff-only write policies; attorneys stay read-only.
-- ============================================================

drop policy if exists firms_staff_write on firms;
create policy firms_staff_write on firms
  for insert with check (auth_is_staff());
drop policy if exists firms_staff_update on firms;
create policy firms_staff_update on firms
  for update using (auth_is_staff()) with check (auth_is_staff());

drop policy if exists clients_staff_write on clients;
create policy clients_staff_write on clients
  for insert with check (auth_is_staff());
drop policy if exists clients_staff_update on clients;
create policy clients_staff_update on clients
  for update using (auth_is_staff()) with check (auth_is_staff());

drop policy if exists attorneys_staff_write on attorneys;
create policy attorneys_staff_write on attorneys
  for insert with check (auth_is_staff());
drop policy if exists attorneys_staff_update on attorneys;
create policy attorneys_staff_update on attorneys
  for update using (auth_is_staff()) with check (auth_is_staff());

drop policy if exists providers_staff_write on providers;
create policy providers_staff_write on providers
  for insert with check (auth_is_staff());
