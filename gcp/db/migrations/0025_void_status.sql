-- ============================================================
-- miiCase — 'void' status for cases created in error
-- 0025_void_status.sql
-- ============================================================
-- Junk from the import (test rows, blank patients, never-real cases) needs a
-- way out of every view — including Settled — without hard deletion. 'void'
-- joins the status lifecycle: excluded from the AR aging and autopilot views
-- here, and from every dashboard list client-side; the row, its history, and
-- its audit trail remain. Staff-only (route-enforced) and reversible (reopen
-- sets it back to active).

alter table cases drop constraint if exists cases_status_check;
alter table cases add constraint cases_status_check
  check (status in (
    'active','treatment_complete','mmi_reached',
    'demand_sent','negotiating','settled','closed','disputed','void'
  ));

-- Views: void cases are nobody's worklist and nobody's receivable.
-- Identical to 0004's definition except 'void' joins the exclusion list.
create or replace view autopilot_queue
with (security_invoker = on) as
select
  c.id,
  c.firm_id,
  c.status,
  c.followup_priority,
  c.balance_outstanding,
  c.last_outreach_at,
  c.next_followup_at,
  case when c.last_outreach_at is null then null
       else current_date - c.last_outreach_at::date end as days_since_outreach,
  a.name  as attorney_name,
  a.email as attorney_email,
  a.avg_response_days,
  a.preferred_contact,
  f.name  as firm_name,
  cl.first_name || ' ' || cl.last_name as patient_name,
  -- Priority score: higher = more urgent
  (
    case c.followup_priority
      when 'urgent' then 100
      when 'high'   then 60
      when 'normal' then 30
      when 'low'    then 10
      else 0
    end
    + least(
        current_date - coalesce(c.last_outreach_at::date, c.opened_at),
        60
      )  -- age factor, capped at 60 days
    + case when c.balance_outstanding > 50000 then 30
           when c.balance_outstanding > 20000 then 15
           else 0
      end
  ) as priority_score
from cases c
join attorneys a on a.id = c.attorney_id
join firms f     on f.id = c.firm_id
join clients cl  on cl.id = c.client_id
where c.status not in ('closed','settled','void')
  and c.followup_priority <> 'hold'
  and (c.next_followup_at is null or c.next_followup_at <= now())
order by priority_score desc;

create or replace view ar_aging
with (security_invoker = on) as
select
  c.firm_id,
  f.name as firm,
  count(*) as case_count,
  sum(c.balance_outstanding) as total_outstanding,
  sum(case when current_date - c.opened_at <= 30
       then c.balance_outstanding else 0 end) as bucket_0_30,
  sum(case when current_date - c.opened_at between 31 and 60
       then c.balance_outstanding else 0 end) as bucket_31_60,
  sum(case when current_date - c.opened_at between 61 and 90
       then c.balance_outstanding else 0 end) as bucket_61_90,
  sum(case when current_date - c.opened_at between 91 and 180
       then c.balance_outstanding else 0 end) as bucket_91_180,
  sum(case when current_date - c.opened_at > 180
       then c.balance_outstanding else 0 end) as bucket_180_plus
from cases c
join firms f on f.id = c.firm_id
where c.status not in ('closed','void')
group by c.firm_id, f.name
order by total_outstanding desc;
