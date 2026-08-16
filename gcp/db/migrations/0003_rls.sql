-- ============================================================
-- miiCase / miiSpine AR — Row Level Security  (GCP / Cloud SQL)
-- 0003_rls.sql : firm isolation with a miiSpine-staff bypass
-- ============================================================
-- Every firm-scoped table carries a firm_id. A user sees their own firm's rows;
-- miiSpine staff (app.is_staff = true) see the whole book. The helpers
-- auth_firm_id() / auth_is_staff() (0002) read the session variables the API
-- tier sets. Background jobs connect without app.* and are unconstrained.
--
-- `firms`, `attorneys`, `clients` are reachable only through an RLS'd `cases`
-- join; `providers` is shared reference data. `records` gets finer-grained
-- policies later in 0008 (it replaces the blanket firm_isolation there).
-- ============================================================

-- ---- Firm-scoped tables: firm-or-staff, one policy each --------------------
do $$
declare
  t text;
  firm_scoped text[] := array[
    'cases','pip_ledger','medical_bills','records','milestones',
    'settlement_events','deadlines','outreach_log','demand_drafts',
    'collateral_calc'
  ];
begin
  foreach t in array firm_scoped loop
    execute format('alter table %I enable row level security;', t);
    execute format('drop policy if exists firm_isolation on %I;', t);
    execute format(
      'create policy firm_isolation on %I
         using (auth_is_staff() or firm_id = auth_firm_id())
         with check (auth_is_staff() or firm_id = auth_firm_id());', t);
  end loop;
end$$;

-- ---- audit_log: immutable (rules in 0001); read own firm or staff ----------
alter table audit_log enable row level security;
drop policy if exists audit_select on audit_log;
create policy audit_select on audit_log
  for select using (auth_is_staff() or firm_id = auth_firm_id());
drop policy if exists audit_insert on audit_log;
create policy audit_insert on audit_log
  for insert with check (auth_is_staff() or firm_id = auth_firm_id());

-- ---- Reference tables reachable through a firm-scoped case -----------------
alter table firms enable row level security;
drop policy if exists firm_self on firms;
create policy firm_self on firms
  for select using (auth_is_staff() or id = auth_firm_id());

alter table attorneys enable row level security;
drop policy if exists attorney_firm on attorneys;
create policy attorney_firm on attorneys
  for select using (auth_is_staff() or firm_id = auth_firm_id());

alter table clients enable row level security;
drop policy if exists client_by_case on clients;
create policy client_by_case on clients
  for select using (
    auth_is_staff() or exists (
      select 1 from cases c
      where c.client_id = clients.id and c.firm_id = auth_firm_id()
    )
  );

-- Providers are shared reference data — readable by any authenticated caller.
alter table providers enable row level security;
drop policy if exists provider_read on providers;
create policy provider_read on providers
  for select using (auth_is_staff() or auth_firm_id() is not null);
