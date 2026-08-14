-- ============================================================
-- miiCase / miiSpine AR — Row Level Security
-- 0002_rls.sql : firm isolation enforced at the DB level
-- ============================================================
-- Every firm-scoped table carries a `firm_id`. A user's firm is read from the
-- `firm_id` claim on their JWT. The autopilot edge function connects with the
-- service_role key, which bypasses RLS by design (it runs nightly across all
-- firms), so these policies only constrain portal / anon / authenticated
-- traffic.
--
-- `firms`, `attorneys`, `clients`, and `providers` are reference tables without
-- a direct firm_id. `providers` is shared across firms; `firms`/`attorneys`/
-- `clients` are reachable only through a `cases` join, which is itself RLS'd.
-- We enable RLS on them and expose read-only policies scoped by firm so the
-- portal cannot enumerate the whole directory.
-- ============================================================

-- Helper: the firm_id claim on the current JWT (null when unauthenticated).
create or replace function auth_firm_id()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'firm_id', '')::uuid;
$$;

-- ------------------------------------------------------------
-- Firm-scoped tables: one policy each, same pattern
-- ------------------------------------------------------------
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
         using (firm_id = auth_firm_id())
         with check (firm_id = auth_firm_id());', t);
  end loop;
end$$;

-- ------------------------------------------------------------
-- audit_log: rows are immutable (see rules in 0001). Users may read only
-- their own firm's audit trail; inserts are allowed for their firm.
-- ------------------------------------------------------------
alter table audit_log enable row level security;

drop policy if exists audit_select on audit_log;
create policy audit_select on audit_log
  for select using (firm_id = auth_firm_id());

drop policy if exists audit_insert on audit_log;
create policy audit_insert on audit_log
  for insert with check (firm_id = auth_firm_id());

-- ------------------------------------------------------------
-- Reference tables reachable through a firm-scoped case
-- ------------------------------------------------------------
alter table firms enable row level security;
drop policy if exists firm_self on firms;
create policy firm_self on firms
  for select using (id = auth_firm_id());

alter table attorneys enable row level security;
drop policy if exists attorney_firm on attorneys;
create policy attorney_firm on attorneys
  for select using (firm_id = auth_firm_id());

alter table clients enable row level security;
drop policy if exists client_by_case on clients;
create policy client_by_case on clients
  for select using (
    exists (
      select 1 from cases c
      where c.client_id = clients.id
        and c.firm_id = auth_firm_id()
    )
  );

-- Providers are shared reference data — readable by any authenticated firm.
alter table providers enable row level security;
drop policy if exists provider_read on providers;
create policy provider_read on providers
  for select using (auth_firm_id() is not null);
