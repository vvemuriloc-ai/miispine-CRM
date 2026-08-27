-- ============================================================
-- miiCase — firms see only pertinent record types
-- 0021_firm_record_types.sql
-- ============================================================
-- Attorney-facing policy, enforced in the database (not just the UI):
-- law firms see op/procedure notes, initial evaluations, and imaging —
-- the records pertinent to their demand. Everything else is staff-only:
-- progress notes are internal, MMI/impairment material is reserved for
-- the paid narrative report, and discharge summaries aren't produced.
-- Invoices are unaffected (their own table and tab).
--
-- Staff visibility is unchanged. The download route runs under this same
-- policy, so a firm can neither list nor fetch an out-of-scope record.

drop policy if exists records_select on records;
create policy records_select on records
  for select using (
    auth_is_staff()
    or (firm_id = auth_firm_id()
        and (record_type in ('op_report', 'initial_eval', 'imaging')
             -- scanned invoices / itemized statements are billing documents
             -- the firm is meant to have, whatever type they classified as
             or coalesce(description, '') ~* 'invoice|itemized'
             or coalesce(filename, '') ~* 'invoice|itemized'))
  );
