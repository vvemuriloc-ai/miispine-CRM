// One Cloud Run service exposing the three jobs. Cloud Scheduler POSTs to
// /jobs/<name> on a nightly cron (see gcp/infra). Each firing runs one job and
// returns its result JSON. Protected in prod by Cloud Run IAM (scheduler's
// service account is the only invoker) — no app auth needed here.
import http from "node:http";
import { config } from "./lib/config.ts";
import { run as modmedSync } from "./modmed-sync/index.ts";
import { run as modmedRecords } from "./modmed-records/index.ts";
import { run as modmedLink } from "./modmed-link/index.ts";
import { run as autopilot } from "./autopilot/index.ts";

const jobs: Record<string, () => Promise<unknown>> = {
  "modmed-sync": () => modmedSync(),
  "modmed-records": () => modmedRecords(),
  "modmed-link": () => modmedLink(),   // manual: link cases ↔ ModMed patients
  "autopilot": () => autopilot(),
};

export function buildServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (s: number, b: unknown) => {
      res.writeHead(s, { "Content-Type": "application/json" });
      res.end(JSON.stringify(b));
    };
    if (url.pathname === "/health") return send(200, { ok: true });
    const m = url.pathname.match(/^\/jobs\/([a-z-]+)$/);
    if (req.method === "POST" && m && jobs[m[1]]) {
      try { return send(200, await jobs[m[1]]()); }
      catch (e) { return send(500, { error: e instanceof Error ? e.message : String(e) }); }
    }
    return send(404, { error: "not found" });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildServer().listen(config.port, () => console.log(`miicase-jobs on :${config.port}`));
}
