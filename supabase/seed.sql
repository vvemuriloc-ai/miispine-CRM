-- ============================================================
-- miiCase / miiSpine AR — Demo seed data
-- Run after the migrations. AR rollups on `cases` and the `collateral_calc`
-- snapshot are populated automatically by the triggers in 0004 as the
-- medical_bills rows are inserted.
-- ============================================================

-- Fixed UUIDs so the rows are easy to cross-reference.
-- Firms -----------------------------------------------------------------
insert into firms (id, name, phone, email, address) values
  ('11111111-1111-1111-1111-111111111111', 'Morgan & Hale PLLC', '(502) 555-0110', 'intake@morganhale.com', '401 W Main St, Louisville, KY 40202'),
  ('22222222-2222-2222-2222-222222222222', 'Bluegrass Injury Law', '(859) 555-0120', 'cases@bluegrassinjury.com', '120 S Limestone, Lexington, KY 40507')
on conflict (id) do nothing;

-- Attorneys -------------------------------------------------------------
insert into attorneys (id, firm_id, name, email, phone, avg_response_days, voicemail_rate, preferred_contact) values
  ('a1111111-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Dana Morgan',   'dmorgan@morganhale.com',   '(502) 555-0111', 3.5, 0.20, 'email'),
  ('a1111111-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'Priya Hale',     'phale@morganhale.com',     '(502) 555-0112', 6.0, 0.45, 'phone'),
  ('a2222222-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', 'Marcus Bell',    'mbell@bluegrassinjury.com','(859) 555-0121', 1.5, 0.10, 'email')
on conflict (id) do nothing;

-- Clients ---------------------------------------------------------------
insert into clients (id, first_name, last_name, dob, phone, email, hipaa_release_on_file) values
  ('c0000000-0000-0000-0000-000000000001', 'James',   'Whitfield', '1985-04-12', '(502) 555-2001', 'jwhitfield@example.com', true),
  ('c0000000-0000-0000-0000-000000000002', 'Aisha',   'Cole',      '1990-09-30', '(502) 555-2002', 'acole@example.com',      true),
  ('c0000000-0000-0000-0000-000000000003', 'Robert',  'Nunez',     '1978-01-22', '(502) 555-2003', 'rnunez@example.com',     false),
  ('c0000000-0000-0000-0000-000000000004', 'Latoya',  'Sims',      '1995-06-08', '(859) 555-2004', 'lsims@example.com',      true),
  ('c0000000-0000-0000-0000-000000000005', 'Kevin',   'Park',      '1982-11-17', '(859) 555-2005', 'kpark@example.com',      true),
  ('c0000000-0000-0000-0000-000000000006', 'Maria',   'Delgado',   '1970-03-03', '(502) 555-2006', 'mdelgado@example.com',   true)
on conflict (id) do nothing;

-- Providers -------------------------------------------------------------
insert into providers (id, name, type, npi, phone, fax, email, is_miispine, emr_system) values
  ('d0000000-0000-0000-0000-000000000001', 'miiSpine Surgery Center', 'spine_surgery', '1487654321', '(502) 555-9000', '(502) 555-9001', 'billing@miispine.com', true,  'modmed'),
  ('d0000000-0000-0000-0000-000000000002', 'Derby City Imaging',      'imaging',       '1590001111', '(502) 555-9100', '(502) 555-9101', 'records@derbyimaging.com', false, 'epic'),
  ('d0000000-0000-0000-0000-000000000003', 'Ohio Valley Pain Mgmt',   'pain_mgmt',     '1670002222', '(502) 555-9200', '(502) 555-9201', 'billing@ovpain.com',   false, 'manual'),
  ('d0000000-0000-0000-0000-000000000004', 'Active Life Chiropractic','chiropractic',  '1780003333', '(859) 555-9300', '(859) 555-9301', 'front@activelifechiro.com', false, 'manual')
on conflict (id) do nothing;

-- Cases -----------------------------------------------------------------
-- last_outreach_at / next_followup_at / followup_priority drive the autopilot queue.
insert into cases (id, firm_id, attorney_id, client_id, claim_number, date_of_loss, accident_type, liability_carrier, status, opened_at, mmi_date, last_outreach_at, next_followup_at, followup_priority) values
  ('ca000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'a1111111-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'CLM-88231', current_date - 210, 'MVA',        'State Farm',   'mmi_reached',       current_date - 210, current_date - 60,  now() - interval '20 days', now() - interval '2 days', 'urgent'),
  ('ca000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'a1111111-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000002', 'CLM-88240', current_date - 95,  'slip-fall',  'Allstate',     'treatment_complete',current_date - 95,  null,               now() - interval '9 days',  now() - interval '1 days', 'high'),
  ('ca000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'a1111111-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000003', 'CLM-88255', current_date - 40,  'MVA',        'Progressive',  'active',            current_date - 40,  null,               null,                       null,                       'normal'),
  ('ca000000-0000-0000-0000-000000000004', '22222222-2222-2222-2222-222222222222', 'a2222222-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000004', 'CLM-77012', current_date - 150, 'workplace',  'Liberty Mutual','demand_sent',      current_date - 150, current_date - 30,  now() - interval '5 days',  now() + interval '4 days', 'high'),
  ('ca000000-0000-0000-0000-000000000005', '22222222-2222-2222-2222-222222222222', 'a2222222-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000005', 'CLM-77020', current_date - 20,  'MVA',        'GEICO',        'active',            current_date - 20,  null,               now() - interval '3 days',  now() - interval '1 days', 'low'),
  ('ca000000-0000-0000-0000-000000000006', '11111111-1111-1111-1111-111111111111', 'a1111111-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000006', 'CLM-88260', current_date - 300, 'MVA',        'Nationwide',   'negotiating',       current_date - 300, current_date - 120, now() - interval '45 days', now() - interval '10 days','urgent')
on conflict (id) do nothing;

-- PIP ledgers -----------------------------------------------------------
insert into pip_ledger (case_id, firm_id, carrier, claim_number, total_available, total_submitted, total_paid, total_pending, status) values
  ('ca000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'State Farm',    'PIP-88231', 10000, 10000, 10000, 0,    'exhausted'),
  ('ca000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'Allstate',      'PIP-88240', 10000, 6500,  4200,  2300, 'open'),
  ('ca000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'Progressive',   'PIP-88255', 10000, 1800,  1800,  0,    'open'),
  ('ca000000-0000-0000-0000-000000000004', '22222222-2222-2222-2222-222222222222', 'Liberty Mutual','PIP-77012', 10000, 10000, 10000, 0,    'exhausted'),
  ('ca000000-0000-0000-0000-000000000005', '22222222-2222-2222-2222-222222222222', 'GEICO',         'PIP-77020', 10000, 900,   900,   0,    'open'),
  ('ca000000-0000-0000-0000-000000000006', '11111111-1111-1111-1111-111111111111', 'Nationwide',    'PIP-88260', 10000, 10000, 10000, 0,    'exhausted')
on conflict (case_id) do nothing;

-- Medical bills ---------------------------------------------------------
-- Inserting these fires the AR-rollup trigger, populating cases.total_* and collateral_calc.
insert into medical_bills (case_id, firm_id, provider_id, date_of_service, cpt_code, description, billed_amount, pip_submitted, pip_paid, insurance_paid, lien_amount, lien_type, lien_tier, collected_amount, bill_status) values
  -- Case 1: exhausted PIP, large surgical lien outstanding
  ('ca000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'd0000000-0000-0000-0000-000000000002', current_date - 205, '72148', 'MRI lumbar spine',         3200,  3200, 3200, 0, 0,     null,          null, 0, 'pip_paid'),
  ('ca000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'd0000000-0000-0000-0000-000000000001', current_date - 150, '63030', 'Lumbar microdiscectomy',   42000, 6800, 6800, 0, 58000, 'surgical',    'tier_1', 0, 'lien_active'),
  ('ca000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'd0000000-0000-0000-0000-000000000003', current_date - 120, '64483', 'Transforaminal injection', 4500,  0,    0,    0, 4500,  'conservative','tier_2', 0, 'lien_active'),
  -- Case 2: still in treatment, conservative liens
  ('ca000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'd0000000-0000-0000-0000-000000000004', current_date - 80, '98941', 'Chiropractic manipulation', 2600, 2600, 2100, 0, 500,  'conservative','tier_3', 0, 'pip_paid'),
  ('ca000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'd0000000-0000-0000-0000-000000000002', current_date - 70, '73721', 'MRI knee',                  2800, 2800, 2100, 0, 700,  'imaging',     'tier_3', 0, 'pip_pending'),
  -- Case 3: early, PIP covering
  ('ca000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'd0000000-0000-0000-0000-000000000003', current_date - 30, '99204', 'New patient eval',          1800, 1800, 1800, 0, 0,    null,          null, 0, 'pip_paid'),
  -- Case 4: demand sent, mixed surgical + imaging liens
  ('ca000000-0000-0000-0000-000000000004', '22222222-2222-2222-2222-222222222222', 'd0000000-0000-0000-0000-000000000001', current_date - 110, '22551', 'ACDF C5-C6',               51000, 6800, 6800, 0, 61000, 'surgical',    'tier_1', 0, 'lien_active'),
  ('ca000000-0000-0000-0000-000000000004', '22222222-2222-2222-2222-222222222222', 'd0000000-0000-0000-0000-000000000002', current_date - 130, '72141', 'MRI cervical spine',        3200,  3200, 3200, 0, 0,     null,          null, 0, 'pip_paid'),
  -- Case 5: brand new
  ('ca000000-0000-0000-0000-000000000005', '22222222-2222-2222-2222-222222222222', 'd0000000-0000-0000-0000-000000000004', current_date - 15, '99203', 'New patient eval',           900,  900,  900,  0, 0,    null,          null, 0, 'pip_paid'),
  -- Case 6: long-running, partial collection
  ('ca000000-0000-0000-0000-000000000006', '11111111-1111-1111-1111-111111111111', 'd0000000-0000-0000-0000-000000000001', current_date - 240, '63047', 'Lumbar laminectomy',        47000, 6800, 6800, 0, 62000, 'surgical',    'tier_1', 0, 'negotiating'),
  ('ca000000-0000-0000-0000-000000000006', '11111111-1111-1111-1111-111111111111', 'd0000000-0000-0000-0000-000000000003', current_date - 200, '64493', 'Facet joint injection',      5200,  0,   0,    0, 5200,  'conservative','tier_2', 0, 'lien_active')
on conflict do nothing;

-- Give case 6 a partial collection to exercise the balance math.
update medical_bills
   set collected_amount = 25000, negotiated_amount = 40000, bill_status = 'negotiating'
 where case_id = 'ca000000-0000-0000-0000-000000000006'
   and cpt_code = '63047';

-- Milestones (latest first drives the autopilot email context) ----------
insert into milestones (case_id, firm_id, milestone_type, planned_date, actual_date, notes) values
  ('ca000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'mmi',          current_date - 60,  current_date - 60,  'Reached MMI, permanent restrictions'),
  ('ca000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'surgery',      current_date - 150, current_date - 150, 'Microdiscectomy performed'),
  ('ca000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'imaging_complete', current_date - 70, current_date - 70, 'Knee MRI complete'),
  ('ca000000-0000-0000-0000-000000000004', '22222222-2222-2222-2222-222222222222', 'demand_ready', current_date - 35,  current_date - 32,  'Demand package assembled'),
  ('ca000000-0000-0000-0000-000000000006', '11111111-1111-1111-1111-111111111111', 'settlement_ready', current_date - 130, current_date - 125, 'Awaiting carrier counter')
on conflict do nothing;

-- Deadlines -------------------------------------------------------------
insert into deadlines (case_id, firm_id, deadline_type, deadline_date, status) values
  ('ca000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'statute_of_limitations', current_date + 520, 'active'),
  ('ca000000-0000-0000-0000-000000000004', '22222222-2222-2222-2222-222222222222', 'demand_response',        current_date + 8,   'active'),
  ('ca000000-0000-0000-0000-000000000006', '11111111-1111-1111-1111-111111111111', 'mediation',              current_date + 21,  'active')
on conflict do nothing;

-- A little outreach history so days-since-last renders in the queue.
insert into outreach_log (case_id, firm_id, attorney_id, channel, direction, subject, body, ai_generated, sent_by, sent_at, outcome) values
  ('ca000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'a1111111-0000-0000-0000-000000000001', 'email', 'outbound', 'Status update — Whitfield lien', 'Checking in on settlement posture and the outstanding surgical lien.', true, 'autopilot', now() - interval '20 days', 'no_response'),
  ('ca000000-0000-0000-0000-000000000006', '11111111-1111-1111-1111-111111111111', 'a1111111-0000-0000-0000-000000000002', 'email', 'outbound', 'Delgado — mediation prep', 'Following up ahead of mediation on the reduced lien figure.', true, 'autopilot', now() - interval '45 days', 'update_received')
on conflict do nothing;

-- Medical records (some uploaded with a storage_key, some requested) -----
insert into records (case_id, firm_id, provider_id, record_type, status, storage_key, filename, requested_date, received_date, uploaded_at) values
  ('ca000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'd0000000-0000-0000-0000-000000000001', 'op_report',  'uploaded',  'ca000000-0000-0000-0000-000000000001/op_report.pdf', 'op_report_2025-03.pdf', current_date - 150, current_date - 148, now() - interval '148 days'),
  ('ca000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'd0000000-0000-0000-0000-000000000002', 'imaging',    'uploaded',  'ca000000-0000-0000-0000-000000000001/mri.pdf',       'mri_lumbar.pdf',        current_date - 205, current_date - 203, now() - interval '203 days'),
  ('ca000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', null,                                     'mmi_letter', 'requested', null, null, current_date - 10, null, null),
  ('ca000000-0000-0000-0000-000000000004', '22222222-2222-2222-2222-222222222222', 'd0000000-0000-0000-0000-000000000001', 'op_report',  'uploaded',  'ca000000-0000-0000-0000-000000000004/acdf_op.pdf',   'acdf_op_report.pdf',    current_date - 110, current_date - 108, now() - interval '108 days'),
  ('ca000000-0000-0000-0000-000000000004', '22222222-2222-2222-2222-222222222222', null,                                     'imaging',    'requested', null, null, current_date - 4, null, null)
on conflict do nothing;
