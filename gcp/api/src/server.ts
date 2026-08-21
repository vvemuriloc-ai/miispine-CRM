// miiCase API — native-http server (no framework), so the Cloud Run image is
// just `node` + pg. Flow per authed request:
//   Bearer token → verifyToken → loadProfile → withTenant(app.*) → handler → JSON
import http from "node:http";
import { config } from "./config.ts";
import { verifyToken, loadProfile, claimInvite } from "./auth.ts";
import { withTenant } from "./db.ts";
import { routes, HttpError, type Route, type Ctx } from "./routes.ts";

type Compiled = Route & { re: RegExp; keys: string[] };
const compiled: Compiled[] = routes.map((r) => {
  const keys: string[] = [];
  const re = new RegExp("^" + r.path.replace(/:([A-Za-z0-9_]+)/g, (_m, k) => { keys.push(k); return "([^/]+)"; }) + "$");
  return { ...r, re, keys };
});

// CORS_ORIGIN may be "*" or a comma-separated allowlist (custom domain +
// .web.app fallback). With a list, the matching request origin is echoed
// back; a non-listed origin gets no CORS header, so the browser blocks it.
const corsAllowed = config.corsOrigin.split(",").map((s) => s.trim()).filter(Boolean);
function cors(req: http.IncomingMessage, res: http.ServerResponse) {
  const origin = String(req.headers.origin ?? "");
  const value = corsAllowed.includes("*") ? "*" : corsAllowed.includes(origin) ? origin : null;
  if (value) res.setHeader("Access-Control-Allow-Origin", value);
  if (value !== "*") res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
}
function send(req: http.IncomingMessage, res: http.ServerResponse, status: number, body: unknown) {
  cors(req, res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const ch of req) chunks.push(ch as Buffer);
  if (!chunks.length) return undefined;
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new HttpError(400, "invalid JSON body"); }
}

export function buildServer() {
  return http.createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") { cors(req, res); res.writeHead(204); return res.end(); }
      const url = new URL(req.url ?? "/", "http://localhost");

      if (req.method === "GET" && url.pathname === "/api/health") return send(req, res, 200, { ok: true });

      const match = compiled.find((r) => r.method === req.method && r.re.test(url.pathname));
      if (!match) return send(req, res, 404, { error: "not found" });

      const m = match.re.exec(url.pathname)!;
      const params: Record<string, string> = {};
      match.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      const body = (req.method === "POST" || req.method === "PATCH") ? await readBody(req) : undefined;

      // --- auth + tenant ---
      const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      const tok = await verifyToken(bearer);
      if (!tok) return send(req, res, 401, { error: "unauthenticated" });
      let profile = await loadProfile(tok.uid);
      // First sign-in with a pending invite: claim it (verified email only).
      if (!profile && tok.email && tok.emailVerified) profile = await claimInvite(tok.uid, tok.email);
      if (!profile) {
        return send(req, res, 403, { error: tok.email && !tok.emailVerified
          ? "email not verified — click the verification link we emailed, then sign in again"
          : "no profile — ask miiSpine staff to invite this email" });
      }

      const ctx: Ctx = { params, query: url.searchParams, body, profile };
      const tenant = { uid: profile.uid, firmId: profile.firmId, isStaff: profile.isStaff };
      const result = await withTenant(tenant, (client) => match.h(ctx, client));
      return send(req, res, 200, result);
    } catch (e) {
      if (e instanceof HttpError) return send(req, res, e.status, { error: e.message });
      console.error("unhandled", e);
      return send(req, res, 500, { error: "internal error" });
    }
  });
}

// Auto-listen only when run directly (not when imported by the test).
if (import.meta.url === `file://${process.argv[1]}`) {
  buildServer().listen(config.port, () => console.log(`miicase-api on :${config.port} (auth=${config.authMode})`));
}
