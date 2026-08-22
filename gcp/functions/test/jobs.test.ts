// Integration test for the three jobs against a local Postgres (owner conn),
// with ModMed HTTP, GCS upload, Claude, and SendGrid all mocked. Proves the
// ported job wiring drives the reconcile SQL + logging correctly.
// Runner sets DATABASE_URL (owner), MODMED_BASE_URL, MODMED_API_KEY/USER/PASS.
import pg from "pg";
import { run as modmedSync } from "../modmed-sync/index.ts";
import { run as modmedRecords } from "../modmed-records/index.ts";
import { run as modmedLink } from "../modmed-link/index.ts";
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

// ---- ModMed AR fixtures (ChargeItem + Account — the resources ModMed ships) ----
const chargeFetch = (url: string) => {
  if (url.includes("oauth2/grant")) return token();
  if (url.includes("/ChargeItem")) return bundle([
    { resourceType: "ChargeItem", id: "CI-1", status: "billable", code: { text: "ACDF", coding: [{ system: "http://www.ama-assn.org/go/cpt", code: "22551" }] }, subject: { reference: "Patient/PT-1001" }, occurrenceDateTime: "2026-03-01", priceOverride: { value: 40000, currency: "USD" } },
    { resourceType: "ChargeItem", id: "CI-2", status: "billable", code: { text: "ESI", coding: [{ code: "64483" }] }, subject: { reference: "Patient/PT-1001" }, occurrenceDateTime: "2026-04-01", priceOverride: { value: 10000, currency: "USD" } },
  ]);
  if (url.includes("/Account")) return bundle([
    { resourceType: "Account", id: "ACC-1", subject: [{ reference: "Patient/PT-1001" }],
      extension: [{ url: "https://api.modmed.com/fhir/extension/account-balance", valueMoney: { value: 31500, currency: "USD" } }] },
  ]);
  return new Response("{}", { status: 404 });
};

// ---- ModMed records fixtures ----
// Header capture per URL, so the test can assert the real bug ModMed's docs
// exposed: a pre-signed S3 attachment URL must NOT get our ModMed Bearer/
// x-api-key headers (S3 rejects the signature if we do); a relative,
// ModMed-hosted path must still get them.
const capturedHeaders: Record<string, string[]> = {};
const S3_URL = "https://mock-s3.example.com/bucket/EMA_visit_final.pdf?X-Amz-Signature=abc&X-Amz-Expires=300";

// ModMed confirmed (support thread): GET DocumentReference?patient=X (search)
// never includes content[] — only GET DocumentReference/{id} (individual
// read) does. These fixtures mirror that two-tier shape exactly.
const searchDocs = [
  { resourceType: "DocumentReference", id: "DOC-1", status: "current", type: { coding: [{ system: "http://loinc.org", code: "11504-8" }], text: "Operative Report" }, subject: { reference: "Patient/PT-1001" }, date: "2026-03-02" },
  { resourceType: "DocumentReference", id: "DOC-2", status: "current", type: { coding: [{ code: "18748-4" }] }, subject: { reference: "Patient/PT-1001" }, date: "2026-02-15" },
  // "Attachment"-category doc (tests the attachment_category_* counters).
  { resourceType: "DocumentReference", id: "DOC-3", status: "current", category: [{ text: "Attachment" }], subject: { reference: "Patient/PT-1001" }, date: "2026-04-01" },
  // Clinical-note shape actually seen on the live tenant: no file, ever.
  { resourceType: "DocumentReference", id: "DOC-4", status: "current", type: { text: "Progress Note" }, subject: { reference: "Patient/PT-1001" }, date: "2026-04-05" },
  // Resolves to a pre-signed S3 attachment URL on individual read.
  { resourceType: "DocumentReference", id: "DOC-5", status: "current", category: [{ text: "Attachment" }], subject: { reference: "Patient/PT-1001" }, date: "2026-04-10" },
  // ModMed document ids can contain a pipe — must be encodeURIComponent'd.
  { resourceType: "DocumentReference", id: "file|259103741", status: "current", category: [{ text: "Attachment" }], subject: { reference: "Patient/PT-1001" }, date: "2026-04-12" },
  // Generated office note: no contentType from ModMed, bytes are HTML —
  // the sync must sniff the real type instead of storing ".bin".
  { resourceType: "DocumentReference", id: "DOC-7", status: "current", type: { text: "Office Visit" }, subject: { reference: "Patient/PT-1001" }, date: "2026-04-15", description: "Office Visit Note" },
  // Multi-rendition note: EMA lists a PNG page-preview FIRST, the real PDF
  // second — the picker must take the PDF, not the preview.
  { resourceType: "DocumentReference", id: "DOC-8", status: "current", type: { text: "Procedure Note" }, subject: { reference: "Patient/PT-1001" }, date: "2026-04-18", description: "Procedure Note" },
];

// GET DocumentReference/{id} responses — the real attachment only appears here.
const fullDocs: Record<string, any> = {
  "DOC-1": { resourceType: "DocumentReference", id: "DOC-1", status: "current", subject: { reference: "Patient/PT-1001" }, date: "2026-03-02", content: [{ attachment: { contentType: "application/pdf", url: "Binary/bin-1", title: "op_note.pdf" } }] },
  "DOC-2": { resourceType: "DocumentReference", id: "DOC-2", status: "current", subject: { reference: "Patient/PT-1001" }, date: "2026-02-15", content: [{ attachment: { contentType: "image/jpeg", data: btoa("jpegbytes") } }] },
  "DOC-3": { resourceType: "DocumentReference", id: "DOC-3", status: "current", category: [{ text: "Attachment" }], subject: { reference: "Patient/PT-1001" }, date: "2026-04-01", content: [{ attachment: { contentType: "application/pdf", data: btoa("attach-bytes"), title: "outside_record.pdf" } }] },
  // DOC-4: even the individual read has no content[] — a genuine note with no file.
  "DOC-4": { resourceType: "DocumentReference", id: "DOC-4", status: "current", subject: { reference: "Patient/PT-1001" }, date: "2026-04-05" },
  "DOC-5": { resourceType: "DocumentReference", id: "DOC-5", status: "current", category: [{ text: "Attachment" }], subject: { reference: "Patient/PT-1001" }, date: "2026-04-10", content: [{ attachment: { contentType: "application/pdf", url: S3_URL, title: "EMA_visit_final.pdf" } }] },
  "file|259103741": { resourceType: "DocumentReference", id: "file|259103741", status: "current", category: [{ text: "Attachment" }], subject: { reference: "Patient/PT-1001" }, date: "2026-04-12", content: [{ attachment: { contentType: "application/pdf", url: "Binary/bin-pipe", title: "pipe_id.pdf" } }] },
  "DOC-7": { resourceType: "DocumentReference", id: "DOC-7", status: "current", type: { text: "Office Visit" }, subject: { reference: "Patient/PT-1001" }, date: "2026-04-15", description: "Office Visit Note", content: [{ attachment: { url: "Binary/bin-note" } }] },
  "DOC-8": { resourceType: "DocumentReference", id: "DOC-8", status: "current", type: { text: "Procedure Note" }, subject: { reference: "Patient/PT-1001" }, date: "2026-04-18", description: "Procedure Note", content: [
    { attachment: { contentType: "image/png", url: "Binary/bin-preview", title: "preview.png" } },
    { attachment: { contentType: "application/pdf", url: "Binary/bin-procnote", title: "procedure_note.pdf" } },
  ] },
};

const docFetch = (url: string, opts?: any) => {
  capturedHeaders[url] = Object.keys(opts?.headers ?? {});
  if (url.includes("oauth2/grant")) return token();
  if (url.includes("/DocumentReference?patient=")) return bundle(searchDocs);
  const m = url.match(/\/DocumentReference\/([^?]+)$/);
  if (m) {
    const full = fullDocs[decodeURIComponent(m[1])];
    return full ? new Response(JSON.stringify(full), { headers: { "content-type": "application/fhir+json" } }) : new Response("{}", { status: 404 });
  }
  if (url.includes("/Binary/bin-1")) return new Response(Buffer.from("%PDF-1.4 fake"));
  if (url.includes("/Binary/bin-pipe")) return new Response(Buffer.from("%PDF-1.4 pipe-fake"));
  if (url.includes("/Binary/bin-note")) return new Response(Buffer.from("<html><body>note narrative</body></html>"));
  if (url.includes("/Binary/bin-preview")) return new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  if (url.includes("/Binary/bin-procnote")) return new Response(Buffer.from("%PDF-1.4 procnote"));
  if (url === S3_URL) return new Response(Buffer.from("%PDF-1.4 s3-fake"));
  return new Response("{}", { status: 404 });
};

async function main() {
  await seed();

  // 1) modmed-sync — charges → bills (gross lien), Account → PM balance
  const sync = await modmedSync({ fetchImpl: chargeFetch as any });
  ok("sync upserted 2 charges", sync.reconciled.charges_upserted === 2, JSON.stringify(sync.reconciled));
  ok("account balance applied to case", sync.balances_applied === 1, JSON.stringify(sync));
  const oc = new pg.Client({ connectionString: OWNER }); await oc.connect();
  const b1 = await oc.query("select lien_amount, pip_paid, insurance_paid from medical_bills where emr_charge_id='CI-1'");
  ok("CI-1 lien = billed (no API payments)", Number(b1.rows[0].lien_amount) === 40000, JSON.stringify(b1.rows[0]));
  const ct = await oc.query("select total_lien, emr_pm_balance from cases where id='aaaa1111-1111-1111-1111-111111111111'");
  ok("case total_lien 50000, PM balance 31500", Number(ct.rows[0].total_lien) === 50000 && Number(ct.rows[0].emr_pm_balance) === 31500, JSON.stringify(ct.rows[0]));

  // staff reconcile a payment manually, then re-run: manual values must survive
  await oc.query("update medical_bills set pip_paid=10000 where emr_charge_id='CI-1'");
  await modmedSync({ fetchImpl: chargeFetch as any });
  const b1b = await oc.query("select pip_paid, lien_amount from medical_bills where emr_charge_id='CI-1'");
  ok("re-run preserves manual reconciliation", Number(b1b.rows[0].pip_paid) === 10000 && Number(b1b.rows[0].lien_amount) === 30000, JSON.stringify(b1b.rows[0]));
  const cnt = await oc.query("select count(*)::int n from medical_bills where emr_source='modmed'");
  ok("re-run no duplicate bills", cnt.rows[0].n === 2, JSON.stringify(cnt.rows[0]));

  // 2) modmed-records — DocumentReference search → individual-read enrichment → GCS upload → records
  const uploads: string[] = [];
  const uploadTypes: Record<string, string> = {};
  const capUpload = async (key: string, _b: Uint8Array, ct: string) => { uploads.push(key); uploadTypes[key] = ct; };
  const rec = await modmedRecords({ fetchImpl: docFetch as any, uploadImpl: capUpload });
  ok("records upserted 8", rec.reconciled.records_upserted === 8, JSON.stringify(rec.reconciled));
  ok("7 files uploaded (DOC-4 a bare note has none)", uploads.length === 7, JSON.stringify(uploads));
  ok("attachment summary distinguishes category from usable file, post-enrichment",
    rec.attachment_summary.total_docs === 8 &&
    rec.attachment_summary.with_usable_attachment === 7 &&
    rec.attachment_summary.attachment_category_docs === 3 &&
    rec.attachment_summary.attachment_category_with_usable_attachment === 3 &&
    rec.attachment_summary.enrich_attempted === 8 &&
    rec.attachment_summary.enrich_failed === 1,
    JSON.stringify(rec.attachment_summary));
  ok("rendition census counts multi-rendition docs",
    rec.attachment_summary.multi_rendition_docs === 1 &&
    rec.attachment_summary.rendition_types["image/png"] === 1 &&
    rec.attachment_summary.rendition_types["application/pdf"] >= 1,
    JSON.stringify(rec.attachment_summary.rendition_types));
  const recs = await oc.query("select record_type, status from records where emr_source='modmed'");
  ok("7 uploaded, 1 received (no file)", recs.rows.filter((r: any) => r.status === "uploaded").length === 7
    && recs.rows.filter((r: any) => r.status === "received").length === 1, JSON.stringify(recs.rows));

  // Multi-rendition doc: PNG preview listed first, real PDF second — the
  // picker must store the PDF rendition, not the preview image.
  const procKey = uploads.find((k) => k.includes("DOC-8"));
  ok("multi-rendition doc stores the PDF, not the PNG preview",
    !!procKey && procKey.endsWith(".pdf") && uploadTypes[procKey] === "application/pdf",
    JSON.stringify([procKey, procKey && uploadTypes[procKey]]));

  // Byte-sniffing: an untyped note whose bytes are HTML stores as .html with
  // the true content type — never ".bin opened as code".
  const noteKey = uploads.find((k) => k.includes("DOC-7"));
  ok("untyped HTML note sniffed → .html + text/html",
    !!noteKey && noteKey.endsWith(".html") && uploadTypes[noteKey] === "text/html",
    JSON.stringify([noteKey, noteKey && uploadTypes[noteKey]]));
  const noteRow = await oc.query("select filename from records where emr_document_id='DOC-7'");
  ok("sniffed extension lands in records.filename", /\.html$/.test(noteRow.rows[0]?.filename ?? ""), JSON.stringify(noteRow.rows));

  // The real bug ModMed's docs surfaced: a pre-signed S3 URL must NOT carry
  // our ModMed auth headers (breaks the S3 signature); a relative ModMed path
  // (resolved against MODMED_BASE_URL before fetching) must still carry them.
  const binaryKey = Object.keys(capturedHeaders).find((k) => k.endsWith("/Binary/bin-1"));
  ok("relative Binary path gets ModMed auth headers",
    !!binaryKey && capturedHeaders[binaryKey].includes("Authorization") && capturedHeaders[binaryKey].includes("x-api-key"),
    JSON.stringify(binaryKey && capturedHeaders[binaryKey]));
  ok("pre-signed S3 URL gets NO auth headers",
    Array.isArray(capturedHeaders[S3_URL]) && capturedHeaders[S3_URL].length === 0,
    JSON.stringify(capturedHeaders[S3_URL]));

  // The search→read fix itself: an individual GET DocumentReference/{id} must
  // carry ModMed auth headers (it's ModMed's own API, not a pre-signed URL),
  // and a pipe-containing document id must be encodeURIComponent'd in the URL.
  const readKey = Object.keys(capturedHeaders).find((k) => k.endsWith("/DocumentReference/DOC-1"));
  ok("individual DocumentReference read gets ModMed auth headers",
    !!readKey && capturedHeaders[readKey].includes("Authorization") && capturedHeaders[readKey].includes("x-api-key"),
    JSON.stringify(readKey && capturedHeaders[readKey]));
  const pipeReadKey = Object.keys(capturedHeaders).find((k) => k.endsWith("/DocumentReference/file%7C259103741"));
  ok("pipe-containing document id is encodeURIComponent'd on individual read", !!pipeReadKey, JSON.stringify(Object.keys(capturedHeaders)));
  const pipeBinaryKey = Object.keys(capturedHeaders).find((k) => k.endsWith("/Binary/bin-pipe"));
  ok("pipe-id document's attachment downloads via the enriched url",
    !!pipeBinaryKey && capturedHeaders[pipeBinaryKey].includes("Authorization"),
    JSON.stringify(pipeBinaryKey && capturedHeaders[pipeBinaryKey]));

  // Re-run: already-uploaded documents must NOT trigger a second individual
  // read (they already have a storage_key) — only the never-uploaded note
  // (DOC-4) should still be attempted, and nothing should be re-uploaded.
  const uploads2: string[] = [];
  const rec2 = await modmedRecords({ fetchImpl: docFetch as any, uploadImpl: async (key: string) => { uploads2.push(key); } });
  ok("re-run skips enrichment for already-uploaded docs",
    rec2.attachment_summary.enrich_attempted === 1 && rec2.attachment_summary.enrich_failed === 1,
    JSON.stringify(rec2.attachment_summary));
  ok("re-run uploads nothing new", uploads2.length === 0, JSON.stringify(uploads2));
  // The production regression this guards: a metadata-only re-run stages
  // placeholder filenames (search results carry no title) and must NOT
  // downgrade the accurate name written by the run that downloaded the file.
  const post = await oc.query("select emr_document_id, filename from records where emr_document_id in ('DOC-1','DOC-7')");
  const fn = Object.fromEntries(post.rows.map((r: any) => [r.emr_document_id, r.filename]));
  ok("re-run preserves downloaded filenames", fn["DOC-1"] === "op_note.pdf" && /\.html$/.test(fn["DOC-7"] ?? ""), JSON.stringify(fn));

  // 2b) modmed-link — name search links unique matches, reports the rest
  await oc.query("insert into clients(id,first_name,last_name) values ('cccc2222-2222-2222-2222-222222222222','Uma','Unique'),('cccc3333-3333-3333-3333-333333333333','Andy','Ambig'),('cccc4444-4444-4444-4444-444444444444','Nora','Nowhere')");
  await oc.query(`insert into cases(id,firm_id,client_id,claim_number) values
    ('aaaa2222-2222-2222-2222-222222222222','f1111111-1111-1111-1111-111111111111','cccc2222-2222-2222-2222-222222222222','L1'),
    ('aaaa3333-3333-3333-3333-333333333333','f1111111-1111-1111-1111-111111111111','cccc2222-2222-2222-2222-222222222222','L2'),
    ('aaaa4444-4444-4444-4444-444444444444','f1111111-1111-1111-1111-111111111111','cccc3333-3333-3333-3333-333333333333','L3'),
    ('aaaa5555-5555-5555-5555-555555555555','f1111111-1111-1111-1111-111111111111','cccc4444-4444-4444-4444-444444444444','L4')`);
  const linkFetch = (url: string) => {
    if (url.includes("oauth2/grant")) return token();
    if (url.includes("/Patient")) {
      if (url.includes("family=Unique")) return bundle([{ resourceType: "Patient", id: "PT-U1" }]);
      if (url.includes("family=Ambig")) return bundle([{ resourceType: "Patient", id: "PT-A1" }, { resourceType: "Patient", id: "PT-A2" }]);
      return bundle([]);
    }
    return new Response("{}", { status: 404 });
  };
  const link = await modmedLink({ fetchImpl: linkFetch as any });
  ok("link: unique client linked (both cases)", link.linked === 1 && link.cases_linked === 2, JSON.stringify(link));
  ok("link: ambiguous + not_found reported", link.ambiguous.length === 1 && link.not_found.length === 1);
  const linked = await oc.query("select count(*)::int n from cases where emr_patient_id='PT-U1'");
  ok("link: emr_patient_id written to both cases", linked.rows[0].n === 2);
  const notLinked = await oc.query("select count(*)::int n from cases where id in ('aaaa4444-4444-4444-4444-444444444444','aaaa5555-5555-5555-5555-555555555555') and emr_patient_id is not null");
  ok("link: ambiguous/none left unlinked", notLinked.rows[0].n === 0);

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
