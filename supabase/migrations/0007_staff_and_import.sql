-- ============================================================
-- miiCase / miiSpine AR — miiSpine staff role + spreadsheet import
-- 0007_staff_and_import.sql
-- ============================================================
-- 1. Adds an internal "miiSpine staff" role that sees ALL firms (the AR team
--    works the whole book), while leaving per-firm isolation intact so
--    attorney portals can be switched on later.
-- 2. Adds a few case fields the legacy sheet carries (assigned_to, notes,
--    health insurance).
-- 3. A `staging_import` landing table + `normalize_import()` that turns the
--    flat, messy worklist rows into the normalized model, deduped, with junk
--    routed to a review flag instead of being silently coerced.
-- ============================================================

-- ---- Case fields the legacy sheet carries ------------------
alter table cases add column if not exists assigned_to      text;  -- miiSpine staffer working it
alter table cases add column if not exists notes            text;  -- free-text last note
alter table cases add column if not exists health_insurance text;  -- "Medical Insurance" column

-- ============================================================
-- miiSpine staff role
-- ============================================================
-- Staff users have is_staff = true and may have a null firm_id.
alter table user_profiles alter column firm_id drop not null;
alter table user_profiles add column if not exists is_staff boolean default false;
alter table user_profiles drop constraint if exists user_profiles_firm_or_staff;
alter table user_profiles add constraint user_profiles_firm_or_staff
  check (firm_id is not null or is_staff);

-- Reads the is_staff claim the hook stamps into the JWT.
create or replace function auth_is_staff()
returns boolean language sql stable as $$
  select coalesce(
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'is_staff')::boolean,
    false);
$$;

-- Re-issue the access-token hook to also carry is_staff.
create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb language plpgsql stable as $$
declare
  claims    jsonb;
  v_firm_id uuid;
  v_role    text;
  v_staff   boolean;
begin
  select firm_id, role, is_staff into v_firm_id, v_role, v_staff
  from public.user_profiles
  where user_id = (event->>'user_id')::uuid;

  claims := coalesce(event->'claims', '{}'::jsonb);
  if v_firm_id is not null then
    claims := jsonb_set(claims, '{firm_id}',   to_jsonb(v_firm_id::text));
    claims := jsonb_set(claims, '{firm_role}', to_jsonb(coalesce(v_role, 'staff')));
  end if;
  claims := jsonb_set(claims, '{is_staff}', to_jsonb(coalesce(v_staff, false)));

  return jsonb_set(event, '{claims}', claims);
end;
$$;

-- Re-create every firm-isolation policy with a staff bypass.
do $$
declare
  t text;
  firm_scoped text[] := array[
    'cases','pip_ledger','medical_bills','records','milestones',
    'settlement_events','deadlines','outreach_log','demand_drafts',
    'collateral_calc'
  ];
begin
  foreach t in array firm_scoped loop
    execute format('drop policy if exists firm_isolation on %I;', t);
    execute format(
      'create policy firm_isolation on %I
         using (auth_is_staff() or firm_id = auth_firm_id())
         with check (auth_is_staff() or firm_id = auth_firm_id());', t);
  end loop;
end$$;

-- Reference tables: staff see all.
drop policy if exists firm_self on firms;
create policy firm_self on firms
  for select using (auth_is_staff() or id = auth_firm_id());

drop policy if exists attorney_firm on attorneys;
create policy attorney_firm on attorneys
  for select using (auth_is_staff() or firm_id = auth_firm_id());

drop policy if exists client_by_case on clients;
create policy client_by_case on clients
  for select using (
    auth_is_staff() or exists (
      select 1 from cases c
      where c.client_id = clients.id and c.firm_id = auth_firm_id()
    )
  );

-- audit_log: staff read the whole trail.
drop policy if exists audit_select on audit_log;
create policy audit_select on audit_log
  for select using (auth_is_staff() or firm_id = auth_firm_id());

-- Admin helper: mark a user as miiSpine staff (cross-firm).
create or replace function public.assign_staff(p_email text)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid;
begin
  select id into v_uid from auth.users where email = p_email;
  if v_uid is null then raise exception 'no auth user with email %', p_email; end if;
  insert into user_profiles(user_id, firm_id, role, is_staff)
  values (v_uid, null, 'admin', true)
  on conflict (user_id) do update set is_staff = true, role = 'admin';
end;
$$;
revoke execute on function public.assign_staff(text) from anon, authenticated, public;

-- ============================================================
-- Import: staging table + cleaning helpers + normalize()
-- ============================================================
create table if not exists staging_import (
  id                bigserial primary key,
  source_tab        text,
  source_row        int,
  patient_name      text,
  pip_claim         text,
  doi_raw           text,
  charges_raw       text,
  medical_insurance text,
  lien_on_file      text,
  pip_payer         text,
  attorney          text,
  status_raw        text,
  last_action_raw   text,
  notes             text,
  voice_mail        text,
  assigned_to       text,
  faxed             text,
  needs_review      boolean default false,
  review_reason     text,
  imported_case_id  uuid
);

-- Dedup keys for idempotent upserts.
create unique index if not exists uq_providers_name on providers (lower(name));

-- Cleaning helpers (immutable so they can back expression indexes) ----
create or replace function import_parse_money(t text) returns numeric language sql immutable as $$
  select case when coalesce(t,'') ~ '[0-9]'
    then nullif(regexp_replace(t, '[^0-9.\-]', '', 'g'), '')::numeric else null end;
$$;

-- Excel serial date → date (epoch 1899-12-30). Only 4–5 digit serials.
create or replace function import_parse_date(t text) returns date language sql immutable as $$
  select case when trim(coalesce(t,'')) ~ '^[0-9]{4,5}(\.0+)?$'
    then date '1899-12-30' + floor(trim(t)::numeric)::int else null end;
$$;

create or replace function import_lien(t text) returns boolean language sql immutable as $$
  select case lower(trim(coalesce(t,'')))
    when 'yes' then true when 'y' then true
    when 'no' then false when 'n' then false else null end;
$$;

create or replace function import_is_paid(t text) returns boolean language sql immutable as $$
  select lower(trim(coalesce(t,''))) like 'paid%';
$$;

create or replace function import_pip_status(t text) returns text language sql immutable as $$
  select case
    when lower(trim(coalesce(t,''))) like 'paid%'    then 'closed'
    when lower(coalesce(t,'')) like 'exhaust%'        then 'exhausted'
    when lower(coalesce(t,'')) like 'reserv%'         then 'reserved'
    when lower(coalesce(t,'')) like 'open%'           then 'open'
    else null end;
$$;

-- Display name: drop parenthetical phone notes, trailing punctuation.
create or replace function import_firm_display(t text) returns text language sql immutable as $$
  select nullif(trim(regexp_replace(
           regexp_replace(coalesce(t,''), '\([^)]*\)', '', 'g'),
           '[,\-\s]+$', '')), '');
$$;

-- Dedup key: alnum-only, entity suffix (PLLC/LLC/…) stripped, so
-- "Pittenger Law Office" and "Pittenger Law Office, PLLC" collapse to one firm.
create or replace function import_firm_key(t text) returns text language sql immutable as $$
  select regexp_replace(
           regexp_replace(
             lower(regexp_replace(coalesce(t,''), '\([^)]*\)', '', 'g')),
             '[^a-z0-9]+', '', 'g'),
           '(pllc|llc|pc|plc|pa)$', '');
$$;

create unique index if not exists uq_firms_import_key on firms (import_firm_key(name));

-- ---- The normalizer ----------------------------------------
create or replace function normalize_import()
returns table(cases_created int, firms_total int, rows_flagged int)
language plpgsql as $$
declare
  v_prov uuid; rec record;
  v_firm uuid; v_client uuid; v_case uuid;
  v_first text; v_last text; v_charges numeric; v_lien boolean;
  v_doi date; v_las date; v_pip text; v_paid boolean;
  v_review boolean; v_reason text;
  n_imp int := 0; n_rev int := 0;
begin
  -- One miiSpine provider carries the aggregate charges.
  insert into providers(name, type, is_miispine, emr_system)
    values ('miiSpine Surgery Center', 'spine_surgery', true, 'modmed')
    on conflict (lower(name)) do nothing;
  select id into v_prov from providers where lower(name) = 'miispine surgery center' limit 1;

  -- Firms (deduped by import_firm_key), plus a catch-all.
  insert into firms(name)
    select distinct on (import_firm_key(attorney)) import_firm_display(attorney)
    from staging_import
    where import_firm_display(attorney) is not null
    order by import_firm_key(attorney)
    on conflict (import_firm_key(name)) do nothing;
  insert into firms(name) values ('Unassigned (import)')
    on conflict (import_firm_key(name)) do nothing;

  -- One representative row per (patient, claim): prefer paid, then latest action.
  for rec in
    select distinct on (lower(trim(patient_name)), coalesce(nullif(lower(trim(pip_claim)), ''), '~n~')) *
    from staging_import
    where coalesce(trim(patient_name), '') <> ''
    order by lower(trim(patient_name)),
             coalesce(nullif(lower(trim(pip_claim)), ''), '~n~'),
             import_is_paid(status_raw) desc,
             import_parse_date(last_action_raw) desc nulls last,
             id
  loop
    v_review := false; v_reason := '';
    v_last  := trim(split_part(rec.patient_name, ',', 1));
    v_first := nullif(trim(split_part(rec.patient_name, ',', 2)), '');
    if v_first is null then v_review := true; v_reason := v_reason || 'no-comma-name; '; v_first := ''; end if;

    v_charges := import_parse_money(rec.charges_raw);
    if v_charges is null then v_review := true; v_reason := v_reason || 'charges-unparsed; '; v_charges := 0; end if;

    v_lien := import_lien(rec.lien_on_file);
    v_doi  := import_parse_date(rec.doi_raw);
    v_las  := import_parse_date(rec.last_action_raw);
    v_pip  := import_pip_status(rec.status_raw);
    if v_pip is null then v_review := true; v_reason := v_reason || 'status-unrecognized; '; v_pip := 'open'; end if;
    v_paid := import_is_paid(rec.status_raw);

    if import_firm_display(rec.attorney) is null then
      v_review := true; v_reason := v_reason || 'no-attorney; ';
      select id into v_firm from firms where import_firm_key(name) = import_firm_key('Unassigned (import)') limit 1;
    else
      select id into v_firm from firms where import_firm_key(name) = import_firm_key(rec.attorney) limit 1;
    end if;

    -- Client (deduped by name for this one-time load).
    select id into v_client from clients
      where lower(last_name) = lower(v_last)
        and lower(coalesce(first_name, '')) = lower(coalesce(v_first, '')) limit 1;
    if v_client is null then
      insert into clients(first_name, last_name) values (coalesce(v_first, ''), v_last) returning id into v_client;
    end if;

    -- Case (skip if this client+claim+firm already imported → re-run safe).
    select id into v_case from cases
      where client_id = v_client
        and coalesce(claim_number, '') = coalesce(nullif(trim(rec.pip_claim), ''), '')
        and firm_id = v_firm limit 1;

    if v_case is null then
      insert into cases(firm_id, client_id, claim_number, date_of_injury, liability_carrier,
                        status, opened_at, last_outreach_at, followup_priority,
                        assigned_to, notes, health_insurance)
        values (v_firm, v_client, nullif(trim(rec.pip_claim), ''), v_doi, nullif(trim(rec.pip_payer), ''),
                case when v_paid then 'settled' else 'active' end,
                coalesce(v_doi, v_las, current_date), v_las::timestamptz, 'normal',
                nullif(trim(rec.assigned_to), ''), nullif(trim(rec.notes), ''), nullif(trim(rec.medical_insurance), ''))
        returning id into v_case;

      insert into pip_ledger(case_id, firm_id, carrier, claim_number, status, total_available, total_paid)
        values (v_case, v_firm, nullif(trim(rec.pip_payer), ''), nullif(trim(rec.pip_claim), ''),
                case when v_paid then 'closed' else v_pip end,
                10000, case when v_pip = 'exhausted' then 10000 else 0 end)
        on conflict (case_id) do nothing;

      insert into medical_bills(case_id, firm_id, provider_id, date_of_service, description,
                               billed_amount, lien_amount, lien_type, collected_amount, bill_status)
        values (v_case, v_firm, v_prov, coalesce(v_doi, v_las, current_date), 'Imported aggregate charges',
                v_charges,
                case when coalesce(v_lien, false) then v_charges else 0 end,
                case when coalesce(v_lien, false) then 'other' else null end,
                case when v_paid then v_charges else 0 end,
                case when v_paid then 'settled'
                     when coalesce(v_lien, false) then 'lien_active' else 'outstanding' end);

      if nullif(trim(rec.notes), '') is not null then
        insert into outreach_log(case_id, firm_id, channel, direction, body, ai_generated, sent_by, sent_at)
          values (v_case, v_firm, 'portal_alert', 'outbound', rec.notes, false,
                  nullif(trim(rec.assigned_to), ''), v_las::timestamptz);
      end if;

      n_imp := n_imp + 1;
    end if;

    if v_review then n_rev := n_rev + 1; end if;
    update staging_import set imported_case_id = v_case, needs_review = v_review,
                              review_reason = nullif(v_reason, '') where id = rec.id;
  end loop;

  return query select n_imp, (select count(*)::int from firms), n_rev;
end;
$$;

-- Reconciliation snapshot — compare against the spreadsheet before trusting it.
create or replace view import_reconcile as
select
  (select count(*) from staging_import where coalesce(trim(patient_name), '') <> '')  as staging_rows,
  (select count(distinct imported_case_id) from staging_import
     where imported_case_id is not null)                                              as cases_created,
  (select count(*) from staging_import where needs_review)                            as rows_flagged,
  (select count(*) from firms)                                                        as firms,
  (select count(*) from clients)                                                      as clients,
  (select round(sum(billed_amount)) from medical_bills)                               as total_billed,
  (select round(sum(balance_outstanding)) from cases)                                 as total_outstanding;
