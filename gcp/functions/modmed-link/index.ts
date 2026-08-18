// modmed-link job (Cloud Run) — link cases to ModMed patients, READ-ONLY.
// For each client on a case with no emr_patient_id, searches the EMA FHIR
// Patient endpoint by name (+ birthdate when we have it). Exactly one match →
// links every case for that client. Zero or multiple → reported for human
// review, never guessed. Run manually after an import; safe to re-run.
import { q } from "../lib/db.ts";
import { modmedToken, fhirGetAll, type FetchLike } from "../lib/fhir-client.ts";

// Minimal bundle helpers (Patient bundles only).
const bundleResources = (b: any) => (b?.entry ?? []).map((e: any) => e.resource).filter(Boolean);
const nextLink = (b: any) => (Array.isArray(b?.link) ? b.link.find((l: any) => l.relation === "next")?.url ?? null : null);

export async function run(deps: { fetchImpl?: FetchLike } = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;

  // One row per client that has at least one unlinked case.
  const clients = (await q(`
    select cl.id as client_id, cl.first_name, cl.last_name, cl.dob,
           array_agg(c.id) as case_ids
    from cases c join clients cl on cl.id = c.client_id
    where c.emr_patient_id is null
    group by cl.id, cl.first_name, cl.last_name, cl.dob
    order by cl.last_name`)).rows;

  const token = await modmedToken(fetchImpl);
  const results = { linked: 0, cases_linked: 0, ambiguous: [] as any[], not_found: [] as any[], errors: 0 };

  for (const cl of clients) {
    try {
      const params = new URLSearchParams({ family: cl.last_name, _count: "10" });
      if (cl.first_name) params.set("given", cl.first_name);
      if (cl.dob) params.set("birthdate", String(cl.dob).slice(0, 10));
      const patients = await fhirGetAll(token, `/Patient?${params}`, bundleResources, nextLink, fetchImpl, 2);
      const ids = [...new Set(patients.map((p: any) => p?.id).filter(Boolean))];

      if (ids.length === 1) {
        await q("update cases set emr_patient_id=$2 where id = any($1)", [cl.case_ids, ids[0]]);
        await q("update clients set emr_patient_id=$2 where id=$1", [cl.client_id, ids[0]]);
        results.linked++;
        results.cases_linked += cl.case_ids.length;
      } else if (ids.length === 0) {
        results.not_found.push({ client_id: cl.client_id, cases: cl.case_ids.length });
      } else {
        results.ambiguous.push({ client_id: cl.client_id, cases: cl.case_ids.length, matches: ids.length });
      }
    } catch (e) {
      console.error(`link ${cl.client_id}:`, e instanceof Error ? e.message : e);
      results.errors++;
    }
  }
  return {
    clients_checked: clients.length,
    ...results,
    note: "ambiguous/not_found clients need a manual emr_patient_id (or a DOB on the client, then re-run)",
  };
}
