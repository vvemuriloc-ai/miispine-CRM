// Node test for the pure FHIR mappers. Run: node fhir.test.mjs
import {
  refId, money, cpt, display, isoDate, classifyPayer,
  mapChargeItem, invoicePrices, mapPaymentReconciliation,
  nextLink, bundleResources,
} from "./fhir.js";

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; }
  else { fail++; console.error(`FAIL ${name}\n  got:  ${g}\n  want: ${w}`); };
};

// --- primitives ---
eq("refId string", refId("Patient/PT-1001"), "PT-1001");
eq("refId object", refId({ reference: "ChargeItem/CI-1" }), "CI-1");
eq("refId null", refId(null), null);
eq("money object", money({ value: 39700, currency: "USD" }), 39700);
eq("money bare", money(100), 100);
eq("money missing", money(undefined), 0);
eq("cpt prefers cpt system",
  cpt({ coding: [{ system: "x", code: "ZZ" }, { system: "http://www.ama-assn.org/go/cpt", code: "22551" }] }),
  "22551");
eq("display text wins", display({ text: "ACDF", coding: [{ display: "other" }] }), "ACDF");
eq("isoDate trims time", isoDate("2026-03-04T10:00:00Z"), "2026-03-04");

// --- payer classification ---
eq("payer PIP", classifyPayer("KY PIP"), "pip");
eq("payer no-fault", classifyPayer("No-Fault Med Pay"), "pip");
eq("payer insurance", classifyPayer("BCBS of Kentucky"), "insurance");
eq("payer unknown", classifyPayer("Patient Cash"), "other");

// --- ChargeItem mapping (price on the ChargeItem) ---
const ci1 = {
  resourceType: "ChargeItem", id: "CI-1", status: "billable",
  code: { text: "ACDF surgery", coding: [{ system: "http://www.ama-assn.org/go/cpt", code: "22551" }] },
  subject: { reference: "Patient/PT-1001" },
  occurrenceDateTime: "2026-03-01",
  priceOverride: { value: 40000, currency: "USD" },
};
eq("mapChargeItem", mapChargeItem(ci1), {
  emr_charge_id: "CI-1", emr_patient_id: "PT-1001", cpt_code: "22551",
  description: "ACDF surgery", billed_amount: 40000, date_of_service: "2026-03-01",
  status_raw: "billable",
});

// --- ChargeItem price via Invoice line item ---
const ci2 = {
  resourceType: "ChargeItem", id: "CI-2", status: "billable",
  code: { text: "ESI", coding: [{ code: "64483" }] },
  subject: { reference: "Patient/PT-1001" }, occurrenceDateTime: "2026-04-01",
};
const invoice = {
  resourceType: "Invoice", id: "INV-1", status: "issued",
  lineItem: [
    { chargeItemReference: { reference: "ChargeItem/CI-2" },
      priceComponent: [{ type: "base", amount: { value: 10000, currency: "USD" } }] },
  ],
};
const prices = invoicePrices(invoice);
eq("invoicePrices", prices, { "CI-2": 10000 });
eq("mapChargeItem via invoice price", mapChargeItem(ci2, prices).billed_amount, 10000);

// --- PaymentReconciliation with detail lines ---
const pr = {
  resourceType: "PaymentReconciliation", id: "PR-1", status: "active",
  paymentDate: "2026-05-01", _patientHint: "PT-1001",
  detail: [
    { type: { text: "PIP payment" }, amount: { value: 10000, currency: "USD" },
      request: { reference: "ChargeItem/CI-1" }, date: "2026-05-01" },
    { type: { text: "BCBS insurance" }, amount: { value: 8000, currency: "USD" }, date: "2026-06-01" },
  ],
};
const pays = mapPaymentReconciliation(pr);
eq("payment count", pays.length, 2);
eq("payment 0 pip", [pays[0].payer_type, pays[0].amount, pays[0].emr_charge_id, pays[0].emr_payment_id],
  ["pip", 10000, "CI-1", "PR-1:0"]);
eq("payment 1 insurance", [pays[1].payer_type, pays[1].amount, pays[1].paid_on],
  ["insurance", 8000, "2026-06-01"]);

// --- single-amount PaymentReconciliation (no detail array) ---
const prFlat = {
  resourceType: "PaymentReconciliation", id: "PR-2", created: "2026-07-01",
  paymentAmount: { value: 500, currency: "USD" }, _patientHint: "PT-2",
  paymentIssuer: { display: "Aetna" },
};
eq("flat payment falls back to paymentAmount",
  [mapPaymentReconciliation(prFlat)[0].amount, mapPaymentReconciliation(prFlat)[0].payer_type],
  [500, "insurance"]);

// --- Bundle paging ---
const bundle = {
  resourceType: "Bundle", type: "searchset",
  entry: [{ resource: ci1 }, { resource: ci2 }],
  link: [{ relation: "self", url: "u0" }, { relation: "next", url: "u1" }],
};
eq("bundleResources", bundleResources(bundle).map((r) => r.id), ["CI-1", "CI-2"]);
eq("nextLink", nextLink(bundle), "u1");
eq("nextLink none", nextLink({ link: [{ relation: "self", url: "u0" }] }), null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
