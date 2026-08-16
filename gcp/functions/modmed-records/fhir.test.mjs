// Node test for the DocumentReference mappers. Run: node fhir.test.mjs
import {
  refId, isoDate, classifyRecordType, pickAttachment,
  mapDocumentReference, nextLink, bundleResources,
} from "./fhir.js";

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++;
  else { fail++; console.error(`FAIL ${name}\n  got:  ${g}\n  want: ${w}`); }
};

// --- record-type classification: LOINC codes win ---
eq("loinc op note", classifyRecordType({ type: { coding: [{ system: "http://loinc.org", code: "11504-8" }] } }), "op_report");
eq("loinc imaging", classifyRecordType({ type: { coding: [{ code: "18748-4" }] } }), "imaging");
eq("loinc discharge", classifyRecordType({ type: { coding: [{ code: "18842-5" }] } }), "discharge");

// --- record-type classification: text fallback ---
eq("text operative", classifyRecordType({ type: { text: "Operative Report" } }), "op_report");
eq("text MRI", classifyRecordType({ type: { text: "MRI Lumbar Spine" } }), "imaging");
eq("text MMI", classifyRecordType({ description: "MMI / impairment rating letter" }), "mmi_letter");
eq("text oswestry", classifyRecordType({ type: { text: "Oswestry Disability Index" } }), "outcome_scores");
eq("text H&P", classifyRecordType({ type: { text: "Initial Eval - New Patient" } }), "initial_eval");
eq("text progress", classifyRecordType({ category: [{ coding: [{ display: "Follow-up office visit" }] }] }), "progress_notes");
eq("unknown -> other", classifyRecordType({ type: { text: "Billing worksheet" } }), "other");

// --- attachment pick ---
const dref = {
  resourceType: "DocumentReference", id: "DOC-1", status: "current",
  type: { coding: [{ system: "http://loinc.org", code: "11504-8" }], text: "Operative Report" },
  subject: { reference: "Patient/PT-1001" },
  date: "2026-03-02T09:00:00Z",
  content: [
    { attachment: { contentType: "application/pdf" } },              // no bytes/url — skipped
    { attachment: { contentType: "application/pdf", url: "Binary/bin-1", title: "op_note.pdf" } },
  ],
};
eq("pickAttachment skips empty", pickAttachment(dref).url, "Binary/bin-1");
eq("mapDocumentReference", mapDocumentReference(dref), {
  emr_document_id: "DOC-1", emr_patient_id: "PT-1001", record_type: "op_report",
  doc_date: "2026-03-02", description: null, filename: "op_note.pdf",
  mime_type: "application/pdf", status_raw: "current",
  _attachment: { url: "Binary/bin-1", data: null, contentType: "application/pdf" },
});

// --- filename fallback when the attachment has no title ---
const noTitle = {
  resourceType: "DocumentReference", id: "DOC-2", status: "current",
  type: { coding: [{ code: "18748-4" }] }, subject: { reference: "Patient/PT-1001" },
  context: { period: { start: "2026-02-15" } },
  content: [{ attachment: { contentType: "image/jpeg", data: "AAAA" } }],
};
const m2 = mapDocumentReference(noTitle);
eq("filename fallback + ext", [m2.filename, m2.doc_date, m2.record_type], ["imaging-DOC-2.jpg", "2026-02-15", "imaging"]);
eq("inline data attachment", m2._attachment, { url: null, data: "AAAA", contentType: "image/jpeg" });

// --- guards + paging ---
eq("non-docref -> null", mapDocumentReference({ resourceType: "Patient", id: "x" }), null);
const bundle = {
  entry: [{ resource: dref }, { resource: noTitle }],
  link: [{ relation: "self", url: "u0" }, { relation: "next", url: "u1" }],
};
eq("bundleResources", bundleResources(bundle).map((r) => r.id), ["DOC-1", "DOC-2"]);
eq("nextLink", nextLink(bundle), "u1");
eq("refId + isoDate", [refId("Patient/PT-9"), isoDate("2026-01-02T00:00:00Z")], ["PT-9", "2026-01-02"]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
