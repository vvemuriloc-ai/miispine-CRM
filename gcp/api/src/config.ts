// Runtime config, all from env (12-factor). Nothing secret is hard-coded.
export const config = {
  port: Number(process.env.PORT ?? 8080),
  databaseUrl: process.env.DATABASE_URL ?? "postgresql://miicase_app@localhost:5432/postgres",
  pgMax: Number(process.env.PG_MAX ?? 10),
  // 'firebase' verifies real ID tokens (needs firebase-admin + ADC);
  // 'mock' accepts "mock:<uid>" tokens for local/integration testing only.
  authMode: (process.env.AUTH_MODE ?? "firebase") as "firebase" | "mock",
  profileTtlMs: Number(process.env.PROFILE_TTL_MS ?? 60_000),
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
};
