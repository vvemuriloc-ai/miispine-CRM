-- ============================================================
-- miiCase — wipe the demo/seed data before the real import.
-- ============================================================
-- Clears every data table but KEEPS logins (user_profiles) and the schema.
-- Run in Cloud SQL Studio as postgres. Safe to run more than once.
-- (TRUNCATE is used deliberately: this is a pre-production reset. Once real
-- data is in, audit_log rows are immutable and must never be cleared.)
-- Keep miiSpine staff logins: truncating firms cascades into user_profiles
-- (firm_id FK), so stash staff rows (firm_id is null for staff) and restore.
create temporary table _keep_staff as
  select * from user_profiles where is_staff;

truncate
  invoice_payments, invoices,
  emr_record_staging, emr_payment_staging, emr_charge_staging, emr_sync_run,
  staging_import,
  outreach_log, demand_drafts, settlement_events, deadlines, milestones,
  records, medical_bills, collateral_calc, pip_ledger, cases,
  attorneys, clients, firms, providers,
  audit_log
  restart identity cascade;

insert into user_profiles select * from _keep_staff;
alter sequence invoice_seq restart with 1;
select 'wiped — staff logins kept: ' || count(*) as status from user_profiles;
