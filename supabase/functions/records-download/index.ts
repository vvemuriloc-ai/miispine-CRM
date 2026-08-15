// ============================================================
// miiCase — records-download edge function
// Mints a short-lived signed URL for one medical record, but only after:
//   1. firm ownership passes (RLS, using the caller's JWT),
//   2. the case's HIPAA release is on file, and
//   3. the access is written to the immutable audit_log.
// This is the ONLY path to a record file for an attorney — the bucket is
// private and the browser never sees a raw storage path.
// ============================================================
//
// Deploy: supabase functions deploy records-download   (verify_jwt = true)
// Call:   supabase.functions.invoke("records-download", { body: { record_id } })
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SIGNED_URL_TTL = 60; // seconds

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader) return json({ error: "unauthenticated" }, 401);

  let recordId: string | undefined;
  try {
    recordId = (await req.json())?.record_id;
  } catch { /* fallthrough */ }
  if (!recordId) return json({ error: "record_id required" }, 400);

  // Caller-scoped client — RLS enforces firm ownership on this read.
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return json({ error: "unauthenticated" }, 401);

  // RLS returns the row only if the caller's firm owns it (or they are staff).
  const { data: rec, error: recErr } = await userClient
    .from("records")
    .select("id, firm_id, storage_key, status, case:cases(client:clients(hipaa_release_on_file))")
    .eq("id", recordId)
    .maybeSingle();

  if (recErr) return json({ error: recErr.message }, 400);
  if (!rec) return json({ error: "not found or not authorized" }, 403);

  // HIPAA authorization gate.
  const release = (rec as any).case?.client?.hipaa_release_on_file === true;
  if (!release) return json({ error: "HIPAA release not on file for this client" }, 403);

  if (!rec.storage_key) return json({ error: "record has no file yet" }, 409);

  // Service-role client: mint the signed URL and write the audit row.
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: signed, error: signErr } = await admin.storage
    .from("medical-records")
    .createSignedUrl(rec.storage_key, SIGNED_URL_TTL);
  if (signErr || !signed) return json({ error: signErr?.message ?? "could not sign" }, 500);

  await admin.from("audit_log").insert({
    user_id: user.id,
    firm_id: rec.firm_id,
    action: "record_download",
    resource_type: "record",
    resource_id: rec.id,
    ip_address: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
    user_agent: req.headers.get("user-agent") || null,
  });

  return json({ url: signed.signedUrl, expires_in: SIGNED_URL_TTL });
});
