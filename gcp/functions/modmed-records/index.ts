// modmed-records job (Cloud Run) — READ-ONLY clinical-records pull from ModMed's
// EMA FHIR API. Ports the Supabase edge function to pg (owner) + Google Cloud
// Storage. The DocumentReference mappers (fhir.js) are unchanged;
// reconcile_emr_records() (migration 0011) does the DB work. fetch + upload are
// injectable for integration testing.
//
// ModMed confirmed (support thread, Aug 2026): GET DocumentReference?patient=X
// (search) never includes content[] — it's a summary listing. The real
// attachment (often a pre-signed S3 url, ~5min expiry) only appears on an
// individual GET DocumentReference/{id}. So every document without a usable
// attachment from the search result gets one extra bounded-concurrency read
// before we decide there's nothing to download.
import { q, insertRows } from "../lib/db.ts";
import { config } from "../lib/config.ts";
import { modmedToken, fhirGetAll, authHeaders, type FetchLike } from "../lib/fhir-client.ts";
import { mapDocumentReference, bundleResources, nextLink } from "./fhir.js";

type Upload = (key: string, bytes: Uint8Array, contentType: string) => Promise<void>;
// Cap sized to the 2Gi container: the largest real ModMed documents seen so
// far are ~150MB imaging bundles; even a few concurrent at this cap fit.
const MAX_BYTES = 200 * 1024 * 1024;
const ENRICH_CONCURRENCY = 6;

// Does this raw DocumentReference's type/category look like ModMed's UI
// "Attachments" grouping (as opposed to a clinical note)? Text-matching only,
// used purely to bucket a diagnostic count — never logged or stored verbatim.
function looksLikeAttachmentCategory(raw: any): boolean {
  const bits: string[] = [];
  const push = (cc: any) => {
    if (!cc) return;
    if (cc.text) bits.push(cc.text);
    for (const c of cc.coding ?? []) if (c.display) bits.push(c.display);
  };
  push(raw?.type);
  for (const cat of raw?.category ?? []) push(cat);
  return /attach/i.test(bits.join(" "));
}

// Bounded-concurrency map — 2900+ documents means 2900+ individual reads;
// neither fully sequential nor fully unbounded parallel is appropriate here.
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function fetchDocumentById(token: string, id: string, fetchImpl: FetchLike): Promise<any | null> {
  const url = `${config.modmed.baseUrl}/DocumentReference/${encodeURIComponent(id)}`;
  const res = await fetchImpl(url, { headers: { ...authHeaders(token), Accept: "application/fhir+json" } });
  if (!res.ok) return null;
  return res.json();
}

// ModMed's attachment contentType is often absent or wrong: scanned files are
// real PDFs, but generated office/procedure notes arrive as HTML or clinical
// XML mislabeled (or unlabeled → ".bin"), which then "open as code". Identify
// the actual format from the first bytes and store the true type + extension.
export function sniffType(bytes: Uint8Array): { mime: string; ext: string } | null {
  const b = bytes;
  if (b.length < 4) return null;
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return { mime: "application/pdf", ext: "pdf" };
  if (b[0] === 0x89 && b[1] === 0x50) return { mime: "image/png", ext: "png" };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00)) return { mime: "image/tiff", ext: "tif" };
  const head = new TextDecoder("utf-8", { fatal: false }).decode(b.slice(0, 512)).replace(/^﻿/, "").trimStart().toLowerCase();
  if (head.startsWith("{\\rtf")) return { mime: "application/rtf", ext: "rtf" };
  if (head.startsWith("<?xml") || head.startsWith("<clinicaldocument")) return { mime: "text/xml", ext: "xml" };
  if (head.startsWith("<!doctype html") || head.startsWith("<html")) return { mime: "text/html", ext: "html" };
  return null;
}

async function gcsUpload(key: string, bytes: Uint8Array, contentType: string) {
  const mod: any = await import("@google-cloud/storage");
  const Storage = (mod.default ?? mod).Storage ?? mod.Storage; // CJS-under-import() safety
  await new Storage().bucket(config.recordsBucket).file(key).save(Buffer.from(bytes), { contentType });
}

async function fetchBytes(token: string, att: any, fetchImpl: FetchLike): Promise<Uint8Array> {
  if (att.data) return Uint8Array.from(atob(att.data), (c) => c.charCodeAt(0));
  const isAbsolute = /^https?:\/\//i.test(att.url);
  const url = isAbsolute ? att.url : `${config.modmed.baseUrl}/${att.url.replace(/^\//, "")}`;
  // ModMed's DocumentReference.content[].attachment.url is often a pre-signed
  // S3 link (query-string auth, ~5min expiry). Sending our ModMed Bearer/
  // x-api-key headers alongside a pre-signed URL breaks S3's signature check
  // (SignatureDoesNotMatch) — those headers belong only on ModMed-hosted
  // relative paths, never on an already-authenticated absolute URL.
  const headers = isAbsolute ? {} : { ...authHeaders(token), Accept: att.contentType || "application/octet-stream" };
  const res = await fetchImpl(url, { headers });
  if (!res.ok) throw new Error(`binary ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > MAX_BYTES) throw new Error(`binary too large (${buf.byteLength})`);
  return buf;
}

export async function run(deps: { fetchImpl?: FetchLike; uploadImpl?: Upload } = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const uploadImpl = deps.uploadImpl ?? gcsUpload;
  const runRow = await q(
    "insert into emr_sync_run(kind,status,resources,dry_run) values('records','running',$1,$2) returning id",
    [["DocumentReference"], config.modmed.dryRun]);
  const runId = runRow.rows[0].id;
  try {
    const cs = await q("select id, emr_patient_id from cases where emr_patient_id is not null");
    const caseByPatient = new Map<string, string>(cs.rows.map((r: any) => [r.emr_patient_id, r.id]));

    const token = await modmedToken(fetchImpl);
    let seen = 0, uploaded = 0, fetchErrors = 0, shapeLogged = false;
    // Diagnostic totals across ALL documents (not just the first) — booleans
    // and counts only, never document content/titles, so this stays PHI-free.
    // "Attachment category" flags documents ModMed's own UI labels as
    // "Attachments" (distinct from clinical notes), per a user report that
    // those may carry a real, retrievable file even where notes don't.
    let withUsableAttachment = 0, attachCategoryDocs = 0, attachCategoryWithFile = 0;
    let enrichAttempted = 0, enrichFailed = 0;
    // Rendition census: how many docs offer multiple content[] entries, and
    // which contentTypes appear (counts only — no PHI). Confirms whether EMA
    // ships a preview image alongside the real document rendition.
    let multiRendition = 0;
    const renditionTypes: Record<string, number> = {};
    // Document ids + error reasons only (no patient data) — so a handful of
    // persistent failures can be identified instead of just counted.
    const failedDocs: string[] = [];

    for (const [pid, caseId] of caseByPatient) {
      const docs = await fhirGetAll(token, `/DocumentReference?patient=${encodeURIComponent(pid)}`, bundleResources, nextLink, fetchImpl);
      const entries = docs
        .map((raw: any) => ({ raw, m: mapDocumentReference(raw) }))
        .filter((e: any) => e.m && e.m.emr_document_id);
      seen += entries.length;

      // One-time diagnostic: field NAMES only (never values — no PHI) from the
      // first document's raw content[]/attachment, so a missing-attachment
      // pattern is visible without exposing patient data.
      if (!shapeLogged && docs.length) {
        const raw = docs[0];
        const content0 = raw?.content?.[0] ?? {};
        console.log("DocumentReference shape (field names only):", JSON.stringify({
          topLevelKeys: Object.keys(raw ?? {}),
          contentKeys: Object.keys(content0),
          attachmentKeys: Object.keys(content0.attachment ?? {}),
        }));
        shapeLogged = true;
      }

      const ids = entries.map((e: any) => e.m.emr_document_id);
      const already = new Set<string>();
      if (ids.length) {
        const have = await q("select emr_document_id from records where emr_document_id = any($1) and storage_key is not null", [ids]);
        for (const r of have.rows) already.add(r.emr_document_id);
      }

      // Search results never carry content[] — each not-yet-uploaded document
      // gets one individual read for the real attachment, then downloads
      // IMMEDIATELY: the attachment url is a ~5-minute pre-signed link, so
      // enriching a whole batch up front and downloading later would hand us
      // expired urls for document-heavy patients.
      await mapLimit(entries, ENRICH_CONCURRENCY, async (e: any) => {
        const skip = already.has(e.m.emr_document_id);
        if (!e.m._attachment && !skip) {
          enrichAttempted++;
          try {
            const full = await fetchDocumentById(token, e.m.emr_document_id, fetchImpl);
            const contents = full?.content ?? [];
            if (contents.length > 1) multiRendition++;
            for (const c of contents) {
              const t = (c?.attachment?.contentType || "none").toLowerCase();
              renditionTypes[t] = (renditionTypes[t] ?? 0) + 1;
            }
            const remapped = full && mapDocumentReference(full);
            if (remapped?._attachment) e.m = remapped;
            else enrichFailed++;
          } catch { enrichFailed++; }
        }
        if (!config.modmed.dryRun && e.m._attachment && !skip) {
          try {
            const bytes = await fetchBytes(token, e.m._attachment, fetchImpl);
            // Trust the bytes over ModMed's (often missing/wrong) contentType.
            const sniffed = sniffType(bytes);
            if (sniffed) {
              e.m.mime_type = sniffed.mime;
              e.m.filename = String(e.m.filename || e.m.emr_document_id).replace(/\.[A-Za-z0-9]{1,5}$/, "") + "." + sniffed.ext;
            }
            const key = `emr/${caseId}/${e.m.emr_document_id}-${e.m.filename}`.replace(/\s+/g, "_");
            await uploadImpl(key, bytes, e.m.mime_type || "application/octet-stream");
            e.storage_key = key; uploaded++;
          } catch (err) {
            fetchErrors++;
            failedDocs.push(`${e.m.emr_document_id}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      });

      for (const { raw, m } of entries) {
        const hasFile = !!m._attachment;
        if (hasFile) withUsableAttachment++;
        if (looksLikeAttachmentCategory(raw)) {
          attachCategoryDocs++;
          if (hasFile) attachCategoryWithFile++;
        }
      }

      const staged: any[] = [];
      for (const e of entries) {
        const { _attachment, ...rest } = e.m;
        staged.push({ ...rest, storage_key: e.storage_key ?? null, sync_run_id: runId });
      }
      await insertRows("emr_record_staging",
        ["sync_run_id", "emr_document_id", "emr_patient_id", "record_type", "doc_date", "description", "filename", "mime_type", "storage_key", "status_raw"], staged);
    }

    const attachmentSummary = {
      total_docs: seen,
      with_usable_attachment: withUsableAttachment,
      attachment_category_docs: attachCategoryDocs,
      attachment_category_with_usable_attachment: attachCategoryWithFile,
      enrich_attempted: enrichAttempted,
      enrich_failed: enrichFailed,
      multi_rendition_docs: multiRendition,
      rendition_types: renditionTypes,
    };
    console.log("DocumentReference attachment summary:", JSON.stringify(attachmentSummary));

    const reconciled = (await q("select * from reconcile_emr_records($1)", [runId])).rows[0];
    await q(
      "update emr_sync_run set status=$2, records_seen=$3, records_upserted=$4, files_uploaded=$5, cases_touched=$6, unmatched=$7, error=$8, finished_at=now() where id=$1",
      [runId, config.modmed.dryRun ? "dry_run" : "ok", seen, reconciled.records_upserted, uploaded,
        reconciled.cases_touched, reconciled.unmatched,
        fetchErrors ? `${fetchErrors} document(s) failed to download — ${failedDocs.slice(0, 10).join("; ")}` : null]);
    if (failedDocs.length) console.log("download failures (doc id: reason):", JSON.stringify(failedDocs.slice(0, 20)));
    return {
      run_id: runId, dry_run: config.modmed.dryRun, documents_seen: seen,
      attachment_summary: attachmentSummary,
      files_uploaded: uploaded, fetch_errors: fetchErrors,
      failed_documents: failedDocs.slice(0, 10), reconciled,
    };
  } catch (e) {
    await q("update emr_sync_run set status='error', error=$2, finished_at=now() where id=$1",
      [runId, e instanceof Error ? e.message : String(e)]);
    throw e;
  }
}
