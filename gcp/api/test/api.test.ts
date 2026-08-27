// Integration test: drives the real server against a local Postgres, proving
// the Firebase→tenant→RLS path end to end. Requires (set by the runner):
//   DATABASE_URL   — connect as miicase_app (RLS applies)
//   OWNER_URL      — connect as the owner/superuser (for seeding)
//   AUTH_MODE=mock — tokens are "mock:<uid>"
import pg from "pg";
import { buildServer } from "../src/server.ts";

const OWNER = process.env.OWNER_URL ?? "postgresql://postgres@localhost:5433/postgres";
let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra = "") => {
  if (cond) pass++; else { fail++; console.error(`FAIL ${name} ${extra}`); }
};

const F1 = "f1111111-1111-1111-1111-111111111111";
const F2 = "f2222222-2222-2222-2222-222222222222";
const C1 = "aaaa1111-1111-1111-1111-111111111111";
const C2 = "aaaa2222-2222-2222-2222-222222222222";

async function seed() {
  const c = new pg.Client({ connectionString: OWNER });
  await c.connect();
  await c.query("truncate cases, clients, firms, medical_bills, records, user_profiles restart identity cascade");
  await c.query("truncate user_invites").catch(() => {});
  await c.query("insert into firms(id,name) values ($1,'Firm One'),($2,'Firm Two')", [F1, F2]);
  await c.query("insert into clients(id,first_name,last_name,hipaa_release_on_file) values ('cccc1111-1111-1111-1111-111111111111','Alice','A',true),('cccc2222-2222-2222-2222-222222222222','Bob','B',false)");
  await c.query("insert into cases(id,firm_id,client_id,claim_number) values ($1,$2,'cccc1111-1111-1111-1111-111111111111','F1-CLAIM'),($3,$4,'cccc2222-2222-2222-2222-222222222222','F2-CLAIM')", [C1, F1, C2, F2]);
  await c.query("insert into medical_bills(id,case_id,firm_id,provider_id,date_of_service,billed_amount) values ('bbbb1111-1111-1111-1111-111111111111',$1,$2,(select id from providers limit 1),'2026-03-01',40000)", [C1, F1]).catch(async () => {
    // no providers yet — create one
    await c.query("insert into providers(name,type,is_miispine) values ('miiSpine','spine_surgery',true) on conflict do nothing");
    await c.query("insert into medical_bills(id,case_id,firm_id,provider_id,date_of_service,billed_amount) values ('bbbb1111-1111-1111-1111-111111111111',$1,$2,(select id from providers limit 1),'2026-03-01',40000)", [C1, F1]);
  });
  await c.query("select assign_user_to_firm('uid-att1','att1@f1.com',$1,'staff')", [F1]);
  await c.query("select assign_user_to_firm('uid-att2','att2@f2.com',$1,'staff')", [F2]);
  await c.query("select assign_staff('uid-staff','ar@miispine.com')");
  await c.end();
}

function api(base: string, token: string | null) {
  return (method: string, path: string, body?: any) =>
    fetch(base + path, {
      method,
      headers: { ...(token ? { authorization: "Bearer mock:" + token } : {}), "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
}

async function main() {
  await seed();
  const server = buildServer();
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  const base = `http://localhost:${port}`;

  const anon = api(base, null);
  const att1 = api(base, "uid-att1");
  const att2 = api(base, "uid-att2");
  const staff = api(base, "uid-staff");

  // health, unauthenticated, no-profile
  ok("health", (await (await anon("GET", "/api/health")).json()).ok === true);
  ok("no token → 401", (await anon("GET", "/api/cases")).status === 401);
  ok("unknown uid → 403", (await api(base, "ghost")("GET", "/api/cases")).status === 403);

  // isolation on /api/cases
  const c1 = await (await att1("GET", "/api/cases")).json();
  ok("att1 sees only F1", c1.length === 1 && c1[0].claim_number === "F1-CLAIM", JSON.stringify(c1.map((x: any) => x.claim_number)));
  const c2 = await (await att2("GET", "/api/cases")).json();
  ok("att2 sees only F2", c2.length === 1 && c2[0].claim_number === "F2-CLAIM");
  const cs = await (await staff("GET", "/api/cases")).json();
  ok("staff sees both", cs.length === 2);

  // cross-firm detail is hidden by RLS (404, not 403 — the row is invisible)
  ok("att1 cannot read F2 case", (await att1("GET", `/api/cases/${C2}`)).status === 404);
  ok("att1 can read F1 case", (await att1("GET", `/api/cases/${C1}`)).status === 200);
  const detail = await (await att1("GET", `/api/cases/${C1}`)).json();
  ok("detail embeds bills", Array.isArray(detail.bills) && detail.bills.length === 1);

  // /api/me
  ok("me att1 firm", (await (await att1("GET", "/api/me")).json()).firmId === F1);
  ok("me staff flag", (await (await staff("GET", "/api/me")).json()).isStaff === true);

  // /api/dashboard bundle — nested case shape, firm-scoped
  const dash = await (await att1("GET", "/api/dashboard")).json();
  ok("dashboard bundle scoped + nested", dash.me.firmId === F1 && dash.cases.length === 1 && dash.cases[0].firm.name === "Firm One" && Array.isArray(dash.ar_aging) && Array.isArray(dash.invoices), JSON.stringify({ n: dash.cases?.length }));

  // views scoped
  ok("ar-aging ok", Array.isArray(await (await att1("GET", "/api/ar-aging")).json()));
  ok("autopilot-queue ok", Array.isArray(await (await staff("GET", "/api/autopilot-queue")).json()));
  ok("invoices ok", Array.isArray(await (await att1("GET", "/api/invoices")).json()));
  ok("review-queue ok", Array.isArray(await (await staff("GET", "/api/review-queue")).json()));

  // write: attorney record request — guard strips storage_key, forces requested
  const reqRes = await att1("POST", "/api/records", { case_id: C1, firm_id: F1, record_type: "op_report", status: "uploaded", storage_key: "secret/other.pdf" });
  const reqRow = await reqRes.json();
  ok("attorney record forced to requested", reqRes.status === 200 && reqRow.status === "requested", JSON.stringify(reqRow));

  // verify (as owner) the storage_key was actually nulled
  const oc = new pg.Client({ connectionString: OWNER }); await oc.connect();
  const chk = await oc.query("select storage_key, requested_by from records where id = $1", [reqRow.id]);
  ok("attorney storage_key nulled in DB", chk.rows[0].storage_key === null && chk.rows[0].requested_by === "uid-att1");
  await oc.end();

  // staff record with a file keeps it
  const staffRes = await staff("POST", "/api/records", { case_id: C1, firm_id: F1, record_type: "op_report", status: "uploaded", storage_key: "emr/real.pdf" });
  const staffRow = await staffRes.json();
  ok("staff record keeps uploaded", staffRow.status === "uploaded");

  // write: reconcile a bill (att1 owns it) — lien recomputes via trigger
  const patched = await (await att1("PATCH", `/api/bills/bbbb1111-1111-1111-1111-111111111111`, { pip_paid: 10000, insurance_paid: 8000 })).json();
  ok("bill lien recomputed", Number(patched.lien_amount) === 22000, JSON.stringify(patched));
  // att2 cannot patch att1's bill
  ok("att2 cannot patch F1 bill", (await att2("PATCH", `/api/bills/bbbb1111-1111-1111-1111-111111111111`, { pip_paid: 0 })).status === 404);

  // --- records download: HIPAA-gated GCS signed URL + audit ---
  // staffRow is a C1 record with a file; Alice (C1 client) has release on file.
  const dl = await att1("POST", `/api/records/${staffRow.id}/download`);
  const dlBody = await dl.json();
  ok("att1 downloads F1 record (release on file)", dl.status === 200 && typeof dlBody.url === "string" && dlBody.expires_in === 60, JSON.stringify(dlBody));

  const ac = new pg.Client({ connectionString: OWNER }); await ac.connect();
  const audit = await ac.query("select count(*)::int n from audit_log where resource_id = $1 and action = 'record_download'", [staffRow.id]);
  ok("download wrote an audit row", audit.rows[0].n === 1);
  await ac.end();

  // staff uploads a record on C2 (Bob has NO release) → att2 download refused
  const c2rec = await (await staff("POST", "/api/records", { case_id: C2, firm_id: F2, record_type: "op_report", status: "uploaded", storage_key: "emr/c2.pdf" })).json();
  ok("att2 blocked: no HIPAA release", (await att2("POST", `/api/records/${c2rec.id}/download`)).status === 403);
  // cross-firm download is invisible (404), not merely forbidden
  ok("att1 cannot download F2 record", (await att1("POST", `/api/records/${c2rec.id}/download`)).status === 404);

  // staff flip Bob's HIPAA release on → att2 passes the gate (403 becomes a
  // signing attempt; local runs lack GCS creds, so accept 200 or 500 — the
  // 403 specifically must be gone). Attorneys cannot flip the flag.
  ok("attorney cannot set HIPAA flag", (await att2("PATCH", `/api/cases/${C2}/hipaa`, { on_file: true })).status === 403);
  const hip = await (await staff("PATCH", `/api/cases/${C2}/hipaa`, { on_file: true })).json();
  ok("staff marks release on file", hip.hipaa_release_on_file === true, JSON.stringify(hip));
  const dl2 = await att2("POST", `/api/records/${c2rec.id}/download`);
  ok("release on file unlocks the HIPAA gate", dl2.status !== 403, `status=${dl2.status}`);
  await staff("PATCH", `/api/cases/${C2}/hipaa`, { on_file: false });
  ok("revoke re-locks downloads", (await att2("POST", `/api/records/${c2rec.id}/download`)).status === 403);

  // --- firms see only pertinent record types (RLS-enforced) ---
  const mkRec = async (type: string, desc: string | null = null) =>
    (await (await staff("POST", "/api/records", { case_id: C1, firm_id: F1, record_type: type, status: "uploaded", storage_key: `emr/${type}.pdf`, description: desc })).json());
  const rOp = await mkRec("op_report");
  const rProg = await mkRec("progress_notes");
  const rMmi = await mkRec("mmi_letter");
  const rInv = await mkRec("other", "Invoice for services");
  const oc2 = new pg.Client({ connectionString: OWNER }); await oc2.connect();
  await oc2.query("update clients set hipaa_release_on_file=true where id='cccc1111-1111-1111-1111-111111111111'");
  await oc2.end();
  const att1Dash = await (await att1("GET", "/api/dashboard")).json();
  const att1Recs = (att1Dash.cases.find((x: any) => x.id === C1)?.records) ?? [];
  const att1Types = att1Recs.map((r: any) => r.record_type).sort();
  ok("firm sees pertinent types + invoice docs only",
    att1Types.includes("op_report") && !att1Types.includes("progress_notes") && !att1Types.includes("mmi_letter")
    && att1Recs.some((r: any) => (r.description ?? "").includes("Invoice")),
    JSON.stringify(att1Types));
  ok("firm cannot download an out-of-scope record (invisible, 404)",
    (await att1("POST", `/api/records/${rProg.id}/download`)).status === 404);
  ok("firm can download a pertinent record", (await att1("POST", `/api/records/${rOp.id}/download`)).status !== 404);
  const staffCase = await (await staff("GET", `/api/cases/${C1}`)).json();
  ok("staff still see every type", (staffCase.records ?? []).map((r: any) => r.record_type).includes("mmi_letter"),
    JSON.stringify((staffCase.records ?? []).length));

  // --- invites: email onboarding (claim on first verified sign-in) ---
  ok("attorney cannot create invites", (await att1("POST", "/api/invites", { email: "x@y.com", is_staff: true })).status === 403);
  const invStaff = await staff("POST", "/api/invites", { email: "Billing@MiiSpine.com", is_staff: true });
  ok("staff invite created (email lowercased)", invStaff.status === 200 && (await invStaff.json()).email === "billing@miispine.com");
  const invAtt = await staff("POST", "/api/invites", { email: "newlawyer@f1.com", firm_id: F1 });
  ok("attorney invite created", invAtt.status === 200);
  ok("duplicate pending invite → 409", (await staff("POST", "/api/invites", { email: "billing@miispine.com", is_staff: true })).status === 409);

  // unverified email does NOT claim; verified email does, with the right role
  const unver = api(base, "uid-new1:billing@miispine.com:unverified");
  ok("unverified email cannot claim", (await unver("GET", "/api/cases")).status === 403);
  const newStaff = api(base, "uid-new1:billing@miispine.com");
  const claimed = await newStaff("GET", "/api/dashboard");
  ok("verified email claims staff invite", claimed.status === 200 && (await claimed.json()).me.isStaff === true);
  const newLawyer = api(base, "uid-new2:newlawyer@f1.com");
  const lw = await newLawyer("GET", "/api/cases");
  const lwCases = await lw.json();
  ok("claimed attorney sees only their firm", lw.status === 200 && lwCases.length === 1 && lwCases[0].claim_number === "F1-CLAIM", JSON.stringify(lwCases.length));
  ok("unknown verified email still 403", (await api(base, "uid-new3:stranger@nowhere.com")("GET", "/api/cases")).status === 403);

  // list shows claimed status; revoke only works on pending
  const invList = await (await staff("GET", "/api/invites")).json();
  ok("invite list shows claimed + pending", invList.filter((i: any) => i.claimed_at).length === 2, JSON.stringify(invList.length));
  const pend = await (await staff("POST", "/api/invites", { email: "pending@f1.com", firm_id: F1 })).json();
  ok("revoke pending invite", (await staff("DELETE", `/api/invites/${pend.id}`)).status === 200);
  const claimedInv = invList.find((i: any) => i.claimed_at);
  ok("revoke claimed invite → 404", (await staff("DELETE", `/api/invites/${claimedInv.id}`)).status === 404);

  // --- invoices: staff issue / pay / void; firms read their own ---
  ok("attorney cannot issue an invoice", (await att1("POST", "/api/invoices", { case_id: C1, firm_id: F1, amount: 22000 })).status === 403);
  const invRes = await staff("POST", "/api/invoices", { case_id: C1, firm_id: F1, amount: 22000, due_days: 30 });
  const inv = await invRes.json();
  ok("staff issues invoice (MII- number, sent)", invRes.status === 200 && /^MII-\d{4}-\d{4}$/.test(inv.invoice_no) && inv.status === "sent", JSON.stringify(inv));

  const paid = await (await staff("POST", `/api/invoices/${inv.id}/payments`, { amount: 22000, method: "check" })).json();
  ok("full payment → status paid", paid.status === "paid" && Number(paid.balance_due) === 0, JSON.stringify(paid));

  // firm sees its own invoice; other firm does not
  const f1inv = await (await att1("GET", "/api/invoices")).json();
  ok("att1 sees the F1 invoice", f1inv.length === 1 && f1inv[0].id === inv.id);
  const f2inv = await (await att2("GET", "/api/invoices")).json();
  ok("att2 sees no invoices", f2inv.length === 0);

  const inv2 = await (await staff("POST", "/api/invoices", { case_id: C1, firm_id: F1, amount: 5000 })).json();
  const voided = await (await staff("PATCH", `/api/invoices/${inv2.id}`, { status: "void" })).json();
  ok("staff voids an invoice", voided.status === "void");

  // --- case review resolution ---
  const rev = await (await att1("PATCH", `/api/cases/${C1}`, { review_status: "resolved" })).json();
  ok("att1 resolves own case review", rev.review_status === "resolved", JSON.stringify(rev));
  ok("att2 cannot review F1 case", (await att2("PATCH", `/api/cases/${C1}`, { review_status: "resolved" })).status === 404);

  // --- case management: create (staff), edit fields, settle ---
  ok("attorney cannot create a case", (await att1("POST", "/api/cases", { last_name: "New", firm_name: "Firm One" })).status === 403);
  const created = await (await staff("POST", "/api/cases", {
    first_name: "Nina", last_name: "Newcase", claim_number: "NC-1",
    firm_name: "firm one, PLLC",   // dedupes onto existing "Firm One"
    liability_carrier: "State Farm", charges: 12000, doi: "2026-05-01", first_dos: "2026-05-10",
  })).json();
  ok("staff creates case in deduped firm", created.firm_id === F1, JSON.stringify(created));
  const ncase = await (await staff("GET", `/api/cases/${created.id}`)).json();
  ok("new case has initial bill + lien", Number(ncase.total_billed) === 12000 && Number(ncase.balance_outstanding) === 12000, JSON.stringify({ b: ncase.total_billed }));
  ok("new case DOS from first_dos", ncase.bills[0].date_of_service.startsWith("2026-05-10"));

  const edited = await (await staff("PATCH", `/api/cases/${created.id}`, { claim_number: "NC-2", liability_carrier: "Progressive", assigned_to: "VV" })).json();
  ok("case fields editable", edited.claim_number === "NC-2" && edited.liability_carrier === "Progressive" && edited.assigned_to === "VV", JSON.stringify(edited));

  // manual ModMed link (the ambiguous/not_found remediation path)
  const emrLinked = await (await staff("PATCH", `/api/cases/${created.id}`, { emr_patient_id: "14986741" })).json();
  ok("case manually linked to ModMed patient", emrLinked.emr_patient_id === "14986741", JSON.stringify(emrLinked));

  const settled = await (await staff("PATCH", `/api/cases/${created.id}`, { status: "settled" })).json();
  ok("mark settled", settled.status === "settled");

  server.close();
  const { pool } = await import("../src/db.ts");
  await pool.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
