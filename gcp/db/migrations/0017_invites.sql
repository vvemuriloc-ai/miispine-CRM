-- ============================================================
-- miiCase — email invites: self-serve onboarding for staff + attorneys
-- 0017_invites.sql
-- ============================================================
-- Staff create an invite (email + role). When someone signs in with a
-- VERIFIED Firebase email that matches a pending invite, the API calls
-- claim_invite() and the profile is created on the spot — no console,
-- no UID copying, no SQL. The email match is against the Firebase token's
-- verified email (server-side), never client input.
-- ============================================================

create table if not exists user_invites (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,
  is_staff    boolean not null default false,
  firm_id     uuid references firms(id),
  role        text not null default 'staff',   -- user_profiles.role: firm members are 'staff' (of the firm), miiSpine staff 'admin'
  invited_by  text,                              -- staff uid
  created_at  timestamptz default now(),
  claimed_at  timestamptz,
  claimed_uid text,
  constraint invite_staff_or_firm check (is_staff or firm_id is not null)
);
-- One pending invite per address.
create unique index if not exists uq_user_invites_pending
  on user_invites(lower(email)) where claimed_at is null;

alter table user_invites enable row level security;
drop policy if exists user_invites_staff on user_invites;
create policy user_invites_staff on user_invites for all
  using (auth_is_staff()) with check (auth_is_staff());

-- Claim: SECURITY DEFINER so the miicase_app role can create the profile row
-- for a first-time user (RLS on user_profiles/user_invites doesn't apply
-- inside). p_email MUST come from a verified Firebase token.
create or replace function claim_invite(p_uid text, p_email text)
returns table(user_id text, firm_id uuid, is_staff boolean, role text)
language plpgsql security definer as $$
declare
  inv user_invites%rowtype;
begin
  select * into inv from user_invites i
   where lower(i.email) = lower(p_email) and i.claimed_at is null
   limit 1;
  if not found then return; end if;

  if inv.is_staff then
    perform assign_staff(p_uid, p_email);
  else
    perform assign_user_to_firm(p_uid, p_email, inv.firm_id, inv.role);
  end if;

  update user_invites set claimed_at = now(), claimed_uid = p_uid where id = inv.id;

  return query
    select up.user_id, up.firm_id, up.is_staff, up.role
    from user_profiles up where up.user_id = p_uid;
end;
$$;

grant execute on function claim_invite(text, text) to miicase_app;
