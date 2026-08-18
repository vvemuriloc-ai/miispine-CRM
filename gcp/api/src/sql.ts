// The data-access queries. Every query runs on a client already inside a
// withTenant() transaction, so RLS scopes results to the caller's firm (or the
// whole book for staff). No firm_id is ever taken from the client and trusted —
// isolation is the database's job, enforced here by RLS.
import type pg from "pg";

const CASE_LIST = `
  select c.id, c.claim_number, c.status, c.date_of_injury, c.accident_type,
         c.total_billed, c.total_lien, c.total_collected, c.balance_outstanding,
         c.followup_priority, c.next_followup_at, c.last_outreach_at,
         c.review_status, c.review_reason, c.emr_patient_id, c.emr_last_synced_at,
         c.firm_id, c.attorney_id, c.client_id,
         f.name as firm_name,
         a.name as attorney_name,
         cl.first_name, cl.last_name, cl.hipaa_release_on_file
  from cases c
  join firms f    on f.id = c.firm_id
  join clients cl on cl.id = c.client_id
  left join attorneys a on a.id = c.attorney_id
`;

export async function listCases(c: pg.PoolClient) {
  const r = await c.query(CASE_LIST + " order by c.balance_outstanding desc nulls last, c.claim_number");
  return r.rows;
}

export async function getCase(c: pg.PoolClient, id: string) {
  const head = await c.query(CASE_LIST + " where c.id = $1", [id]);
  if (!head.rows.length) return null;
  // One pooled connection can't run queries in parallel — sequential awaits.
  const bills = await c.query("select id, provider_id, date_of_service, cpt_code, description, billed_amount, pip_paid, insurance_paid, lien_amount, lien_manual, bill_status, emr_source from medical_bills where case_id = $1 order by date_of_service", [id]);
  const pip = await c.query("select carrier, claim_number, total_available, total_paid, balance_remaining, status from pip_ledger where case_id = $1", [id]);
  const records = await c.query("select id, provider_name, record_type, status, requested_date, received_date, filename, has_file, hipaa_release_on_file from case_records where case_id = $1 order by record_type", [id]);
  const invoices = await c.query("select id, invoice_no, amount, amount_paid, balance_due, status, effective_status, issue_date, due_date from invoices_view where case_id = $1 order by issue_date desc nulls last", [id]);
  const milestones = await c.query("select milestone_type, planned_date, actual_date, notes from milestones where case_id = $1 order by coalesce(actual_date, planned_date)", [id]);
  return {
    ...head.rows[0],
    bills: bills.rows, pip: pip.rows[0] ?? null,
    records: records.rows, invoices: invoices.rows, milestones: milestones.rows,
  };
}

// One bundle for the dashboard's initial load, cases in the nested "embed"
// shape the frontend's mapCaseRow expects. All queries run under RLS.
export async function getDashboard(c: pg.PoolClient) {
  const cases = (await c.query(
    `select c.id, c.claim_number, c.status, c.opened_at, c.followup_priority,
            c.last_outreach_at, c.next_followup_at, c.firm_id, c.review_status, c.review_reason,
            c.liability_carrier, c.health_insurance, c.assigned_to, c.date_of_injury,
            c.emr_patient_id,
            f.name as firm_name, a.name as attorney_name, a.email as attorney_email,
            a.avg_response_days, a.preferred_contact,
            cl.first_name, cl.last_name, cl.hipaa_release_on_file
       from cases c join firms f on f.id=c.firm_id join clients cl on cl.id=c.client_id
       left join attorneys a on a.id=c.attorney_id`)).rows;
  const ids = cases.map((r) => r.id);
  const grab = async (sql: string) => ids.length ? (await c.query(sql, [ids])).rows : [];
  const bills = await grab("select b.case_id, b.id, b.description, b.billed_amount, b.pip_paid, b.insurance_paid, b.lien_amount, b.lien_manual, b.collected_amount, p.name as provider_name, p.is_miispine from medical_bills b left join providers p on p.id=b.provider_id where b.case_id = any($1)");
  const pip = await grab("select case_id, status, balance_remaining from pip_ledger where case_id = any($1)");
  const ms = await grab("select case_id, milestone_type, actual_date from milestones where case_id = any($1) and actual_date is not null");
  const recs = await grab("select id, case_id, record_type, status, filename, (storage_key is not null) as has_file from records where case_id = any($1)");
  const byCase = (arr: any[]) => { const m = new Map<string, any[]>(); for (const r of arr) { (m.get(r.case_id) ?? m.set(r.case_id, []).get(r.case_id)!).push(r); } return m; };
  const bM = byCase(bills), mM = byCase(ms), rM = byCase(recs);
  const pM = new Map(pip.map((p) => [p.case_id, p]));
  const nested = cases.map((r) => ({
    id: r.id, claim_number: r.claim_number, status: r.status, opened_at: r.opened_at,
    followup_priority: r.followup_priority, last_outreach_at: r.last_outreach_at,
    next_followup_at: r.next_followup_at, firm_id: r.firm_id,
    review_status: r.review_status, review_reason: r.review_reason,
    liability_carrier: r.liability_carrier, health_insurance: r.health_insurance,
    assigned_to: r.assigned_to, date_of_injury: r.date_of_injury,
    emr_patient_id: r.emr_patient_id,
    firm: { id: r.firm_id, name: r.firm_name },
    attorney: { name: r.attorney_name, email: r.attorney_email, avg_response_days: r.avg_response_days, preferred_contact: r.preferred_contact },
    client: { first_name: r.first_name, last_name: r.last_name, hipaa_release_on_file: r.hipaa_release_on_file },
    pip_ledger: pM.has(r.id) ? [pM.get(r.id)] : [],
    medical_bills: (bM.get(r.id) ?? []).map((b) => ({ id: b.id, description: b.description, billed_amount: b.billed_amount, pip_paid: b.pip_paid, insurance_paid: b.insurance_paid, lien_amount: b.lien_amount, lien_manual: b.lien_manual, collected_amount: b.collected_amount, provider: { name: b.provider_name, is_miispine: b.is_miispine } })),
    milestones: (mM.get(r.id) ?? []).map((m) => ({ milestone_type: m.milestone_type, actual_date: m.actual_date })),
    records: (rM.get(r.id) ?? []).map((x) => ({ id: x.id, record_type: x.record_type, status: x.status, filename: x.filename, has_file: x.has_file })),
  }));
  const view = async (v: string) => (await c.query(`select * from ${v}`)).rows;
  return { cases: nested, ar_aging: await view("ar_aging"), autopilot_queue: await view("autopilot_queue"), invoices: await view("invoices_view") };
}

export const listView = (view: string) =>
  async (c: pg.PoolClient) => (await c.query(`select * from ${view}`)).rows;

// ---- Writes (RLS + triggers still apply) ----------------------------------
export async function createRecord(c: pg.PoolClient, b: any) {
  // Attorneys may only create requests; the records_attorney_guard trigger
  // strips storage_key and forces status='requested' for non-staff callers.
  const r = await c.query(
    `insert into records (case_id, firm_id, provider_id, record_type, status, storage_key, filename)
     values ($1,$2,$3,$4,coalesce($5,'requested'),$6,$7)
     returning id, case_id, firm_id, record_type, status, filename`,
    [b.case_id, b.firm_id, b.provider_id ?? null, b.record_type, b.status ?? null, b.storage_key ?? null, b.filename ?? null],
  );
  return r.rows[0];
}

// Fetch a record for download WITH its case's HIPAA-release flag. RLS
// (records_select) returns the row only if the caller's firm owns it or they
// are staff, so a cross-firm id simply comes back empty.
export async function recordForDownload(c: pg.PoolClient, id: string) {
  const r = await c.query(
    `select r.id, r.firm_id, r.storage_key, cl.hipaa_release_on_file
       from records r
       join cases cs on cs.id = r.case_id
       join clients cl on cl.id = cs.client_id
      where r.id = $1`, [id]);
  return r.rows[0] ?? null;
}

// Immutable audit row for a PHI disclosure. audit_insert RLS requires the
// caller's firm (or staff); the caller's firm matches the record's firm.
export async function writeAudit(c: pg.PoolClient, a: { user_id: string; firm_id: string; resource_id: string }) {
  await c.query(
    `insert into audit_log (user_id, firm_id, action, resource_type, resource_id)
     values ($1, $2, 'record_download', 'record', $3)`,
    [a.user_id, a.firm_id, a.resource_id]);
}

// ---- Invoices (staff-only writes; RLS also enforces) ----------------------
export async function createInvoice(c: pg.PoolClient, b: any) {
  const r = await c.query(
    `insert into invoices (case_id, firm_id, amount, memo, status, issue_date, due_date, sent_date)
     values ($1,$2,$3,$4,'sent',current_date,$5,current_date) returning id`,
    [b.case_id, b.firm_id, b.amount, b.memo ?? null, b.due_date]);
  return (await c.query("select * from invoices_view where id=$1", [r.rows[0].id])).rows[0];
}

export async function addInvoicePayment(c: pg.PoolClient, invoiceId: string, b: any) {
  const inv = await c.query("select firm_id from invoices where id=$1", [invoiceId]);
  if (!inv.rows.length) return null;
  await c.query(
    `insert into invoice_payments (invoice_id, firm_id, amount, paid_on, method, note)
     values ($1,$2,$3,coalesce($4::date,current_date),$5,$6)`,
    [invoiceId, inv.rows[0].firm_id, b.amount, b.paid_on ?? null, b.method ?? null, b.note ?? null]);
  return (await c.query("select * from invoices_view where id=$1", [invoiceId])).rows[0];
}

export async function voidInvoice(c: pg.PoolClient, id: string) {
  const r = await c.query("update invoices set status='void' where id=$1 returning id", [id]);
  if (!r.rows.length) return null;
  return (await c.query("select * from invoices_view where id=$1", [id])).rows[0];
}

// ---- Case update: status/review + editable case fields (firm-or-staff) ----
export async function updateCase(c: pg.PoolClient, id: string, b: any) {
  const r = await c.query(
    `update cases set
       status            = coalesce($2, status),
       review_status     = coalesce($3, review_status),
       review_reason     = coalesce($4, review_reason),
       claim_number      = coalesce($5, claim_number),
       liability_carrier = coalesce($6, liability_carrier),
       health_insurance  = coalesce($7, health_insurance),
       assigned_to       = coalesce($8, assigned_to),
       notes             = coalesce($9, notes)
     where id=$1 returning id, status, review_status, review_reason, claim_number,
       liability_carrier, health_insurance, assigned_to`,
    [id, b.status ?? null, b.review_status ?? null, b.review_reason ?? null,
     b.claim_number ?? null, b.liability_carrier ?? null, b.health_insurance ?? null,
     b.assigned_to ?? null, b.notes ?? null]);
  return r.rows[0] ?? null;
}

// ---- New case (staff): firm resolved/deduped by import key, client by name,
// case + PIP ledger + optional initial bill. Runs inside withTenant's txn.
export async function createCase(c: pg.PoolClient, b: any) {
  let firm = await c.query(
    "select id from firms where import_firm_key(name) = import_firm_key($1) limit 1", [b.firm_name]);
  if (!firm.rows.length) {
    firm = await c.query("insert into firms (name) values ($1) returning id", [b.firm_name.trim()]);
  }
  const firmId = firm.rows[0].id;

  let client = await c.query(
    "select id from clients where lower(last_name)=lower($1) and lower(coalesce(first_name,''))=lower($2) limit 1",
    [b.last_name.trim(), (b.first_name ?? "").trim()]);
  if (!client.rows.length) {
    client = await c.query(
      "insert into clients (first_name, last_name) values ($1,$2) returning id",
      [(b.first_name ?? "").trim(), b.last_name.trim()]);
  }
  const clientId = client.rows[0].id;

  const kase = await c.query(
    `insert into cases (firm_id, client_id, claim_number, date_of_injury, liability_carrier,
                        health_insurance, status, opened_at, followup_priority)
     values ($1,$2,$3,$4,$5,$6,'active', coalesce($7::date, $4::date, current_date), 'normal')
     returning id`,
    [firmId, clientId, b.claim_number ?? null, b.doi ?? null, b.liability_carrier ?? null,
     b.health_insurance ?? null, b.first_dos ?? null]);
  const caseId = kase.rows[0].id;

  await c.query(
    `insert into pip_ledger (case_id, firm_id, carrier, claim_number, status, total_available, total_paid)
     values ($1,$2,$3,$4,'open',10000,0) on conflict (case_id) do nothing`,
    [caseId, firmId, b.liability_carrier ?? null, b.claim_number ?? null]);

  const charges = Number(b.charges ?? 0);
  if (charges > 0) {
    await c.query(
      `insert into medical_bills (case_id, firm_id, provider_id, date_of_service, description,
                                  billed_amount, pip_paid, insurance_paid, bill_status)
       values ($1,$2, emr_miispine_provider(), coalesce($3::date, $4::date, current_date),
               'Charges', $5, 0, 0, 'outstanding')`,
      [caseId, firmId, b.first_dos ?? null, b.doi ?? null, charges]);
  }
  return { id: caseId, firm_id: firmId, client_id: clientId };
}

export async function updateBill(c: pg.PoolClient, id: string, b: any) {
  // Reconciliation edits. RLS ensures the caller owns the bill's firm (or is
  // staff); the lien trigger recomputes lien_amount and the AR trigger the case.
  const r = await c.query(
    `update medical_bills set
       billed_amount  = coalesce($2, billed_amount),
       pip_paid       = coalesce($3, pip_paid),
       insurance_paid = coalesce($4, insurance_paid),
       collected_amount = coalesce($5, collected_amount),
       lien_manual    = coalesce($6, lien_manual)
     where id = $1
     returning id, billed_amount, pip_paid, insurance_paid, lien_amount, collected_amount`,
    [id, b.billed_amount ?? null, b.pip_paid ?? null, b.insurance_paid ?? null, b.collected_amount ?? null, b.lien_manual ?? null],
  );
  return r.rows[0] ?? null;
}
