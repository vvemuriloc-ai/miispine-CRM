-- ============================================================
-- miiCase / miiSpine AR — Cloud SQL role model
-- gcp/db/roles.sql
-- ============================================================
-- Two connection identities, mirroring Supabase's anon-vs-service_role split:
--
--   miicase_app   — the Cloud Run API tier. NOT the table owner, so RLS is
--                   enforced against it. The API sets app.user_id / app.firm_id
--                   / app.is_staff per request; RLS scopes every read/write.
--
--   (owner)       — migrations and background jobs (autopilot, ModMed sync,
--                   one-time imports) connect as the role that owns the tables.
--                   An owner bypasses its own tables' RLS (we do NOT FORCE RLS),
--                   which is exactly the unconstrained, whole-book access those
--                   jobs need — no BYPASSRLS attribute required (Cloud SQL's
--                   admin role can't grant it anyway).
--
-- Set the password out of band (Secret Manager), not here.
-- ============================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'miicase_app') then
    create role miicase_app login;
  end if;
end$$;

grant usage on schema public to miicase_app;
grant select, insert, update, delete on all tables in schema public to miicase_app;
grant usage, select on all sequences in schema public to miicase_app;
grant execute on all functions in schema public to miicase_app;

-- Make the grants apply to objects created by future migrations too.
alter default privileges in schema public
  grant select, insert, update, delete on tables to miicase_app;
alter default privileges in schema public
  grant usage, select on sequences to miicase_app;
alter default privileges in schema public
  grant execute on functions to miicase_app;
