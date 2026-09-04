-- ============================================================
-- miiCase — patient names read "Last, First" (ModMed's convention)
-- 0026_name_convention.sql
-- ============================================================
-- The dashboard now renders clients as "Last, First"; the autopilot queue
-- view is the one server-side surface that composes a display name, so it
-- follows suit. Identical to 0025's definition except patient_name.

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
  concat_ws(', ', nullif(cl.last_name, ''), nullif(cl.first_name, '')) as patient_name,
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
