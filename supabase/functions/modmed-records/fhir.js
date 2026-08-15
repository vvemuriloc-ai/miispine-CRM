// ============================================================
// miiCase — ModMed EMA (clinical) FHIR mapping helpers (pure, no deps)
// ============================================================
// READ-ONLY interpretation of DocumentReference resources from ModMed's EMA
// FHIR API. Kept dependency-free so the same code runs under Deno (the edge
// function) and Node (fhir.test.mjs). Nothing here contacts ModMed or the DB.
//
// Self-contained on purpose (duplicates a few tiny primitives from
// modmed-sync/fhir.js) so this function deploys as an independent bundle.
// ============================================================

/** Bare id out of a FHIR reference ("Patient/PT-1001" -> "PT-1001"). */
export function refId(ref) {
  if (!ref) return null;
  const s = typeof ref === "string" ? ref : ref.reference;
  if (!s) return null;
  const parts = String(s).split("/");
  return parts[parts.length - 1] || null;
}

/** FHIR date/dateTime -> YYYY-MM-DD (or null). */
export function isoDate(d) {
  if (!d) return null;
  const m = String(d).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/** All the human-readable text on a DocumentReference's type/category. */
function typeText(res) {
  const bits = [];
  const push = (cc) => {
    if (!cc) return;
    if (cc.text) bits.push(cc.text);
    for (const c of cc.coding ?? []) if (c.display) bits.push(c.display);
  };
  push(res.type);
  for (const cat of res.category ?? []) push(cat);
  if (res.description) bits.push(res.description);
  return bits.join(" ").toLowerCase();
}

/** All LOINC codes present on type/category. */
function loincCodes(res) {
  const out = [];
  const grab = (cc) => { for (const c of cc?.coding ?? []) if (c.code) out.push(String(c.code)); };
  grab(res.type);
  for (const cat of res.category ?? []) grab(cat);
  return out;
}

// records.record_type enum: initial_eval | op_report | imaging | progress_notes
//                         | discharge | mmi_letter | outcome_scores | other
const LOINC = {
  "11504-8": "op_report", "28583-3": "op_report",           // operative / surgical note
  "18748-4": "imaging", "24606-6": "imaging",               // diagnostic imaging study
  "18842-5": "discharge",                                   // discharge summary
  "51848-0": "initial_eval", "34117-2": "initial_eval",     // eval note / H&P
  "11506-3": "progress_notes", "11488-4": "progress_notes", // progress / consult note
};

/** Map a DocumentReference to one of the records enum values. */
export function classifyRecordType(res) {
  for (const code of loincCodes(res)) if (LOINC[code]) return LOINC[code];
  const t = typeText(res);
  if (/\bmmi\b|maximum medical improvement|impairment rating|permanency/.test(t)) return "mmi_letter";
  if (/operat|surgical note|op note|op report/.test(t)) return "op_report";
  if (/mri|x-?ray|ct scan|radiolog|imaging|ultrasound/.test(t)) return "imaging";
  if (/discharge/.test(t)) return "discharge";
  if (/oswestry|\bodi\b|\bvas\b|outcome score|patient reported|\bprom\b/.test(t)) return "outcome_scores";
  if (/initial eval|new patient|h&p|history and physical|consult/.test(t)) return "initial_eval";
  if (/progress|follow-?up|office visit|clinic note/.test(t)) return "progress_notes";
  return "other";
}

/** The first usable attachment (has bytes or a url) on the DocumentReference. */
export function pickAttachment(res) {
  for (const c of res.content ?? []) {
    const a = c.attachment;
    if (a && (a.data || a.url)) return a;
  }
  return null;
}

function extFor(mime) {
  return ({
    "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png",
    "image/tiff": "tif", "text/plain": "txt", "text/html": "html",
    "application/xml": "xml", "text/xml": "xml",
  })[mime] || "bin";
}

/** Normalize a DocumentReference into the fields emr_record_staging wants. */
export function mapDocumentReference(res) {
  if (!res || res.resourceType !== "DocumentReference") return null;
  if (!res.id) return null;
  const att = pickAttachment(res);
  const record_type = classifyRecordType(res);
  const mime = att?.contentType ?? null;
  const doc_date = isoDate(res.date || res.context?.period?.start);
  const filename = att?.title ||
    `${record_type}-${res.id}.${extFor(mime)}`;
  return {
    emr_document_id: res.id,
    emr_patient_id: refId(res.subject),
    record_type,
    doc_date,
    description: res.description ?? null,
    filename,
    mime_type: mime,
    status_raw: res.status ?? null,
    // Fetch hints for the edge function (not stored):
    _attachment: att ? { url: att.url ?? null, data: att.data ?? null, contentType: mime } : null,
  };
}

/** Follow FHIR Bundle paging: URL of the `next` link, or null. */
export function nextLink(bundle) {
  const link = bundle?.link;
  if (!Array.isArray(link)) return null;
  return link.find((l) => l.relation === "next")?.url ?? null;
}

/** Resource entries out of a search Bundle. */
export function bundleResources(bundle) {
  return (bundle?.entry ?? []).map((e) => e.resource).filter(Boolean);
}
