-- ============================================================
-- miiCase — nightly ModMed clinical-records sync schedule
-- 0014_records_cron.sql
-- ============================================================
-- Schedules the read-only `modmed-records` edge function nightly at 05:00 UTC
-- (ahead of the AR sync at 05:30 and autopilot at 06:00). Same pg_cron + pg_net
-- + Vault pattern as 0005/0012. Set these once (idempotent thereafter):
--
--   select vault.create_secret('<SERVICE_ROLE_KEY>', 'modmed_records_service_key');
--   alter database postgres set app.settings.modmed_records_url =
--     'https://<project-ref>.functions.supabase.co/modmed-records';
--
-- Keep MODMED_DRY_RUN=true until you've reviewed a few runs in emr_sync_status;
-- flip to false to actually download files into the medical-records bucket.
-- ============================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('miicase-modmed-records')
where exists (select 1 from cron.job where jobname = 'miicase-modmed-records');

select cron.schedule(
  'miicase-modmed-records',
  '0 5 * * *',                       -- 05:00 UTC daily
  $$
  select net.http_post(
    url     := current_setting('app.settings.modmed_records_url', true),
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'modmed_records_service_key'
      )
    ),
    body    := '{}'::jsonb
  );
  $$
);
