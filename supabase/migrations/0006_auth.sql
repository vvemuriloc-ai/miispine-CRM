-- ============================================================
-- miiCase / miiSpine AR — Auth & tenant plumbing
-- 0006_auth.sql
-- ============================================================
-- Ties Supabase auth users to firms and stamps `firm_id` into the JWT so the
-- firm-isolation RLS in 0002 (which reads the `firm_id` claim) actually scopes
-- a signed-in user to their firm.
--
-- After applying, enable the hook (once) either in config.toml (local dev) or
-- Dashboard → Authentication → Hooks → Custom Access Token, pointing at
-- public.custom_access_token_hook. Then assign users:
--   select public.assign_user_to_firm('dana@morganhale.com',
--     '11111111-1111-1111-1111-111111111111', 'admin');
-- ============================================================

-- user ↔ firm mapping -----------------------------------------
create table if not exists user_profiles (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  firm_id    uuid references firms(id) not null,
  role       text default 'staff' check (role in ('staff','admin')),
  created_at timestamptz default now()
);
create index if not exists idx_user_profiles_firm on user_profiles(firm_id);

alter table user_profiles enable row level security;
-- A user may read only their own profile row.
drop policy if exists profile_self on user_profiles;
create policy profile_self on user_profiles
  for select using (user_id = auth.uid());

-- ------------------------------------------------------------
-- Custom Access Token Hook: inject firm_id / firm_role into JWT claims.
-- Supabase calls this on every token issuance with the auth event as jsonb.
-- ------------------------------------------------------------
create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
as $$
declare
  claims    jsonb;
  v_firm_id uuid;
  v_role    text;
begin
  select firm_id, role into v_firm_id, v_role
  from public.user_profiles
  where user_id = (event->>'user_id')::uuid;

  claims := coalesce(event->'claims', '{}'::jsonb);
  if v_firm_id is not null then
    claims := jsonb_set(claims, '{firm_id}',   to_jsonb(v_firm_id::text));
    claims := jsonb_set(claims, '{firm_role}', to_jsonb(coalesce(v_role, 'staff')));
  end if;

  return jsonb_set(event, '{claims}', claims);
end;
$$;

-- ------------------------------------------------------------
-- Grants: the hook runs as supabase_auth_admin, which must be able to execute
-- it and read the mapping table. Guarded so this migration also applies on a
-- plain Postgres instance (e.g. local CI) where that role doesn't exist.
-- ------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    grant usage on schema public to supabase_auth_admin;
    grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
    grant select on table public.user_profiles to supabase_auth_admin;
  end if;
end$$;

-- The hook must not be callable by ordinary API roles.
revoke execute on function public.custom_access_token_hook(jsonb) from anon, authenticated, public;

-- ------------------------------------------------------------
-- Admin helper: assign an auth user (by email) to a firm.
-- Run from the SQL editor / service_role — it reads auth.users.
-- ------------------------------------------------------------
create or replace function public.assign_user_to_firm(
  p_email text, p_firm_id uuid, p_role text default 'staff'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_uid uuid;
begin
  select id into v_uid from auth.users where email = p_email;
  if v_uid is null then
    raise exception 'no auth user with email %', p_email;
  end if;
  insert into user_profiles(user_id, firm_id, role)
  values (v_uid, p_firm_id, p_role)
  on conflict (user_id) do update
    set firm_id = excluded.firm_id, role = excluded.role;
end;
$$;

revoke execute on function public.assign_user_to_firm(text, uuid, text) from anon, authenticated, public;
