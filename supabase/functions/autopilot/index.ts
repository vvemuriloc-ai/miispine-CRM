// ============================================================
// miiCase Autopilot — Supabase Edge Function
// Runs nightly (pg_cron). Scores cases via the autopilot_queue view,
// drafts attorney outreach with Claude, sends email via SendGrid, logs
// the outreach and schedules the next follow-up.
// ============================================================
//
// Changes from the original draft:
//   * Model updated to a current, supported id (`claude-sonnet-5`) — the old
//     `claude-sonnet-4-6` string still resolves, but Sonnet 5 is the current
//     Sonnet tier and the right cost/quality point for a nightly bulk job.
//     Thinking is disabled and effort is `low` to keep 50 short drafts fast.
//   * Fixed the send gate: it previously checked `item.status !== "hold"`, but
//     `status` is the case lifecycle status (active, negotiating, …) and is
//     never "hold" — "hold" is a `followup_priority`, already filtered out by
//     the view. The gate now keys on having an attorney email + DRY_RUN.
//   * Robust JSON extraction from the model response, env-var validation, a
//     DRY_RUN mode, and next_followup_at that adapts to attorney response speed.
//
// Env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (auto-provided by Supabase)
//   ANTHROPIC_API_KEY
//   SENDGRID_API_KEY        (optional; without it, runs in dry-run)
//   AUTOPILOT_DRY_RUN       ("true" to draft + log but not send)
//   AUTOPILOT_FROM_EMAIL    (default billing@miispine.com)
//   AUTOPILOT_BATCH_SIZE    (default 50)
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.68.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const SENDGRID_API_KEY = Deno.env.get("SENDGRID_API_KEY");
const FROM_EMAIL = Deno.env.get("AUTOPILOT_FROM_EMAIL") ?? "billing@miispine.com";
const BATCH_SIZE = Number(Deno.env.get("AUTOPILOT_BATCH_SIZE") ?? "50");
// Dry-run if explicitly requested OR if no SendGrid key is configured.
const DRY_RUN =
  (Deno.env.get("AUTOPILOT_DRY_RUN") ?? "").toLowerCase() === "true" ||
  !SENDGRID_API_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
}
if (!ANTHROPIC_API_KEY) {
  throw new Error("ANTHROPIC_API_KEY is required");
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

interface QueueItem {
  id: string;
  status: string;
  followup_priority: string;
  balance_outstanding: number | null;
  attorney_email: string | null;
  attorney_name: string | null;
  patient_name: string | null;
  days_since_outreach: number | null;
  priority_score: number;
}

interface Draft {
  subject: string;
  body: string;
}

// ── 1. Pull today's follow-up queue ──────────────────────────
async function getQueue(): Promise<QueueItem[]> {
  const { data, error } = await supabase
    .from("autopilot_queue")
    .select("*")
    .limit(BATCH_SIZE); // already ordered by priority_score desc in the view
  if (error) throw error;
  return (data ?? []) as QueueItem[];
}

// ── 2. Pull case context for drafting ────────────────────────
async function getCaseContext(caseId: string) {
  const [caseRow, bills, pip, milestones, lastOutreach] = await Promise.all([
    supabase
      .from("cases")
      .select("*, clients(*), attorneys(*), firms(*)")
      .eq("id", caseId)
      .single(),
    supabase.from("medical_bills").select("*").eq("case_id", caseId),
    supabase.from("pip_ledger").select("*").eq("case_id", caseId).maybeSingle(),
    supabase
      .from("milestones")
      .select("*")
      .eq("case_id", caseId)
      .order("actual_date", { ascending: false, nullsFirst: false })
      .limit(3),
    supabase
      .from("outreach_log")
      .select("*")
      .eq("case_id", caseId)
      .order("sent_at", { ascending: false, nullsFirst: false })
      .limit(1),
  ]);

  return {
    caseRow: caseRow.data,
    bills: bills.data ?? [],
    pip: pip.data,
    milestones: milestones.data ?? [],
    lastOutreach: lastOutreach.data?.[0] ?? null,
  };
}

// Extract the first JSON object from a model response, tolerating code fences
// and any surrounding prose.
function extractJson(text: string): Draft {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`No JSON object in model response: ${text.slice(0, 200)}`);
    return JSON.parse(match[0]);
  }
}

// ── 3. Draft follow-up email via Claude ──────────────────────
async function draftFollowUp(ctx: Awaited<ReturnType<typeof getCaseContext>>): Promise<Draft> {
  const { caseRow: c, bills, pip, milestones, lastOutreach } = ctx;

  const totalLien = bills.reduce((s: number, b: any) => s + (b.lien_amount || 0), 0);
  const totalCollected = bills.reduce((s: number, b: any) => s + (b.collected_amount || 0), 0);
  const outstanding = totalLien - totalCollected;
  const daysSinceLast = lastOutreach?.sent_at
    ? Math.floor((Date.now() - new Date(lastOutreach.sent_at).getTime()) / 86_400_000)
    : null;

  const patientInitial = c?.clients?.last_name?.charAt(0) ?? "";

  const prompt = `You are a professional medical billing coordinator for miiSpine, a spine surgery practice in Louisville, KY.

Draft a concise, professional follow-up email to an attorney about a personal injury case.

CASE DETAILS:
- Patient: ${c?.clients?.first_name ?? "Unknown"} ${patientInitial}.
- Attorney: ${c?.attorneys?.name ?? "Counsel"} at ${c?.firms?.name ?? "the firm"}
- Case status: ${c?.status ?? "unknown"}
- miiSpine lien outstanding: $${outstanding.toLocaleString()}
- PIP status: ${pip?.status ?? "unknown"}, remaining: $${pip?.balance_remaining?.toLocaleString() ?? "unknown"}
- Last milestone: ${milestones?.[0]?.milestone_type ?? "none recorded"} on ${milestones?.[0]?.actual_date ?? "unknown"}
- Days since last outreach: ${daysSinceLast ?? "first contact"}
- Last outreach outcome: ${lastOutreach?.outcome ?? "no prior contact"}

TONE: Professional, direct, courteous. NOT aggressive. We want updates and payment but we value the relationship.
LENGTH: 3-4 sentences max. Attorneys are busy.
GOAL: Get a case status update and/or a payment commitment.

Return ONLY a JSON object, no prose and no code fences: {"subject": "...", "body": "..."}`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 600,
    thinking: { type: "disabled" },
    output_config: { effort: "low" },
    messages: [{ role: "user", content: prompt }],
  } as any);

  const textBlock = (response.content as any[]).find((b) => b.type === "text");
  if (!textBlock) throw new Error("Model returned no text block");
  return extractJson(textBlock.text);
}

// ── 4. Send email via SendGrid ───────────────────────────────
async function sendEmail(to: string, subject: string, body: string): Promise<boolean> {
  if (DRY_RUN) return false;
  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SENDGRID_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: FROM_EMAIL, name: "miiSpine Billing" },
      subject,
      content: [{ type: "text/plain", value: body }],
    }),
  });
  if (!res.ok) {
    console.error(`SendGrid ${res.status}: ${await res.text()}`);
    return false;
  }
  return true;
}

// ── 5. Log outreach and schedule the next follow-up ──────────
async function logAndSchedule(
  caseId: string,
  firmId: string,
  attorneyId: string | null,
  avgResponseDays: number | null,
  draft: Draft,
  sent: boolean,
) {
  // Space the next touch to roughly the attorney's average response window,
  // clamped to a sane 5–21 day band; default 7 when unknown.
  const cadence = Math.min(21, Math.max(5, Math.round(avgResponseDays ?? 7)));
  const nextFollowup = new Date();
  nextFollowup.setDate(nextFollowup.getDate() + cadence);
  const nowIso = new Date().toISOString();

  const [logResult, caseResult] = await Promise.all([
    supabase.from("outreach_log").insert({
      case_id: caseId,
      firm_id: firmId,
      attorney_id: attorneyId,
      channel: "email",
      direction: "outbound",
      subject: draft.subject,
      body: draft.body,
      ai_generated: true,
      sent_by: "autopilot",
      sent_at: sent ? nowIso : null,
      outcome: "no_response", // updated when the attorney responds
    }),
    supabase
      .from("cases")
      .update({ last_outreach_at: nowIso, next_followup_at: nextFollowup.toISOString() })
      .eq("id", caseId),
  ]);

  if (logResult.error) console.error(`log error (${caseId}):`, logResult.error.message);
  if (caseResult.error) console.error(`schedule error (${caseId}):`, caseResult.error.message);
}

// ── 6. Main handler ──────────────────────────────────────────
Deno.serve(async () => {
  try {
    const queue = await getQueue();
    const results = { processed: 0, sent: 0, drafted: 0, errors: 0, dry_run: DRY_RUN };

    for (const item of queue) {
      try {
        const ctx = await getCaseContext(item.id);
        if (!ctx.caseRow) {
          results.errors++;
          continue;
        }

        const draft = await draftFollowUp(ctx);
        results.drafted++;

        // Send only when we have an attorney email. "hold" cases are already
        // excluded by the autopilot_queue view.
        let sent = false;
        if (item.attorney_email) {
          sent = await sendEmail(item.attorney_email, draft.subject, draft.body);
          if (sent) results.sent++;
        }

        await logAndSchedule(
          item.id,
          ctx.caseRow.firm_id,
          ctx.caseRow.attorney_id,
          ctx.caseRow.attorneys?.avg_response_days ?? null,
          draft,
          sent,
        );
        results.processed++;
      } catch (err) {
        console.error(`Case ${item.id} error:`, err);
        results.errors++;
      }
    }

    return new Response(JSON.stringify(results), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("autopilot fatal:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
