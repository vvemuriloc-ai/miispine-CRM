// autopilot job (Cloud Run) — nightly attorney outreach. Ports the Supabase edge
// function to pg (owner). Scores come from the autopilot_queue view; Claude
// drafts the email; SendGrid sends; outreach is logged and the next follow-up
// scheduled. The draft + send functions are injectable for testing.
import { q } from "../lib/db.ts";
import { config } from "../lib/config.ts";

type Draft = { subject: string; body: string };
type DraftFn = (prompt: string) => Promise<Draft>;
type SendFn = (to: string, subject: string, body: string) => Promise<boolean>;

function extractJson(text: string): Draft {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  try { return JSON.parse(cleaned); }
  catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`no JSON in model response: ${text.slice(0, 160)}`);
    return JSON.parse(m[0]);
  }
}

async function anthropicDraft(prompt: string): Promise<Draft> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: config.anthropicKey });
  const res: any = await client.messages.create({
    model: "claude-sonnet-5", max_tokens: 600,
    thinking: { type: "disabled" }, output_config: { effort: "low" },
    messages: [{ role: "user", content: prompt }],
  } as any);
  const block = (res.content as any[]).find((b) => b.type === "text");
  if (!block) throw new Error("model returned no text");
  return extractJson(block.text);
}

async function sendgridSend(to: string, subject: string, body: string): Promise<boolean> {
  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.sendgridKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: config.fromEmail, name: "miiSpine Billing" },
      subject, content: [{ type: "text/plain", value: body }],
    }),
  });
  if (!res.ok) { console.error(`SendGrid ${res.status}`); return false; }
  return true;
}

async function caseContext(caseId: string) {
  const head = await q(
    `select c.*, cl.first_name, cl.last_name, a.name as attorney_name, a.avg_response_days, f.name as firm_name
       from cases c join clients cl on cl.id = c.client_id
       left join attorneys a on a.id = c.attorney_id
       join firms f on f.id = c.firm_id where c.id = $1`, [caseId]);
  if (!head.rows.length) return null;
  const bills = (await q("select lien_amount, collected_amount from medical_bills where case_id = $1", [caseId])).rows;
  const pip = (await q("select status, balance_remaining from pip_ledger where case_id = $1", [caseId])).rows[0] ?? null;
  const milestone = (await q("select milestone_type, actual_date from milestones where case_id = $1 order by actual_date desc nulls last limit 1", [caseId])).rows[0] ?? null;
  const last = (await q("select sent_at, outcome from outreach_log where case_id = $1 order by sent_at desc nulls last limit 1", [caseId])).rows[0] ?? null;
  return { c: head.rows[0], bills, pip, milestone, last };
}

function buildPrompt(ctx: NonNullable<Awaited<ReturnType<typeof caseContext>>>): string {
  const { c, bills, pip, milestone, last } = ctx;
  const outstanding = bills.reduce((s: number, b: any) => s + (Number(b.lien_amount) || 0) - (Number(b.collected_amount) || 0), 0);
  const daysSince = last?.sent_at ? Math.floor((Date.now() - new Date(last.sent_at).getTime()) / 86_400_000) : null;
  return `You are a professional medical billing coordinator for miiSpine, a spine surgery practice in Louisville, KY.

Draft a concise, professional follow-up email to an attorney about a personal injury case.

CASE DETAILS:
- Patient: ${c.first_name ?? "Unknown"} ${(c.last_name ?? "").charAt(0)}.
- Attorney: ${c.attorney_name ?? "Counsel"} at ${c.firm_name ?? "the firm"}
- Case status: ${c.status ?? "unknown"}
- miiSpine lien outstanding: $${outstanding.toLocaleString()}
- PIP status: ${pip?.status ?? "unknown"}, remaining: $${pip?.balance_remaining?.toLocaleString?.() ?? "unknown"}
- Last milestone: ${milestone?.milestone_type ?? "none recorded"} on ${milestone?.actual_date ?? "unknown"}
- Days since last outreach: ${daysSince ?? "first contact"}
- Last outreach outcome: ${last?.outcome ?? "no prior contact"}

TONE: Professional, direct, courteous. NOT aggressive. We want updates and payment but we value the relationship.
LENGTH: 3-4 sentences max. Attorneys are busy.
GOAL: Get a case status update and/or a payment commitment.

Return ONLY a JSON object, no prose and no code fences: {"subject": "...", "body": "..."}`;
}

async function logAndSchedule(ctx: NonNullable<Awaited<ReturnType<typeof caseContext>>>, draft: Draft, sent: boolean) {
  const cadence = Math.min(21, Math.max(5, Math.round(ctx.c.avg_response_days ?? 7)));
  const next = new Date(); next.setDate(next.getDate() + cadence);
  const nowIso = new Date().toISOString();
  await q(
    `insert into outreach_log (case_id, firm_id, attorney_id, channel, direction, subject, body, ai_generated, sent_by, sent_at, outcome)
     values ($1,$2,$3,'email','outbound',$4,$5,true,'autopilot',$6,'no_response')`,
    [ctx.c.id, ctx.c.firm_id, ctx.c.attorney_id, draft.subject, draft.body, sent ? nowIso : null]);
  await q("update cases set last_outreach_at=$2, next_followup_at=$3 where id=$1", [ctx.c.id, nowIso, next.toISOString()]);
}

export async function run(deps: { draftImpl?: DraftFn; sendImpl?: SendFn } = {}) {
  const draftImpl = deps.draftImpl ?? anthropicDraft;
  const sendImpl = deps.sendImpl ?? sendgridSend;
  const dryRun = config.autopilotDryRun || !config.sendgridKey;

  const queue = (await q("select * from autopilot_queue limit $1", [config.batchSize])).rows;
  const results = { processed: 0, sent: 0, drafted: 0, errors: 0, dry_run: dryRun };
  for (const item of queue) {
    try {
      const ctx = await caseContext(item.id);
      if (!ctx) { results.errors++; continue; }
      const draft = await draftImpl(buildPrompt(ctx));
      results.drafted++;
      let sent = false;
      if (item.attorney_email && !dryRun) { sent = await sendImpl(item.attorney_email, draft.subject, draft.body); if (sent) results.sent++; }
      await logAndSchedule(ctx, draft, sent);
      results.processed++;
    } catch (e) {
      console.error(`case ${item.id}:`, e);
      results.errors++;
    }
  }
  return results;
}
