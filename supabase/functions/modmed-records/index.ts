// ============================================================
// miiCase — modmed-records edge function (READ-ONLY clinical pull)
// ============================================================
// Pulls clinical records from ModMed's EMA FHIR API into the private
// medical-records bucket + the `records` table, so the attorney portal can
// self-serve them under the HIPAA gate already built (0009). Read-only: it uses
// ModMed DocumentReference/Binary READ+SEARCH scopes and never writes to the EMR.
//
//   for each case with cases.emr_patient_id:
//     GET DocumentReference?patient=<id>            (paged)
//        │  fetch each Binary (bytes)  ──upload──▶ medical-records bucket
//        ▼
//   emr_record_staging (metadata + storage_key)  ──reconcile_emr_records(run)──▶ records
//
// Only patients that already have a case are pulled (no clinic-wide scrape).
// Credentials live only in this function's secrets (shared MODMED_* with
// modmed-sync). DRY_RUN stages metadata but does not download/upload files.
//
// Deploy: supabase functions deploy modmed-records --no-verify-jwt
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { mapDocumentReference, bundleResources, nextLink } from "./fhir.js";

const BASE = Deno.env.get("MODMED_BASE_URL") ?? "";
const API_KEY = Deno.env.get("MODMED_API_KEY") ?? "";
const USERNAME = Deno.env.get("MODMED_USERNAME") ?? "";
const PASSWORD = Deno.env.get("MODMED_PASSWORD") ?? "";
const TOKEN_URL = Deno.env.get("MODMED_TOKEN_URL") ??
  (BASE ? BASE.replace(/\/ema\/fhir\/v2\/?$/, "/ema/ws/oauth2/grant") : "");
const DRY_RUN = (Deno.env.get("MODMED_DRY_RUN") ?? "false").toLowerCase() === "true";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const BUCKET = "medical-records";
const PAGE_CAP = 50;         // paged reads per patient
const MAX_BYTES = 50 * 1024 * 1024;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

async function getToken(): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "x-api-key": API_KEY },
    body: new URLSearchParams({ grant_type: "password", username: USERNAME, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`token ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = await res.json();
  if (!j.access_token) throw new Error("token response had no access_token");
  return j.access_token as string;
}

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, "x-api-key": API_KEY };
}

async function fetchAll(token: string, path: string): Promise<any[]> {
  let url: string | null = path.startsWith("http") ? path : `${BASE}${path}`;
  const out: any[] = [];
  for (let page = 0; url && page < PAGE_CAP; page++) {
    const res: Response = await fetch(url, {
      headers: { ...authHeaders(token), Accept: "application/fhir+json" },
    });
    if (!res.ok) throw new Error(`GET ${url} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const bundle = await res.json();
    out.push(...bundleResources(bundle));
    url = nextLink(bundle);
  }
  return out;
}

// Retrieve a document's bytes. Inline base64 (attachment.data) is used as-is;
// otherwise the attachment.url is read as a FHIR Binary (relative "Binary/{id}"
// or absolute), asking for the document's own content type so ModMed returns
// the raw file rather than a FHIR JSON envelope.
// NOTE: if your ModMed tenant requires the BINARY_CREATE_URL POST flow to mint
// a download link first, add that call here and fetch the returned url.
async function fetchBytes(token: string, att: any): Promise<Uint8Array> {
  if (att.data) return Uint8Array.from(atob(att.data), (c) => c.charCodeAt(0));
  const url = att.url.startsWith("http") ? att.url : `${BASE}/${att.url.replace(/^\//, "")}`;
  const res = await fetch(url, {
    headers: { ...authHeaders(token), Accept: att.contentType || "application/octet-stream" },
  });
  if (!res.ok) throw new Error(`binary ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > MAX_BYTES) throw new Error(`binary too large (${buf.byteLength})`);
  return buf;
}

Deno.serve(async (req) => {
  if (req.method !== "POST" && req.method !== "GET") return json({ error: "method not allowed" }, 405);

  const missing = [
    ["MODMED_BASE_URL", BASE], ["MODMED_API_KEY", API_KEY],
    ["MODMED_USERNAME", USERNAME], ["MODMED_PASSWORD", PASSWORD],
    ["SUPABASE_URL", SUPABASE_URL], ["SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY],
  ].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) return json({ error: `missing env: ${missing.join(", ")}` }, 500);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: run, error: runErr } = await admin
    .from("emr_sync_run")
    .insert({ kind: "records", status: "running", resources: ["DocumentReference"], dry_run: DRY_RUN })
    .select("id").single();
  if (runErr || !run) return json({ error: runErr?.message ?? "could not open run" }, 500);
  const runId = run.id as string;

  try {
    // Only pull records for patients we actually have a case for.
    const { data: cases, error: caseErr } = await admin
      .from("cases").select("id, emr_patient_id").not("emr_patient_id", "is", null);
    if (caseErr) throw new Error(`cases: ${caseErr.message}`);

    const patientIds = [...new Set((cases ?? []).map((c: any) => c.emr_patient_id))];
    const caseByPatient = new Map((cases ?? []).map((c: any) => [c.emr_patient_id, c.id]));

    const token = await getToken();
    let seen = 0, uploaded = 0, fetchErrors = 0;

    for (const pid of patientIds) {
      const docs = await fetchAll(token, `/DocumentReference?patient=${encodeURIComponent(pid)}`);
      const mapped = docs.map(mapDocumentReference).filter((d): d is any => !!d && !!d.emr_document_id);
      seen += mapped.length;

      // Which of these already have a file, so we don't re-download every night.
      const ids = mapped.map((d) => d.emr_document_id);
      const already = new Set<string>();
      if (ids.length) {
        const { data: have } = await admin
          .from("records").select("emr_document_id")
          .in("emr_document_id", ids).not("storage_key", "is", null);
        for (const r of have ?? []) already.add(r.emr_document_id as string);
      }

      const staged: any[] = [];
      for (const d of mapped) {
        let storage_key: string | null = null;
        if (!DRY_RUN && d._attachment && !already.has(d.emr_document_id)) {
          try {
            const bytes = await fetchBytes(token, d._attachment);
            const caseId = caseByPatient.get(pid);
            const key = `emr/${caseId}/${d.emr_document_id}-${d.filename}`.replace(/\s+/g, "_");
            const { error: upErr } = await admin.storage.from(BUCKET)
              .upload(key, bytes, { contentType: d.mime_type || "application/octet-stream", upsert: true });
            if (upErr) throw new Error(upErr.message);
            storage_key = key;
            uploaded++;
          } catch (_e) {
            fetchErrors++; // leave storage_key null → lands as status 'received' (metadata known)
          }
        }
        const { _attachment, ...rest } = d;
        staged.push({ ...rest, storage_key, sync_run_id: runId });
      }
      if (staged.length) {
        const { error } = await admin.from("emr_record_staging").insert(staged);
        if (error) throw new Error(`stage: ${error.message}`);
      }
    }

    const { data: rec, error: recErr } = await admin.rpc("reconcile_emr_records", { p_run: runId });
    if (recErr) throw new Error(`reconcile: ${recErr.message}`);
    const reconciled = (Array.isArray(rec) ? rec[0] : rec) ??
      { records_upserted: 0, cases_touched: 0, unmatched: 0 };

    await admin.from("emr_sync_run").update({
      status: DRY_RUN ? "dry_run" : "ok",
      records_seen: seen,
      records_upserted: reconciled.records_upserted,
      files_uploaded: uploaded,
      cases_touched: reconciled.cases_touched,
      unmatched: reconciled.unmatched,
      error: fetchErrors ? `${fetchErrors} document(s) failed to download` : null,
      finished_at: new Date().toISOString(),
    }).eq("id", runId);

    return json({
      run_id: runId, dry_run: DRY_RUN,
      documents_seen: seen, files_uploaded: uploaded, fetch_errors: fetchErrors,
      reconciled,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await admin.from("emr_sync_run").update({
      status: "error", error: msg, finished_at: new Date().toISOString(),
    }).eq("id", runId);
    return json({ run_id: runId, error: msg }, 502);
  }
});
