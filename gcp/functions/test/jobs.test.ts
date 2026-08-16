// Integration test for the three jobs against a local Postgres (owner conn),
// with ModMed HTTP, GCS upload, Claude, and SendGrid all mocked. Proves the
// ported job wiring drives the reconcile SQL + logging correctly.
// Runner sets DATABASE_URL (owner), MODMED_BASE_URL, MODMED_API_KEY/USER/PASS.
import pg from "pg";
import { run as modmedSync } from "../modmed-sync/index.ts";
import { run as modmedRecords } from "../modmed-records/index.ts";
import { run as autopilot } from "../autopilot/index.ts";
import { pool } from "../lib/db.ts";

const OWNER = process.env.DATABASE_URL!;
let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra = "") => { if (c) pass++; else { fail++; console.error(`FAIL ${n} ${extra}`); } };

const bundle = (resources: any[]) => new Response(JSON.stringify({ resourceType: "Bundle", entry: resources.map((r) => ({ resource: r })), link: [] }), { headers: { "content-type": "application/fhir+json" } });
const token = () => new Response(JSON.stringify({ access_token: "tok" }), { headers: { "content-type": "application/json" } });

async function seed() {
  const c = new pg.Client({ connectionString: OWNER }); await c.connect();
  await c.query("truncate cases, clients, firms, attorneys, medical_bills, records, pip_ledger, outreach_log, emr_sync_run, emr_charge_staging, emr_payment_staging, emr_record_staging restart identity cascade");
  await c.query("insert into firms(id,name) values ('f1111111-1111-1111-1111-111111111111','Firm One')");
  await c.query("insert into attorneys(id,firm_id,name,email) values ('a1111111-1111-1111-1111-111111111111','f1111111-1111-1111-1111-111111111111','Dana Hale','dana@f1.com')");
  await c.query("insert into clients(id,first_name,last_name,emr_patient_id) values ('cccc1111-1111-1111-1111-111111111111','Alice','A','PT-1001')");
  await c.query("insert into cases(id,firm_id,attorney_id,client_id,claim_number,emr_patient_id,status,followup_priority) values ('aaaa1111-1111-1111-1111-111111111111','f1111111-1111-1111-1111-111111111111','a1111111-1111-1111-1111-111111111111','cccc1111-1111-1111-1111-111111111111','F1-CLAIM','PT-1001','active','normal')");
  await c.end();
}

// ---- ModMed AR fixtures ----
const chargeFetch = (url: string) => {
  if (url.includes("oauth2/grant")) return token();
  if (url.includes("/ChargeItem")) return bundle([
    { resourceType: "ChargeItem", id: "CI-1", status: "billable", code: { text: "ACDF", coding: [{ system: "http://www.ama-assn.org/go/cpt", code: "22551" }] }, subject: { reference: "Patient/PT-1001" }, occurrenceDateTime: "2026-03-01", priceOverride: { value: 40000, currency: "USD" } },
    { resourceType: "ChargeItem", id: "CI-2", status: "billable", code: { text: "ESI", coding: [{ code: "64483" }] }, subject: { reference: "Patient/PT-1001" }, occurrenceDateTime: "2026-04-01", priceOverride: { value: 10000, currency: "USD" } },
  ]);
  if (url.includes("/Invoice")) return bundle([]);
  if (url.includes("/PaymentReconciliation")) return bundle([
    { resourceType: "PaymentReconciliation", id: "PR-1", requestor: { reference: "Patient/PT-1001" }, paymentDate: "2026-05-01", detail: [{ type: { text: "PIP payment" }, amount: { value: 10000, currency: "USD" }, date: "2026-05-01" }] },
    { resourceType: "PaymentReconciliation", id: "PR-2", requestor: { reference: "Patient/PT-1001" }, paymentDate: "2026-06-01", detail: [{ type: { text: "BCBS insurance" }, amount: { value: 8000, currency: "USD" }, date: "2026-06-01" }] },
  ]);
  return new Response("{}", { status: 404 });
};

// ---- ModMed records fixtures ----
const docFetch = (url: string) => {
  if (url.includes("oauth2/grant")) return token();
  if (url.includes("/DocumentReference")) return bundle([
    { resourceType: "DocumentReference", id: "DOC-1", status: "current", type: { coding: [{ system: "http://loinc.org", code: "11504-8" }], text: "Operative Report" }, subject: { reference: "Patient/PT-1001" }, date: "2026-03-02", content: [{ attachment: { contentType: "application/pdf", url: "Binary/bin-1", title: "op_note.pdf" } }] },
    { resourceType: "DocumentReference", id: "DOC-2", status: "current", type: { coding: [{ code: "18748-4" }] }, subject: { reference: "Patient/PT-1001" }, date: "2026-02-15", content: [{ attachment: { contentType: "image/jpeg", data: btoa("jpegbytes") } }] },
  ]);
  if (url.includes("/Binary/bin-1")) return new Response(Buffer.from("%PDF-1.4 fake"));
  return new Response("{}", { status: 404 });
};

async function main() {
  await seed();

  // 1) modmed-sync — charges + payments → bills, waterfall lien
  const sync = await modmedSync({ fetchImpl: chargeFetch as any });
  ok("sync upserted 2 charges", sync.reconciled.charges_upserted === 2, JSON.stringify(sync.reconciled));
  const oc = new pg.Client({ connectionString: OWNER }); await oc.connect();
  const b1 = await oc.query("select lien_amount, pip_paid, insurance_paid from medical_bills where emr_charge_id='CI-1'");
  ok("CI-1 lien 22000 (40000-10000-8000)", Number(b1.rows[0].lien_amount) === 22000, JSON.stringify(b1.rows[0]));
  const ct = await oc.query("select total_lien from cases where id='aaaa1111-1111-1111-1111-111111111111'");
  ok("case total_lien 32000", Number(ct.rows[0].total_lien) === 32000, JSON.stringify(ct.rows[0]));

  // idempotent re-run: no dup bills
  await modmedSync({ fetchImpl: chargeFetch as any });
  const cnt = await oc.query("select count(*)::int n from medical_bills where emr_source='modmed'");
  ok("re-run no duplicate bills", cnt.rows[0].n === 2, JSON.stringify(cnt.rows[0]));

  // 2) modmed-records — DocumentReference → GCS upload → records
  const uploads: string[] = [];
  const rec = await modmedRecords({ fetchImpl: docFetch as any, uploadImpl: async (key) => { uploads.push(key); } });
  ok("records upserted 2", rec.reconciled.records_upserted === 2, JSON.stringify(rec.reconciled));
  ok("2 files uploaded to bucket", uploads.length === 2, JSON.stringify(uploads));
  const recs = await oc.query("select record_type, status from records where emr_source='modmed' order by record_type");
  ok("both records uploaded status", recs.rows.length === 2 && recs.rows.every((r: any) => r.status === "uploaded"), JSON.stringify(recs.rows));

  // 3) autopilot — drafts + logs + schedules (mock Claude + send)
  const ap = await autopilot({ draftImpl: async () => ({ subject: "Status update on your client", body: "Following up." }), sendImpl: async () => true });
  ok("autopilot processed the queued case", ap.processed === 1 && ap.drafted === 1, JSON.stringify(ap));
  const log = await oc.query("select subject, ai_generated, sent_by from outreach_log where case_id='aaaa1111-1111-1111-1111-111111111111'");
  ok("outreach logged", log.rows.length === 1 && log.rows[0].ai_generated === true && log.rows[0].sent_by === "autopilot");
  const sched = await oc.query("select next_followup_at from cases where id='aaaa1111-1111-1111-1111-111111111111'");
  ok("next follow-up scheduled", sched.rows[0].next_followup_at !== null);
  await oc.end();

  await pool.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
