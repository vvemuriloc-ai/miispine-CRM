-- ============================================================
-- miiCase Autopilot — nightly schedule
-- 0005_cron.sql
-- ============================================================
-- Schedules the `autopilot` edge function to run every night at 06:00 UTC
-- (≈ 1–2 AM Louisville) via pg_cron + pg_net. Requires:
--   * The extensions below (available on Supabase).
--   * A Vault secret named `autopilot_service_key` holding the project's
--     service_role key so the HTTP call can invoke a verify_jwt=false function
--     with proper auth headers.
--   * The `app.settings.autopilot_url` GUC (or edit the URL inline) pointing at
--     https://<project-ref>.functions.supabase.co/autopilot
--
-- Set these once (replace placeholders), then this migration is idempotent:
--   select vault.create_secret('<SERVICE_ROLE_KEY>', 'autopilot_service_key');
--   alter database postgres set app.settings.autopilot_url =
--     'https://<project-ref>.functions.supabase.co/autopilot';
-- ============================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Remove any prior schedule so re-running this file is safe.
select cron.unschedule('miicase-autopilot')
where exists (select 1 from cron.job where jobname = 'miicase-autopilot');

select cron.schedule(
  'miicase-autopilot',
  '0 6 * * *',                       -- 06:00 UTC daily
  $$
  select net.http_post(
    url     := current_setting('app.settings.autopilot_url', true),
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'autopilot_service_key'
      )
    ),
    body    := '{}'::jsonb
  );
  $$
);
