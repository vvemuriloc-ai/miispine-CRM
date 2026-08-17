-- ============================================================
-- miiCase — wipe the demo/seed data before the real import.
-- ============================================================
-- Clears every data table but KEEPS logins (user_profiles) and the schema.
-- Run in Cloud SQL Studio as postgres. Safe to run more than once.
-- (TRUNCATE is used deliberately: this is a pre-production reset. Once real
-- data is in, audit_log rows are immutable and must never be cleared.)
truncate
  invoice_payments, invoices,
  emr_record_staging, emr_payment_staging, emr_charge_staging, emr_sync_run,
  staging_import,
  outreach_log, demand_drafts, settlement_events, deadlines, milestones,
  records, medical_bills, collateral_calc, pip_ledger, cases,
  attorneys, clients, firms, providers,
  audit_log
  restart identity cascade;
alter sequence invoice_seq restart with 1;
select 'wiped — ready for import' as status;
