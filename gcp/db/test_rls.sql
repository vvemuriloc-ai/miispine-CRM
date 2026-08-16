-- ============================================================
-- miiCase — session-variable RLS smoke test  (run against a fresh, migrated DB)
-- gcp/db/test_rls.sql
-- ============================================================
-- Proves firm isolation holds when the tenant comes from app.* session vars
-- (the Cloud SQL + Firebase model) instead of a JWT. Run as a superuser/owner;
-- it creates a throwaway non-owner role to exercise RLS the way the API does.
-- Expected: F1-only, then F2-only, then both (staff), then zero (fails closed),
-- then the records guard strips an attorney's storage_key but keeps staff's.
-- ============================================================

insert into firms (id, name) values
 ('f1111111-1111-1111-1111-111111111111','Firm One'),
 ('f2222222-2222-2222-2222-222222222222','Firm Two');
insert into clients (id, first_name, last_name) values
 ('c1111111-1111-1111-1111-111111111111','Alice','A'),
 ('c2222222-2222-2222-2222-222222222222','Bob','B');
insert into cases (id, firm_id, client_id, claim_number) values
 ('a1111111-1111-1111-1111-111111111111','f1111111-1111-1111-1111-111111111111','c1111111-1111-1111-1111-111111111111','F1-CLAIM'),
 ('a2222222-2222-2222-2222-222222222222','f2222222-2222-2222-2222-222222222222','c2222222-2222-2222-2222-222222222222','F2-CLAIM');

drop role if exists rls_probe;
create role rls_probe nologin;
grant usage on schema public to rls_probe;
grant select, insert, update, delete on all tables in schema public to rls_probe;
grant usage, select on all sequences in schema public to rls_probe;

set role rls_probe;
set app.user_id = 'uid-attorney-1'; set app.is_staff = 'false';

set app.firm_id = 'f1111111-1111-1111-1111-111111111111';
\echo 'expect F1-CLAIM only:'
select claim_number from cases order by claim_number;

set app.firm_id = 'f2222222-2222-2222-2222-222222222222';
\echo 'expect F2-CLAIM only:'
select claim_number from cases order by claim_number;

set app.is_staff = 'true';
\echo 'expect both (staff):'
select claim_number from cases order by claim_number;

reset app.firm_id; reset app.is_staff; reset app.user_id;
\echo 'expect 0 (fails closed):'
select count(*) as visible from cases;
reset role;

set role rls_probe;
set app.firm_id = 'f1111111-1111-1111-1111-111111111111'; set app.is_staff = 'false'; set app.user_id = 'uid-attorney-1';
\echo 'attorney insert: storage_key stripped, status forced to requested:'
insert into records (case_id, firm_id, record_type, status, storage_key)
 values ('a1111111-1111-1111-1111-111111111111','f1111111-1111-1111-1111-111111111111','op_report','uploaded','secret/other.pdf')
 returning status, storage_key, requested_by;

set app.is_staff = 'true'; set app.user_id = 'uid-staff';
\echo 'staff insert: storage_key kept:'
insert into records (case_id, firm_id, record_type, status, storage_key)
 values ('a1111111-1111-1111-1111-111111111111','f1111111-1111-1111-1111-111111111111','op_report','uploaded','emr/real.pdf')
 returning status, storage_key;
reset role;
