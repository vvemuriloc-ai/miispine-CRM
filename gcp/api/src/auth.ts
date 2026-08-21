// Firebase token verification + profile lookup.
//
// verifyToken() turns a bearer token into a uid — via firebase-admin in prod,
// or a "mock:<uid>" token in AUTH_MODE=mock for tests. loadProfile() then reads
// the user's firm/staff from user_profiles (the DB is the authority, not the
// token's cached claims), briefly cached to spare a lookup on every request.
import { config } from "./config.ts";
import { withTenant } from "./db.ts";

export type Profile = { uid: string; firmId: string | null; isStaff: boolean; role: string };

export async function verifyToken(token: string): Promise<{ uid: string; email: string | null; emailVerified: boolean } | null> {
  if (!token) return null;
  if (config.authMode === "mock") {
    // mock:<uid>[:<email>[:unverified]] — email defaults verified for tests.
    const m = token.match(/^mock:([^:]+)(?::([^:]+))?(?::(unverified))?$/);
    return m ? { uid: m[1], email: m[2] ?? null, emailVerified: !!m[2] && !m[3] } : null;
  }
  try {
    const admin = await getFirebase();
    const decoded = await admin.auth().verifyIdToken(token);
    return { uid: decoded.uid, email: decoded.email ?? null, emailVerified: !!decoded.email_verified };
  } catch (e) {
    // Surface the reason in Cloud Run logs — a silent null here reads as a
    // mystery 401 to the client.
    console.error("verifyToken failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

let _fb: any;
async function getFirebase() {
  if (!_fb) {
    // firebase-admin is CommonJS: under dynamic import() the real export
    // surface lives on .default (the bare namespace has no .apps).
    const mod: any = await import("firebase-admin");
    const admin = mod.default ?? mod;
    if (!admin.apps.length) admin.initializeApp(); // Application Default Credentials on Cloud Run
    _fb = admin;
  }
  return _fb;
}

const cache = new Map<string, { p: Profile | null; exp: number }>();

export async function loadProfile(uid: string): Promise<Profile | null> {
  const now = Date.now();
  const hit = cache.get(uid);
  if (hit && hit.exp > now) return hit.p;

  // Read the caller's own row: set app.user_id first so the profile_self RLS
  // policy (user_id = current_user_id()) returns it.
  const p = await withTenant({ uid, firmId: null, isStaff: false }, async (c) => {
    const r = await c.query(
      "select user_id, firm_id, is_staff, role from user_profiles where user_id = $1",
      [uid],
    );
    if (!r.rows.length) return null;
    const row = r.rows[0];
    return { uid: row.user_id, firmId: row.firm_id, isStaff: row.is_staff, role: row.role } as Profile;
  });

  cache.set(uid, { p, exp: now + config.profileTtlMs });
  return p;
}

export function clearProfileCache() { cache.clear(); }

// First-login invite claim: a verified token email matching a pending invite
// creates the profile (claim_invite is SECURITY DEFINER; RLS doesn't block
// the first-time user). Returns the new profile or null.
export async function claimInvite(uid: string, email: string): Promise<Profile | null> {
  const p = await withTenant({ uid, firmId: null, isStaff: false }, async (c) => {
    const r = await c.query("select * from claim_invite($1, $2)", [uid, email]);
    if (!r.rows.length) return null;
    const row = r.rows[0];
    return { uid: row.user_id, firmId: row.firm_id, isStaff: row.is_staff, role: row.role } as Profile;
  });
  if (p) cache.set(uid, { p, exp: Date.now() + config.profileTtlMs });
  return p;
}
