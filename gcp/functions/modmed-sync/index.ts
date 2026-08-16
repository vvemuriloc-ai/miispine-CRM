// modmed-sync job (Cloud Run) — READ-ONLY AR pull from ModMed's PM FHIR API.
// Ports the Supabase edge function to pg (owner, bypasses RLS). The FHIR mappers
// (fhir.js) are unchanged. reconcile_emr() (migration 0010) does the DB work.
import { q, insertRows } from "../lib/db.ts";
import { config } from "../lib/config.ts";
import { modmedToken, fhirGetAll, type FetchLike } from "../lib/fhir-client.ts";
import {
  mapChargeItem, invoicePrices, mapPaymentReconciliation, bundleResources, nextLink,
} from "./fhir.js";

export async function run(deps: { fetchImpl?: FetchLike } = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const resources = ["ChargeItem", "Invoice", "PaymentReconciliation"];
  const runRow = await q(
    "insert into emr_sync_run(kind,status,resources,dry_run) values('ar','running',$1,$2) returning id",
    [resources, config.modmed.dryRun]);
  const runId = runRow.rows[0].id;
  try {
    const token = await modmedToken(fetchImpl);
    const charges  = await fhirGetAll(token, "/ChargeItem?_count=100", bundleResources, nextLink, fetchImpl);
    const invoices = await fhirGetAll(token, "/Invoice?_count=100", bundleResources, nextLink, fetchImpl);
    const payments = await fhirGetAll(token, "/PaymentReconciliation?_count=100", bundleResources, nextLink, fetchImpl);

    const priceByCharge: Record<string, number> = {};
    for (const inv of invoices) Object.assign(priceByCharge, invoicePrices(inv));

    const chargeRows = charges.map((c) => mapChargeItem(c, priceByCharge))
      .filter((c) => c && c.emr_charge_id).map((c) => ({ ...c, sync_run_id: runId }));
    const paymentRows = payments.flatMap(mapPaymentReconciliation)
      .filter((p) => p && p.emr_payment_id && p.amount).map((p) => ({ ...p, sync_run_id: runId }));

    await insertRows("emr_charge_staging",
      ["sync_run_id", "emr_charge_id", "emr_patient_id", "cpt_code", "description", "billed_amount", "date_of_service", "status_raw"], chargeRows);
    await insertRows("emr_payment_staging",
      ["sync_run_id", "emr_payment_id", "emr_charge_id", "emr_patient_id", "amount", "payer_type", "payer_label", "paid_on"], paymentRows);

    let reconciled = { charges_upserted: 0, cases_touched: 0, unmatched: 0 };
    if (!config.modmed.dryRun) {
      reconciled = (await q("select * from reconcile_emr($1)", [runId])).rows[0];
    }
    await q(
      "update emr_sync_run set status=$2, charges_seen=$3, payments_seen=$4, charges_upserted=$5, cases_touched=$6, unmatched=$7, finished_at=now() where id=$1",
      [runId, config.modmed.dryRun ? "dry_run" : "ok", chargeRows.length, paymentRows.length,
        reconciled.charges_upserted, reconciled.cases_touched, reconciled.unmatched]);
    return { run_id: runId, dry_run: config.modmed.dryRun, seen: { charges: chargeRows.length, payments: paymentRows.length }, reconciled };
  } catch (e) {
    await q("update emr_sync_run set status='error', error=$2, finished_at=now() where id=$1",
      [runId, e instanceof Error ? e.message : String(e)]);
    throw e;
  }
}
