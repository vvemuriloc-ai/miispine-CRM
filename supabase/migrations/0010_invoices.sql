-- ============================================================
-- miiCase / miiSpine AR — Collections invoices to the firm
-- 0010_invoices.sql
-- ============================================================
-- miiSpine issues an invoice to the attorney's firm for a case's outstanding
-- lien, with a sequential number, issue/due dates, and payment tracking. Firms
-- see their own invoices (read-only); only miiSpine staff issue them and record
-- payments. A payment ledger rolls up onto the invoice and drives its status.
-- ============================================================

create sequence if not exists invoice_seq;

create table if not exists invoices (
  id           uuid primary key default gen_random_uuid(),
  invoice_no   text unique,
  case_id      uuid references cases(id) not null,
  firm_id      uuid references firms(id) not null,   -- for RLS
  amount       numeric not null default 0,           -- issued amount (snapshot of outstanding lien)
  amount_paid  numeric not null default 0,           -- rolled up from invoice_payments
  balance_due  numeric generated always as (amount - amount_paid) stored,
  status       text default 'draft'
               check (status in ('draft','sent','partial','paid','void')),
  issue_date   date,
  due_date     date,
  sent_date    date,
  paid_date    date,
  memo         text,
  created_by   text,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);

create table if not exists invoice_payments (
  id          uuid primary key default gen_random_uuid(),
  invoice_id  uuid references invoices(id) on delete cascade not null,
  firm_id     uuid references firms(id) not null,    -- for RLS (denormalized)
  amount      numeric not null,
  paid_on     date not null default current_date,
  method      text check (method in ('check','ach','card','wire','other')),
  note        text,
  created_at  timestamptz default now()
);

create index if not exists idx_invoices_case         on invoices(case_id);
create index if not exists idx_invoices_firm          on invoices(firm_id);
create index if not exists idx_invoices_status        on invoices(status);
create index if not exists idx_invoice_payments_inv   on invoice_payments(invoice_id);
create index if not exists idx_invoice_payments_firm  on invoice_payments(firm_id);

-- ---- Invoice number + updated_at ---------------------------
create or replace function set_invoice_no()
returns trigger language plpgsql as $$
begin
  if new.invoice_no is null then
    new.invoice_no := 'MII-' || to_char(coalesce(new.issue_date, current_date), 'YYYY')
                      || '-' || lpad(nextval('invoice_seq')::text, 4, '0');
  end if;
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists trg_invoice_no on invoices;
create trigger trg_invoice_no before insert on invoices
  for each row execute function set_invoice_no();

drop trigger if exists trg_invoice_updated on invoices;
create trigger trg_invoice_updated before update on invoices
  for each row execute function set_updated_at();   -- from 0004

-- ---- Payment ledger rolls up onto the invoice --------------
create or replace function rollup_invoice(p_invoice uuid)
returns void language plpgsql as $$
declare v_paid numeric; v_amount numeric; v_status text;
begin
  select coalesce(sum(amount), 0) into v_paid from invoice_payments where invoice_id = p_invoice;
  select amount, status into v_amount, v_status from invoices where id = p_invoice;
  update invoices set
    amount_paid = v_paid,
    status = case
      when v_status = 'void' then 'void'
      when v_amount > 0 and v_paid >= v_amount then 'paid'
      when v_paid > 0 then 'partial'
      when v_status in ('paid','partial') then 'sent'   -- payment removed
      else v_status end,
    paid_date = case when v_amount > 0 and v_paid >= v_amount then coalesce(paid_date, current_date) else null end
  where id = p_invoice;
end;
$$;

create or replace function trg_invoice_payment()
returns trigger language plpgsql as $$
begin
  perform rollup_invoice(coalesce(new.invoice_id, old.invoice_id));
  return coalesce(new, old);
end;
$$;
drop trigger if exists trg_invoice_payment on invoice_payments;
create trigger trg_invoice_payment after insert or update or delete on invoice_payments
  for each row execute function trg_invoice_payment();

-- ---- RLS: firms read their own; staff issue + record payments ----
alter table invoices enable row level security;
drop policy if exists invoices_select on invoices;
create policy invoices_select on invoices
  for select using (auth_is_staff() or firm_id = auth_firm_id());
drop policy if exists invoices_insert on invoices;
create policy invoices_insert on invoices for insert with check (auth_is_staff());
drop policy if exists invoices_update on invoices;
create policy invoices_update on invoices for update using (auth_is_staff()) with check (auth_is_staff());
drop policy if exists invoices_delete on invoices;
create policy invoices_delete on invoices for delete using (auth_is_staff());

alter table invoice_payments enable row level security;
drop policy if exists inv_pay_select on invoice_payments;
create policy inv_pay_select on invoice_payments
  for select using (auth_is_staff() or firm_id = auth_firm_id());
drop policy if exists inv_pay_write on invoice_payments;
create policy inv_pay_write on invoice_payments for all using (auth_is_staff()) with check (auth_is_staff());

-- ---- Reporting view: invoices with names + effective (overdue) status ----
create or replace view invoices_view
with (security_invoker = on) as
select
  i.id, i.invoice_no, i.case_id, i.firm_id,
  i.amount, i.amount_paid, i.balance_due, i.status,
  i.issue_date, i.due_date, i.sent_date, i.paid_date, i.memo,
  case
    when i.status in ('sent','partial') and i.due_date is not null
         and i.due_date < current_date and i.balance_due > 0 then 'overdue'
    else i.status
  end as effective_status,
  f.name as firm_name,
  c.claim_number,
  cl.first_name || ' ' || cl.last_name as patient_name
from invoices i
join firms f    on f.id = i.firm_id
join cases c    on c.id = i.case_id
join clients cl on cl.id = c.client_id;
