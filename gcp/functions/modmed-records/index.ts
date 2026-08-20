// modmed-records job (Cloud Run) — READ-ONLY clinical-records pull from ModMed's
// EMA FHIR API. Ports the Supabase edge function to pg (owner) + Google Cloud
// Storage. The DocumentReference mappers (fhir.js) are unchanged;
// reconcile_emr_records() (migration 0011) does the DB work. fetch + upload are
// injectable for integration testing.
import { q, insertRows } from "../lib/db.ts";
import { config } from "../lib/config.ts";
import { modmedToken, fhirGetAll, authHeaders, type FetchLike } from "../lib/fhir-client.ts";
import { mapDocumentReference, bundleResources, nextLink } from "./fhir.js";

type Upload = (key: string, bytes: Uint8Array, contentType: string) => Promise<void>;
const MAX_BYTES = 50 * 1024 * 1024;

async function gcsUpload(key: string, bytes: Uint8Array, contentType: string) {
  const mod: any = await import("@google-cloud/storage");
  const Storage = (mod.default ?? mod).Storage ?? mod.Storage; // CJS-under-import() safety
  await new Storage().bucket(config.recordsBucket).file(key).save(Buffer.from(bytes), { contentType });
}

async function fetchBytes(token: string, att: any, fetchImpl: FetchLike): Promise<Uint8Array> {
  if (att.data) return Uint8Array.from(atob(att.data), (c) => c.charCodeAt(0));
  const url = att.url.startsWith("http") ? att.url : `${config.modmed.baseUrl}/${att.url.replace(/^\//, "")}`;
  const res = await fetchImpl(url, { headers: { ...authHeaders(token), Accept: att.contentType || "application/octet-stream" } });
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
    let seen = 0, uploaded = 0, fetchErrors = 0, noAttachment = 0, shapeLogged = false;

    for (const [pid, caseId] of caseByPatient) {
      const docs = await fhirGetAll(token, `/DocumentReference?patient=${encodeURIComponent(pid)}`, bundleResources, nextLink, fetchImpl);
      const mapped = docs.map(mapDocumentReference).filter((d: any) => d && d.emr_document_id);
      seen += mapped.length;
      for (const d of mapped) if (!d._attachment) noAttachment++;

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

      const ids = mapped.map((d: any) => d.emr_document_id);
      const already = new Set<string>();
      if (ids.length) {
        const have = await q("select emr_document_id from records where emr_document_id = any($1) and storage_key is not null", [ids]);
        for (const r of have.rows) already.add(r.emr_document_id);
      }

      const staged: any[] = [];
      for (const d of mapped) {
        let storage_key: string | null = null;
        if (!config.modmed.dryRun && d._attachment && !already.has(d.emr_document_id)) {
          try {
            const bytes = await fetchBytes(token, d._attachment, fetchImpl);
            const key = `emr/${caseId}/${d.emr_document_id}-${d.filename}`.replace(/\s+/g, "_");
            await uploadImpl(key, bytes, d.mime_type || "application/octet-stream");
            storage_key = key; uploaded++;
          } catch { fetchErrors++; }
        }
        const { _attachment, ...rest } = d;
        staged.push({ ...rest, storage_key, sync_run_id: runId });
      }
      await insertRows("emr_record_staging",
        ["sync_run_id", "emr_document_id", "emr_patient_id", "record_type", "doc_date", "description", "filename", "mime_type", "storage_key", "status_raw"], staged);
    }

    const reconciled = (await q("select * from reconcile_emr_records($1)", [runId])).rows[0];
    await q(
      "update emr_sync_run set status=$2, records_seen=$3, records_upserted=$4, files_uploaded=$5, cases_touched=$6, unmatched=$7, error=$8, finished_at=now() where id=$1",
      [runId, config.modmed.dryRun ? "dry_run" : "ok", seen, reconciled.records_upserted, uploaded,
        reconciled.cases_touched, reconciled.unmatched, fetchErrors ? `${fetchErrors} document(s) failed to download` : null]);
    return { run_id: runId, dry_run: config.modmed.dryRun, documents_seen: seen, no_attachment: noAttachment, files_uploaded: uploaded, fetch_errors: fetchErrors, reconciled };
  } catch (e) {
    await q("update emr_sync_run set status='error', error=$2, finished_at=now() where id=$1",
      [runId, e instanceof Error ? e.message : String(e)]);
    throw e;
  }
}
