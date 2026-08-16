// Env config for the background jobs. DATABASE_URL connects as the table OWNER,
// which bypasses RLS — the whole-book access these nightly jobs need (the
// Supabase service_role equivalent).
export const config = {
  ownerUrl: process.env.DATABASE_URL ?? "postgresql://postgres@localhost:5432/postgres",
  pgMax: Number(process.env.PG_MAX ?? 5),
  port: Number(process.env.PORT ?? 8080),
  modmed: {
    baseUrl: process.env.MODMED_BASE_URL ?? "",
    apiKey: process.env.MODMED_API_KEY ?? "",
    username: process.env.MODMED_USERNAME ?? "",
    password: process.env.MODMED_PASSWORD ?? "",
    tokenUrl: process.env.MODMED_TOKEN_URL ?? "",
    dryRun: (process.env.MODMED_DRY_RUN ?? "false").toLowerCase() === "true",
  },
  recordsBucket: process.env.RECORDS_BUCKET ?? "miicase-medical-records",
  anthropicKey: process.env.ANTHROPIC_API_KEY ?? "",
  sendgridKey: process.env.SENDGRID_API_KEY ?? "",
  fromEmail: process.env.AUTOPILOT_FROM_EMAIL ?? "billing@miispine.com",
  batchSize: Number(process.env.AUTOPILOT_BATCH_SIZE ?? 50),
  autopilotDryRun: (process.env.AUTOPILOT_DRY_RUN ?? "").toLowerCase() === "true",
};
