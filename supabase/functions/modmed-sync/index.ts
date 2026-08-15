// ============================================================
// miiCase — modmed-sync edge function (READ-ONLY AR pull)
// ============================================================
// Pulls charges + payments from ModMed's FHIR API into the covered database.
// This is the ONLY component that holds ModMed credentials — they live in
// function secrets, never in the browser and never leave this function. It
// only ever GETs from ModMed (plus the OAuth token POST); it never writes to
// the EMR.
//
//   ModMed FHIR (x-api-key + OAuth2 bearer)
//        │  GET ChargeItem / Invoice / PaymentReconciliation  (paged)
//        ▼
//   emr_charge_staging / emr_payment_staging   (service role)
//        │  reconcile_emr(run_id)
//        ▼
//   medical_bills (deduped on emr_charge_id) → lien/AR triggers recompute
//
// Secrets:
//   MODMED_BASE_URL   e.g. https://<env>.ema-api.com/ema-<stage>/firm/<prefix>/ema/fhir/v2
//   MODMED_API_KEY    the ModMed-issued x-api-key
//   MODMED_USERNAME / MODMED_PASSWORD   OAuth2 password-grant creds
//   MODMED_TOKEN_URL  (optional) override; defaults to <base>/../../ws/oauth2/grant
//   MODMED_DRY_RUN    "true" ⇒ stage + report, skip reconcile writes to bills
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
//
// Deploy: supabase functions deploy modmed-sync --no-verify-jwt
// Invoke: scheduled (pg_cron/pg_net) or `supabase functions invoke modmed-sync`
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  mapChargeItem, invoicePrices, mapPaymentReconciliation,
  bundleResources, nextLink,
} from "./fhir.js";

const BASE = Deno.env.get("MODMED_BASE_URL") ?? "";
const API_KEY = Deno.env.get("MODMED_API_KEY") ?? "";
const USERNAME = Deno.env.get("MODMED_USERNAME") ?? "";
const PASSWORD = Deno.env.get("MODMED_PASSWORD") ?? "";
const TOKEN_URL = Deno.env.get("MODMED_TOKEN_URL") ??
  (BASE ? BASE.replace(/\/ema\/fhir\/v2\/?$/, "/ema/ws/oauth2/grant") : "");
const DRY_RUN = (Deno.env.get("MODMED_DRY_RUN") ?? "false").toLowerCase() === "true";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const PAGE_CAP = 50; // safety bound on paged FHIR reads per resource

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

// ---- ModMed auth: OAuth2 password grant, guarded by the api key -----------
async function getToken(): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "password", username: USERNAME, password: PASSWORD,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "x-api-key": API_KEY },
    body,
  });
  if (!res.ok) throw new Error(`token ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = await res.json();
  if (!j.access_token) throw new Error("token response had no access_token");
  return j.access_token as string;
}

// ---- Paged FHIR GET (read-only) -------------------------------------------
async function fetchAll(token: string, path: string): Promise<any[]> {
  const headers = {
    Authorization: `Bearer ${token}`, "x-api-key": API_KEY, Accept: "application/fhir+json",
  };
  // Absolute path for the first page; ModMed returns absolute `next` links.
  let url: string | null = path.startsWith("http") ? path : `${BASE}${path}`;
  const out: any[] = [];
  for (let page = 0; url && page < PAGE_CAP; page++) {
    const res: Response = await fetch(url, { headers });
    if (!res.ok) throw new Error(`GET ${url} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const bundle = await res.json();
    out.push(...bundleResources(bundle));
    url = nextLink(bundle);
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method !== "POST" && req.method !== "GET") return json({ error: "method not allowed" }, 405);

  const missing = [
    ["MODMED_BASE_URL", BASE], ["MODMED_API_KEY", API_KEY],
    ["MODMED_USERNAME", USERNAME], ["MODMED_PASSWORD", PASSWORD],
    ["SUPABASE_URL", SUPABASE_URL], ["SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY],
  ].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) return json({ error: `missing env: ${missing.join(", ")}` }, 500);

  // Optional window: ?since=YYYY-MM-DD narrows the pull to recently changed rows.
  const since = new URL(req.url).searchParams.get("since");
  const dateParam = since ? `&date=ge${since}` : "";

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const resources = ["ChargeItem", "Invoice", "PaymentReconciliation"];

  // Open a run row up front so a mid-run failure is still visible.
  const { data: run, error: runErr } = await admin
    .from("emr_sync_run")
    .insert({ kind: "ar", status: "running", resources, dry_run: DRY_RUN })
    .select("id").single();
  if (runErr || !run) return json({ error: runErr?.message ?? "could not open run" }, 500);
  const runId = run.id as string;

  try {
    const token = await getToken();

    // Pull. Invoices are read only to recover per-charge prices when the
    // ChargeItem itself carries no priceOverride.
    const [charges, invoices, payments] = await Promise.all([
      fetchAll(token, `/ChargeItem?_count=100${dateParam}`),
      fetchAll(token, `/Invoice?_count=100${dateParam}`),
      fetchAll(token, `/PaymentReconciliation?_count=100${dateParam}`),
    ]);

    const priceByCharge: Record<string, number> = {};
    for (const inv of invoices) Object.assign(priceByCharge, invoicePrices(inv));

    const chargeRows = charges
      .map((c) => mapChargeItem(c, priceByCharge))
      .filter((c) => c && c.emr_charge_id)
      .map((c) => ({ ...c, sync_run_id: runId, raw: undefined }));

    const paymentRows = payments
      .flatMap((p) => mapPaymentReconciliation(p))
      .filter((p) => p && p.emr_payment_id && p.amount)
      .map((p) => ({ ...p, sync_run_id: runId }));

    if (chargeRows.length) {
      const { error } = await admin.from("emr_charge_staging").insert(chargeRows);
      if (error) throw new Error(`stage charges: ${error.message}`);
    }
    if (paymentRows.length) {
      const { error } = await admin.from("emr_payment_staging").insert(paymentRows);
      if (error) throw new Error(`stage payments: ${error.message}`);
    }

    let reconciled = { charges_upserted: 0, cases_touched: 0, unmatched: 0 };
    if (!DRY_RUN) {
      const { data, error } = await admin.rpc("reconcile_emr", { p_run: runId });
      if (error) throw new Error(`reconcile: ${error.message}`);
      reconciled = (Array.isArray(data) ? data[0] : data) ?? reconciled;
    }

    await admin.from("emr_sync_run").update({
      status: DRY_RUN ? "dry_run" : "ok",
      charges_seen: chargeRows.length,
      payments_seen: paymentRows.length,
      charges_upserted: reconciled.charges_upserted,
      cases_touched: reconciled.cases_touched,
      unmatched: reconciled.unmatched,
      finished_at: new Date().toISOString(),
    }).eq("id", runId);

    return json({ run_id: runId, dry_run: DRY_RUN, seen: {
      charges: chargeRows.length, payments: paymentRows.length }, reconciled });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await admin.from("emr_sync_run").update({
      status: "error", error: msg, finished_at: new Date().toISOString(),
    }).eq("id", runId);
    return json({ run_id: runId, error: msg }, 502);
  }
});
