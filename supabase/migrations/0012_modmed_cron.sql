-- ============================================================
-- miiCase — nightly ModMed AR sync schedule
-- 0012_modmed_cron.sql
-- ============================================================
-- Schedules the read-only `modmed-sync` edge function to run nightly at
-- 05:30 UTC (before the autopilot run at 06:00, so tonight's outreach sees
-- freshly reconciled liens). Same pg_cron + pg_net + Vault pattern as
-- 0005_cron.sql. Set these once (idempotent thereafter):
--
--   select vault.create_secret('<SERVICE_ROLE_KEY>', 'modmed_sync_service_key');
--   alter database postgres set app.settings.modmed_sync_url =
--     'https://<project-ref>.functions.supabase.co/modmed-sync';
--
-- Leave the function's MODMED_DRY_RUN=true until you've eyeballed a few runs in
-- emr_sync_status; flip it to false to let reconcile write into medical_bills.
-- ============================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('miicase-modmed-sync')
where exists (select 1 from cron.job where jobname = 'miicase-modmed-sync');

select cron.schedule(
  'miicase-modmed-sync',
  '30 5 * * *',                      -- 05:30 UTC daily
  $$
  select net.http_post(
    url     := current_setting('app.settings.modmed_sync_url', true),
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'modmed_sync_service_key'
      )
    ),
    body    := '{}'::jsonb
  );
  $$
);
