-- ============================================================
-- miiCase / miiSpine AR — Autopilot & dashboard views
-- 0003_views.sql
-- ============================================================
-- `security_invoker = on` makes these views run with the querying user's
-- permissions, so firm-isolation RLS (0002) applies when the portal reads them.
-- The autopilot edge function uses the service_role key and bypasses RLS.
-- ============================================================

-- Cases due for follow-up (sorted by priority score).
-- Fixes vs the original draft:
--   * COALESCE last_outreach_at → opened_at so a never-contacted case still
--     produces a numeric age factor instead of a NULL priority_score that
--     sorts unpredictably and hides the most-neglected cases.
--   * days_since_outreach is null when there has been no prior outreach.
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
where c.status not in ('closed','settled')
  and c.followup_priority <> 'hold'
  and (c.next_followup_at is null or c.next_followup_at <= now())
order by priority_score desc;

-- AR aging summary (the dashboard view)
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
where c.status <> 'closed'
group by c.firm_id, f.name
order by total_outstanding desc;
