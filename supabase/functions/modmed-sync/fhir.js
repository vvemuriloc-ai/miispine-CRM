// ============================================================
// miiCase — ModMed FHIR mapping helpers (pure, no runtime deps)
// ============================================================
// Kept dependency-free and framework-free so the same code runs under Deno
// (the edge function) and Node (the test at fhir.test.mjs). Everything here is
// READ-ONLY interpretation of FHIR R4 resources ModMed returns — nothing here
// contacts ModMed or the database.
//
// Two mappings are intentionally heuristic and documented for tuning against a
// real ModMed instance:
//   * payer typing (PIP vs insurance) — classifyPayer() keyword match, because
//     generic FHIR doesn't label "PIP" as such; ModMed's payer/coverage text
//     is the signal.
//   * charge pricing — ChargeItem.priceOverride, else an Invoice.lineItem
//     priceComponent, else 0 with the raw kept for review.
// ============================================================

/** Pull the bare id out of a FHIR reference like "Patient/PT-1001". */
export function refId(ref) {
  if (!ref) return null;
  const s = typeof ref === "string" ? ref : ref.reference;
  if (!s) return null;
  const parts = String(s).split("/");
  return parts[parts.length - 1] || null;
}

/** Numeric value from a FHIR Money ({value, currency}) or a bare number. */
export function money(m) {
  if (m == null) return 0;
  if (typeof m === "number") return m;
  const v = m.value ?? m.amount?.value;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** First CPT/HCPCS code out of a FHIR CodeableConcept. */
export function cpt(codeable) {
  const coding = codeable?.coding;
  if (!Array.isArray(coding) || coding.length === 0) return null;
  // Prefer an AMA CPT system if present; otherwise take the first code.
  const cptSys = coding.find((c) =>
    typeof c.system === "string" && /cpt|hcpcs/i.test(c.system));
  return (cptSys || coding[0])?.code ?? null;
}

/** Human label out of a CodeableConcept (text, else first coding display). */
export function display(codeable) {
  if (!codeable) return null;
  if (codeable.text) return codeable.text;
  const c = codeable.coding?.[0];
  return c?.display ?? null;
}

/** FHIR date/dateTime -> YYYY-MM-DD (or null). */
export function isoDate(d) {
  if (!d) return null;
  const s = String(d);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

// ---- Charges ---------------------------------------------------------------
// A ChargeItem is the natural per-service charge. Price may live on the
// ChargeItem (priceOverride) or, in some ModMed setups, on the Invoice line
// that references it — the sync passes an optional priceByCharge lookup.
export function mapChargeItem(res, priceByCharge = {}) {
  if (!res || res.resourceType !== "ChargeItem") return null;
  const id = res.id;
  const price = res.priceOverride != null
    ? money(res.priceOverride)
    : (priceByCharge[id] ?? 0);
  return {
    emr_charge_id: id,
    emr_patient_id: refId(res.subject),
    cpt_code: cpt(res.code),
    description: display(res.code),
    billed_amount: price,
    date_of_service: isoDate(res.occurrenceDateTime || res.occurrencePeriod?.start),
    status_raw: res.status ?? null,
  };
}

/** Build {chargeId: amount} from an Invoice's line items (base price sum). */
export function invoicePrices(invoice) {
  const out = {};
  if (invoice?.resourceType !== "Invoice") return out;
  for (const li of invoice.lineItem ?? []) {
    const cid = refId(li.chargeItemReference);
    if (!cid) continue;
    const base = (li.priceComponent ?? [])
      .filter((p) => !p.type || p.type === "base")
      .reduce((s, p) => s + money(p.amount), 0);
    out[cid] = (out[cid] ?? 0) + base;
  }
  return out;
}

// ---- Payments --------------------------------------------------------------
// PIP vs insurance is inferred from the payer/coverage label. KY no-fault
// "PIP" (a.k.a. med-pay / personal injury protection) reduces the lien
// differently from health-insurance payments, so the classification matters.
export function classifyPayer(label) {
  const t = (label || "").toLowerCase();
  if (!t) return "other";
  if (/\bpip\b|personal injury protection|no[- ]?fault|med[- ]?pay/.test(t)) return "pip";
  if (/insur|health|bcbs|aetna|cigna|united|humana|medicare|medicaid|carrier|payer|payor/.test(t)) {
    return "insurance";
  }
  return "other";
}

// A PaymentReconciliation carries one or more detail lines; each posts an
// amount, optionally against a request (Claim/ChargeItem) with a payee.
export function mapPaymentReconciliation(res) {
  if (!res || res.resourceType !== "PaymentReconciliation") return [];
  const patient = refId(res.paymentIssuer) || refId(res.requestor) ||
    refId(res.request) || res._patientHint || null;
  const topDate = isoDate(res.paymentDate || res.created);
  const details = Array.isArray(res.detail) && res.detail.length
    ? res.detail
    : [{ amount: res.paymentAmount, date: topDate, type: res.paymentStatus }];
  return details.map((d, i) => {
    const label = display(d.type) || d.payee?.display || res.paymentIssuer?.display || "";
    return {
      emr_payment_id: `${res.id}${details.length > 1 ? ":" + i : ""}`,
      emr_charge_id: refId(d.request) || null,
      emr_patient_id: patient,
      amount: money(d.amount),
      payer_type: classifyPayer(label),
      payer_label: label || null,
      paid_on: isoDate(d.date) || topDate,
    };
  });
}

/** Follow FHIR Bundle paging: the URL of the `next` link, or null. */
export function nextLink(bundle) {
  const link = bundle?.link;
  if (!Array.isArray(link)) return null;
  return link.find((l) => l.relation === "next")?.url ?? null;
}

/** Resource entries out of a search Bundle. */
export function bundleResources(bundle) {
  return (bundle?.entry ?? []).map((e) => e.resource).filter(Boolean);
}
