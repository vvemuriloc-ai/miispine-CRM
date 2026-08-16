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
