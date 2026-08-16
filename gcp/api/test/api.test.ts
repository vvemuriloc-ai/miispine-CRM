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

  server.close();
  const { pool } = await import("../src/db.ts");
  await pool.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
