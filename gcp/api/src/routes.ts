// Route table. Authed handlers receive (ctx, client) already inside a
// withTenant() transaction; RLS does the scoping. The server (server.ts) does
// auth + tenant setup and dispatch.
import type pg from "pg";
import type { Profile } from "./auth.ts";
import * as q from "./sql.ts";
import { signDownloadUrl } from "./storage.ts";
import { config } from "./config.ts";

export type Ctx = {
  params: Record<string, string>;
  query: URLSearchParams;
  body: any;
  profile: Profile;
};
export class HttpError extends Error {
  status: number;
  constructor(status: number, msg: string) { super(msg); this.status = status; }
}
type AuthedHandler = (ctx: Ctx, c: pg.PoolClient) => Promise<unknown>;

export type Route = { method: string; path: string; auth: boolean; h: AuthedHandler };

export const routes: Route[] = [
  { method: "GET", path: "/api/me", auth: true, h: async (ctx) => ctx.profile },

  // One-shot bundle for the dashboard's initial load.
  { method: "GET", path: "/api/dashboard", auth: true, h: async (ctx, client) => ({ me: ctx.profile, ...(await q.getDashboard(client)) }) },

  { method: "GET", path: "/api/cases", auth: true, h: (_c, client) => q.listCases(client) },
  { method: "GET", path: "/api/cases/:id", auth: true, h: async (ctx, client) => {
      const row = await q.getCase(client, ctx.params.id);
      if (!row) throw new HttpError(404, "case not found");
      return row;
    } },

  { method: "GET", path: "/api/ar-aging",        auth: true, h: (_c, client) => q.listView("ar_aging")(client) },
  { method: "GET", path: "/api/autopilot-queue", auth: true, h: (_c, client) => q.listView("autopilot_queue")(client) },
  { method: "GET", path: "/api/invoices",        auth: true, h: (_c, client) => q.listView("invoices_view")(client) },
  { method: "GET", path: "/api/review-queue",    auth: true, h: (_c, client) => q.listView("review_queue")(client) },

  { method: "POST", path: "/api/records", auth: true, h: async (ctx, client) => {
      const b = ctx.body ?? {};
      if (!b.case_id || !b.firm_id || !b.record_type) throw new HttpError(400, "case_id, firm_id, record_type required");
      return q.createRecord(client, b);
    } },

  { method: "PATCH", path: "/api/bills/:id", auth: true, h: async (ctx, client) => {
      const row = await q.updateBill(client, ctx.params.id, ctx.body ?? {});
      if (!row) throw new HttpError(404, "bill not found or not permitted");
      return row;
    } },

  // Invoices — staff issue, record payments, void (RLS is staff-only too;
  // the route check just turns an RLS violation into a clean 403).
  { method: "POST", path: "/api/invoices", auth: true, h: async (ctx, client) => {
      if (!ctx.profile.isStaff) throw new HttpError(403, "staff only");
      const b = ctx.body ?? {};
      if (!b.case_id || !b.firm_id || !(b.amount > 0)) throw new HttpError(400, "case_id, firm_id, amount required");
      const dueDays = Number(b.due_days ?? 30);
      const due = new Date(Date.now() + dueDays * 86_400_000).toISOString().slice(0, 10);
      return q.createInvoice(client, { ...b, due_date: due });
    } },
  { method: "POST", path: "/api/invoices/:id/payments", auth: true, h: async (ctx, client) => {
      if (!ctx.profile.isStaff) throw new HttpError(403, "staff only");
      const b = ctx.body ?? {};
      if (!(b.amount > 0)) throw new HttpError(400, "amount required");
      const row = await q.addInvoicePayment(client, ctx.params.id, b);
      if (!row) throw new HttpError(404, "invoice not found");
      return row;
    } },
  { method: "PATCH", path: "/api/invoices/:id", auth: true, h: async (ctx, client) => {
      if (!ctx.profile.isStaff) throw new HttpError(403, "staff only");
      if ((ctx.body ?? {}).status !== "void") throw new HttpError(400, "only status:'void' is supported");
      const row = await q.voidInvoice(client, ctx.params.id);
      if (!row) throw new HttpError(404, "invoice not found");
      return row;
    } },

  // Update a case: status, review state, and editable fields (firm-or-staff).
  { method: "PATCH", path: "/api/cases/:id", auth: true, h: async (ctx, client) => {
      const row = await q.updateCase(client, ctx.params.id, ctx.body ?? {});
      if (!row) throw new HttpError(404, "case not found or not permitted");
      return row;
    } },

  // New case (staff): resolves/creates the firm (deduped) and client, opens the
  // case + PIP ledger, and books the initial charges as a bill.
  { method: "POST", path: "/api/cases", auth: true, h: async (ctx, client) => {
      if (!ctx.profile.isStaff) throw new HttpError(403, "staff only");
      const b = ctx.body ?? {};
      if (!b.last_name || !b.firm_name) throw new HttpError(400, "last_name and firm_name required");
      return q.createCase(client, b);
    } },

  // ---- Invites: staff onboard staff/attorneys by email ----
  { method: "GET", path: "/api/invites", auth: true, h: async (ctx, client) => {
      if (!ctx.profile.isStaff) throw new HttpError(403, "staff only");
      return q.listInvites(client);
    } },
  { method: "POST", path: "/api/invites", auth: true, h: async (ctx, client) => {
      if (!ctx.profile.isStaff) throw new HttpError(403, "staff only");
      try { return await q.createInvite(client, ctx.body ?? {}, ctx.profile.uid); }
      catch (e: any) {
        if (String(e?.message).includes("uq_user_invites_pending")) throw new HttpError(409, "a pending invite already exists for this email");
        throw new HttpError(400, e?.message ?? "invalid invite");
      }
    } },
  { method: "DELETE", path: "/api/invites/:id", auth: true, h: async (ctx, client) => {
      if (!ctx.profile.isStaff) throw new HttpError(403, "staff only");
      const row = await q.deleteInvite(client, ctx.params.id);
      if (!row) throw new HttpError(404, "invite not found (or already claimed)");
      return { deleted: row.id };
    } },

  // Staff rename/reclassify a record (fixing ModMed's unlabeled documents);
  // the edit is sticky across syncs and drives firm visibility + grouping.
  { method: "PATCH", path: "/api/records/:id", auth: true, h: async (ctx, client) => {
      if (!ctx.profile.isStaff) throw new HttpError(403, "staff only");
      const row = await q.updateRecord(client, ctx.params.id, ctx.body ?? {});
      if (!row) throw new HttpError(404, "record not found");
      return row;
    } },

  // Staff mark a client's signed HIPAA release received (or revoked) — the
  // gate on every record download below.
  { method: "PATCH", path: "/api/cases/:id/hipaa", auth: true, h: async (ctx, client) => {
      if (!ctx.profile.isStaff) throw new HttpError(403, "staff only");
      const row = await q.setClientHipaa(client, ctx.params.id, !!ctx.body?.on_file);
      if (!row) throw new HttpError(404, "case not found");
      return row;
    } },

  // The ONLY path to a record file: firm ownership (RLS) + HIPAA release +
  // audit, then a short-lived GCS signed URL. Mirrors the Supabase edge fn.
  { method: "POST", path: "/api/records/:id/download", auth: true, h: async (ctx, client) => {
      const rec = await q.recordForDownload(client, ctx.params.id);
      if (!rec) throw new HttpError(404, "not found or not authorized");
      if (!rec.hipaa_release_on_file) throw new HttpError(403, "HIPAA release not on file for this client");
      if (!rec.storage_key) throw new HttpError(409, "record has no file yet");
      await q.writeAudit(client, { user_id: ctx.profile.uid, firm_id: rec.firm_id, resource_id: rec.id });
      // {inline:true} → preview in a browser tab. Most EMR documents are PDFs;
      // when the stored type is unknown (".bin"), preview as PDF so the
      // browser renders instead of re-downloading.
      const inline = !!ctx.body?.inline;
      const ext = String(rec.filename ?? "").split(".").pop()?.toLowerCase();
      const viewType = ({ pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", tif: "image/tiff", txt: "text/plain", html: "text/html", xml: "text/xml" } as Record<string, string>)[ext ?? ""] ?? "application/pdf";
      const url = await signDownloadUrl(rec.storage_key, config.signedUrlTtlSec, { inline, contentType: inline ? viewType : null });
      return { url, expires_in: config.signedUrlTtlSec };
    } },
];
