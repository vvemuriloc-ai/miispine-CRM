// Route table. Authed handlers receive (ctx, client) already inside a
// withTenant() transaction; RLS does the scoping. The server (server.ts) does
// auth + tenant setup and dispatch.
import type pg from "pg";
import type { Profile } from "./auth.ts";
import * as q from "./sql.ts";

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
];
