// modmed-sync job (Cloud Run) — READ-ONLY AR pull from ModMed's PM FHIR API.
// Ports the Supabase edge function to pg (owner, bypasses RLS). The FHIR mappers
// (fhir.js) are unchanged. reconcile_emr() (migration 0010) does the DB work.
import { q, insertRows } from "../lib/db.ts";
import { config } from "../lib/config.ts";
import { modmedToken, fhirGetAll, type FetchLike } from "../lib/fhir-client.ts";
import {
  mapChargeItem, bundleResources, nextLink,
} from "./fhir.js";

// ModMed's PM API exposes ChargeItem and Account only (confirmed by ModMed —
// no Invoice/Claim/PaymentReconciliation/EOB). Payments are reconciled
// manually in the app; the Account balance lands on the case as a drift
// detector next to our own outstanding figure.

// Account is FHIR R4 (no standard balance field) — ModMed carries the figure
// in an extension or similar. Scan tolerantly; log the shape once so the
// first real run tells us where the number lives if this misses.
export function accountBalance(res: any): { patient: string | null; balance: number | null } {
  const subj = Array.isArray(res?.subject) ? res.subject[0] : res?.subject;
  const patient = subj ? String((subj.reference ?? subj)).split("/").pop() ?? null : null;
  let balance: number | null = null;
  const tryMoney = (v: any) => {
    const n = Number(v?.value ?? v);
    if (Number.isFinite(n)) balance = n;
  };
  for (const ext of res?.extension ?? []) {
    if (/balance|amount[-_]?due|outstanding/i.test(ext?.url ?? "")) tryMoney(ext.valueMoney ?? ext.valueDecimal ?? ext.valueString);
  }
  if (balance === null && res?.balance != null) tryMoney(Array.isArray(res.balance) ? res.balance[0]?.amount : res.balance);
  return { patient, balance };
}

export async function run(deps: { fetchImpl?: FetchLike } = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const resources = ["ChargeItem", "Account"];
  const runRow = await q(
    "insert into emr_sync_run(kind,status,resources,dry_run) values('ar','running',$1,$2) returning id",
    [resources, config.modmed.dryRun]);
  const runId = runRow.rows[0].id;
  try {
    const token = await modmedToken(fetchImpl);
    const charges = await fhirGetAll(token, "/ChargeItem?_count=100", bundleResources, nextLink, fetchImpl);
    let accounts: any[] = [];
    try {
      accounts = await fhirGetAll(token, "/Account?_count=100", bundleResources, nextLink, fetchImpl);
    } catch (e) {
      console.error("Account fetch failed (continuing with charges only):", e instanceof Error ? e.message : e);
    }

    const chargeRows = charges.map((c) => mapChargeItem(c, {}))
      .filter((c) => c && c.emr_charge_id).map((c) => ({ ...c, sync_run_id: runId }));

    await insertRows("emr_charge_staging",
      ["sync_run_id", "emr_charge_id", "emr_patient_id", "cpt_code", "description", "billed_amount", "date_of_service", "status_raw"], chargeRows);

    let reconciled = { charges_upserted: 0, cases_touched: 0, unmatched: 0 };
    if (!config.modmed.dryRun) {
      reconciled = (await q("select * from reconcile_emr($1)", [runId])).rows[0];
    }

    // PM balances → linked cases (skipped in dry-run).
    let balancesApplied = 0;
    if (accounts.length) {
      const first = accounts[0];
      console.log("Account resource shape:", JSON.stringify({
        keys: Object.keys(first ?? {}),
        extension_urls: (first?.extension ?? []).map((x: any) => x?.url),
      }));
      if (!config.modmed.dryRun) {
        for (const a of accounts) {
          const { patient, balance } = accountBalance(a);
          if (!patient || balance === null) continue;
          const r = await q(
            "update cases set emr_pm_balance=$2, emr_pm_balance_at=now() where emr_patient_id=$1",
            [patient, balance]);
          balancesApplied += r.rowCount ?? 0;
        }
      }
    }

    await q(
      "update emr_sync_run set status=$2, charges_seen=$3, accounts_seen=$4, balances_applied=$5, charges_upserted=$6, cases_touched=$7, unmatched=$8, finished_at=now() where id=$1",
      [runId, config.modmed.dryRun ? "dry_run" : "ok", chargeRows.length, accounts.length, balancesApplied,
        reconciled.charges_upserted, reconciled.cases_touched, reconciled.unmatched]);
    return {
      run_id: runId, dry_run: config.modmed.dryRun,
      seen: { charges: chargeRows.length, accounts: accounts.length },
      balances_applied: balancesApplied, reconciled,
    };
  } catch (e) {
    await q("update emr_sync_run set status='error', error=$2, finished_at=now() where id=$1",
      [runId, e instanceof Error ? e.message : String(e)]);
    throw e;
  }
}
