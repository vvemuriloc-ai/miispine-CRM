// ModMed FHIR client: OAuth token + paged GET. Read-only; the fetch function is
// injectable so the jobs can be integration-tested without hitting ModMed.
import { config } from "./config.ts";

export type FetchLike = typeof fetch;

export async function modmedToken(fetchImpl: FetchLike = fetch): Promise<string> {
  const tokenUrl = config.modmed.tokenUrl ||
    config.modmed.baseUrl.replace(/\/ema\/fhir\/v2\/?$/, "/ema/ws/oauth2/grant");
  const res = await fetchImpl(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "x-api-key": config.modmed.apiKey },
    body: new URLSearchParams({
      grant_type: "password", username: config.modmed.username, password: config.modmed.password,
    }),
  });
  if (!res.ok) throw new Error(`token ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  if (!j.access_token) throw new Error("token response had no access_token");
  return j.access_token as string;
}

export function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, "x-api-key": config.modmed.apiKey };
}

// Follow Bundle paging; bundleResources/nextLink come from the job's fhir.js.
export async function fhirGetAll(
  token: string, path: string,
  bundleResources: (b: any) => any[], nextLink: (b: any) => string | null,
  fetchImpl: FetchLike = fetch, pageCap = 50,
): Promise<any[]> {
  let url: string | null = path.startsWith("http") ? path : `${config.modmed.baseUrl}${path}`;
  const out: any[] = [];
  for (let p = 0; url && p < pageCap; p++) {
    const res: Response = await fetchImpl(url, {
      headers: { ...authHeaders(token), Accept: "application/fhir+json" },
    });
    if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
    const b = await res.json();
    out.push(...bundleResources(b));
    url = nextLink(b);
  }
  return out;
}
