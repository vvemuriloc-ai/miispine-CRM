-- ============================================================
-- miiCase / miiSpine AR — Auth & tenant plumbing  (GCP / Cloud SQL + Firebase)
-- 0002_auth.sql
-- ============================================================
-- On Supabase the tenant came from a JWT claim injected by PostgREST. On Cloud
-- SQL there is no PostgREST: the Cloud Run API tier validates the Firebase ID
-- token, looks up the user's firm, and stamps three GUCs at the start of each
-- request/transaction:
--
--   SET LOCAL app.user_id  = '<firebase-uid>';
--   SET LOCAL app.firm_id  = '<uuid or empty>';
--   SET LOCAL app.is_staff = 'true' | 'false';
--
-- RLS then reads those session variables. Because RLS is still enforced inside
-- the database, a bug in the API tier can't leak one firm's PHI to another —
-- defense in depth is preserved. Background jobs (autopilot, ModMed sync) and
-- one-time imports connect as the DB owner WITHOUT setting app.*, so they run
-- unconstrained (the equivalent of Supabase's service_role).
-- ============================================================

-- Helper: current Firebase UID (null when the API set no session context).
create or replace function current_user_id()
returns text language sql stable as $$
  select nullif(current_setting('app.user_id', true), '');
$$;

-- Helper: the caller's firm_id (null when unauthenticated / unset).
create or replace function auth_firm_id()
returns uuid language sql stable as $$
  select nullif(current_setting('app.firm_id', true), '')::uuid;
$$;

-- Helper: is the caller miiSpine staff (sees the whole book)?
create or replace function auth_is_staff()
returns boolean language sql stable as $$
  select coalesce(nullif(current_setting('app.is_staff', true), '')::boolean, false);
$$;

-- user ↔ firm mapping. user_id is the Firebase UID (a string, not a uuid).
-- email is stored so an admin can (re)assign by email; is_staff grants the
-- cross-firm view (firm_id may then be null).
create table if not exists user_profiles (
  user_id    text primary key,
  email      text,
  firm_id    uuid references firms(id),
  role       text default 'staff' check (role in ('staff','admin')),
  is_staff   boolean default false,
  created_at timestamptz default now(),
  constraint user_profiles_firm_or_staff check (firm_id is not null or is_staff)
);
create index if not exists idx_user_profiles_firm  on user_profiles(firm_id);
create index if not exists idx_user_profiles_email on user_profiles(lower(email));

alter table user_profiles enable row level security;
-- A user may read only their own profile row (the API reads it with app.user_id set).
drop policy if exists profile_self on user_profiles;
create policy profile_self on user_profiles
  for select using (user_id = current_user_id());

-- ------------------------------------------------------------
-- Admin helpers — run by the API/admin as the DB owner (no app.* context).
-- The API calls assign_user_to_firm() right after a Firebase user is created.
-- ------------------------------------------------------------
create or replace function assign_user_to_firm(
  p_uid text, p_email text, p_firm_id uuid, p_role text default 'staff'
)
returns void language plpgsql as $$
begin
  insert into user_profiles(user_id, email, firm_id, role, is_staff)
  values (p_uid, p_email, p_firm_id, p_role, false)
  on conflict (user_id) do update
    set email = excluded.email, firm_id = excluded.firm_id,
        role = excluded.role, is_staff = false;
end;
$$;

-- Mark a user as miiSpine staff (cross-firm; firm_id null).
create or replace function assign_staff(p_uid text, p_email text)
returns void language plpgsql as $$
begin
  insert into user_profiles(user_id, email, firm_id, role, is_staff)
  values (p_uid, p_email, null, 'admin', true)
  on conflict (user_id) do update
    set email = excluded.email, is_staff = true, role = 'admin';
end;
$$;
