import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildCurriculumContext, buildSystemPrompt } from "@/lib/ai/system-prompt";
import { resolveAiTeamContext } from "@/lib/ai/team-context";
import { isResendOfUnanswered, replyFailedNotice } from "@/lib/ai/resend";
import { env } from "@/lib/env";
import { checkRateLimit } from "@/lib/rate-limit";
import { loadStudentAssignments } from "@/lib/assignments-server";
import { formatEastern, isDone, statusLabel } from "@/lib/assignments";
import { applyUsage, isOverHardCap } from "@/lib/ai/usage";
import { getAllRoles } from "@/lib/roles";
import { capabilitiesFrom, can, canAccessAdmin } from "@/lib/permissions";
import {
  computePreCohort,
  isAcceptedStatus,
  todayISO,
  type PreCohortCohort,
} from "@/lib/pre-cohort";
import type { Role } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Trim history aggressively. Older context is summarized in the system
// prompt's retrieval block; keeping the last N messages in raw form is
// usually enough for coherent conversation while keeping per-request
// cost predictable.
const HISTORY_WINDOW = 20;

/**
 * Streaming chat endpoint. Body: { conversationId, message }
 * Streams text deltas to the client; on completion, persists both the
 * user message and the full assistant message to ai_messages and
 * accrues token usage against the user's monthly quota.
 */
export async function POST(req: Request) {
  if (!env.anthropicApiKey) {
    return new Response(
      JSON.stringify({
        error: "AI co-founder isn't configured yet. Set ANTHROPIC_API_KEY.",
      }),
      { status: 501, headers: { "Content-Type": "application/json" } },
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return new Response(JSON.stringify({ error: "Not signed in" }), {
      status: 401,
    });
  }

  const body = await req.json().catch(() => ({}));
  const { conversationId, message } = body as {
    conversationId?: string;
    message?: string;
  };

  const admin = createAdminClient();

  // Time-to-first-token is the most-felt latency in the product, so every
  // read the gates and the retrieval context need goes out in one parallel
  // batch — each is keyed only off the signed-in user or the request body,
  // never off another read. The gates are still evaluated in their
  // original order below (403 → 402 → 429 → 400 → 404), so responses are
  // unchanged. History is capped one short of HISTORY_WINDOW because the
  // new user message is appended locally rather than read back after its
  // insert; older context is captured in retrieval-block summaries.
  const [
    { data: profile },
    allRoles,
    overHardCap,
    rl,
    { data: convo },
    { data: history },
    { data: enrollments },
    { data: application },
    { data: memberships, error: membershipError },
    assignments,
  ] = await Promise.all([
    supabase
      .from("profiles")
      .select("role, full_name, ai_context")
      .eq("id", user.id)
      .maybeSingle(),
    getAllRoles(),
    isOverHardCap(user.id),
    checkRateLimit({
      kind: "ai-chat",
      identifier: user.id,
      limit: 60,
      windowSeconds: 60 * 60,
    }),
    conversationId
      ? admin
          .from("ai_conversations")
          .select("id, user_id, title, team_id")
          .eq("id", conversationId)
          .single()
      : Promise.resolve({ data: null }),
    conversationId
      ? admin
          .from("ai_messages")
          .select("role, content, created_at")
          .eq("conversation_id", conversationId)
          .order("created_at", { ascending: false })
          .limit(HISTORY_WINDOW - 1)
      : Promise.resolve({ data: null }),
    admin
      .from("enrollments")
      .select("cohort_id, cohort:cohorts(name, starts_on, status)")
      .eq("user_id", user.id),
    admin
      .from("applications")
      .select(
        "status, cohort_id, startup_idea, why_join, experience, cohort:cohorts(name, starts_on, status)",
      )
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    admin
      .from("team_members")
      .select("team_id")
      .eq("user_id", user.id),
    loadStudentAssignments(admin, user.id),
  ]);

  const role = (profile?.role as Role | undefined) ?? "student";

  // Gate: only accepted+ students (and staff) can use the AI co-founder.
  // Inline equivalent of canUseAi → getStudentAccess → aiAccessFrom
  // (lib/access.ts), evaluated against the rows batched above instead of
  // letting those helpers re-fetch them — keep in lockstep with
  // lib/access.ts.
  const caps = capabilitiesFrom(
    role,
    allRoles.find((r) => r.slug === role)?.permissions ?? [],
  );
  let allowed =
    canAccessAdmin(caps) ||
    can(caps, "mentor.panel") ||
    can(caps, "investor.panel");
  if (!allowed) {
    const applicationStatus = application?.status ?? null;
    const accepted = isAcceptedStatus(applicationStatus);
    const enrolled = (enrollments?.length ?? 0) > 0;
    let preCohort = false;
    if (enrolled || accepted) {
      // Every cohort the student is tied to: all enrollments plus the
      // accepted application's cohort. Supabase embeds to-one relations
      // as object or single-element array.
      const cohorts: PreCohortCohort[] = [];
      for (const e of (enrollments ?? []) as any[]) {
        const c = Array.isArray(e.cohort) ? e.cohort[0] : e.cohort;
        if (e.cohort_id && c) cohorts.push(c);
      }
      if (accepted && application?.cohort_id) {
        const c = Array.isArray((application as any).cohort)
          ? (application as any).cohort[0]
          : (application as any).cohort;
        if (c) cohorts.push(c);
      }
      preCohort = computePreCohort(true, cohorts, todayISO());
    }
    allowed = !preCohort && accepted;
  }
  if (!allowed) {
    return new Response(
      JSON.stringify({
        error:
          "The AI co-founder is locked until your application is accepted.",
      }),
      { status: 403 },
    );
  }

  // Per-user hard cap so a runaway loop can't burn unlimited cost.
  // Students past the monthly hard ceiling are blocked entirely; admins
  // bypass so they can debug.
  if (role !== "admin" && overHardCap) {
    return new Response(
      JSON.stringify({
        error:
          "You've hit the AI usage hard cap for this month. Contact batch0 if you need more.",
      }),
      { status: 402 },
    );
  }

  // Modest per-user rate limit, separate from token quota.
  if (!rl.ok) {
    return new Response(
      JSON.stringify({
        error: "You've hit the hourly chat limit. Try again later.",
      }),
      { status: 429 },
    );
  }

  if (!conversationId || !message?.trim()) {
    return new Response(JSON.stringify({ error: "Missing fields" }), {
      status: 400,
    });
  }
  // Hard ceiling per turn — bigger inputs are usually accidents.
  const trimmedMessage = message.trim().slice(0, 8000);

  // Verify conversation belongs to user.
  if (!convo || convo.user_id !== user.id) {
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
    });
  }

  // What's due, by title and status only — never the student's submitted text.
  const assignmentContext = [
    ...assignments.items.filter((i) => !isDone(i.status)),
    ...assignments.items.filter((i) => isDone(i.status)).reverse(),
  ]
    .slice(0, 6)
    .map((i) => ({
      title: i.assignment.title,
      due: i.assignment.due_at ? formatEastern(i.assignment.due_at) : null,
      status: statusLabel(i.status),
    }));

  // Conversations are self-editable under RLS. A pinned team_id is not an
  // authorization grant, and a former member must not retain team retrieval.
  if (membershipError) {
    return new Response(JSON.stringify({ error: "Couldn't verify team access. Try again shortly." }), { status: 503 });
  }
  const teamId = resolveAiTeamContext(convo.team_id, (memberships ?? []).map((m) => m.team_id));
  if (convo.team_id && !teamId) {
    return new Response(JSON.stringify({ error: "You no longer have access to this conversation's team. Start a new conversation." }), { status: 403 });
  }

  // The cohort whose curriculum feeds the corpus below. Exactly one
  // enrollment pins it; zero or several resolve nothing rather than
  // guessing between cohorts.
  const cohortId =
    enrollments && enrollments.length === 1
      ? ((enrollments[0] as any).cohort_id ?? null)
      : null;

  let teamRetrieval: any = null;
  let curriculumCorpus: string | null = null;

  // The student sending again the question whose reply failed (the notice
  // tells them to): it is already saved, with no reply after it, so it is
  // answered rather than saved a second time (lib/ai/resend.ts).
  const resend = isResendOfUnanswered(history, trimmedMessage);

  await Promise.all([
    // Persist the user's message immediately so it survives even if
    // streaming fails.
    resend
      ? Promise.resolve()
      : admin.from("ai_messages").insert({
          conversation_id: conversationId,
          role: "user",
          content: trimmedMessage,
        }),
    (async () => {
      if (!teamId) return;
      const [{ data: team }, { count }, { data: pitch }] =
        await Promise.all([
          supabase
            .from("teams")
            .select("name, tagline, description")
            .eq("id", teamId)
            .maybeSingle(),
          supabase
            .from("team_members")
            .select("id", { count: "exact", head: true })
            .eq("team_id", teamId),
          supabase
            .from("pitch_submissions")
            .select("submitted_at")
            .eq("team_id", teamId)
            .maybeSingle(),
        ]);
      if (team) {
        teamRetrieval = {
          name: team.name,
          tagline: team.tagline,
          description: team.description,
          member_count: count ?? 1,
          submitted_pitch_at: pitch?.submitted_at ?? null,
        };
        // Pin the conversation to the team so subsequent messages
        // continue routing the same way.
        if (!convo.team_id) {
          await admin
            .from("ai_conversations")
            .update({ team_id: teamId })
            .eq("id", conversationId);
        }
      }
    })(),
    (async () => {
      // Cohort-scoped curriculum corpus, cached separately from the
      // per-student system prompt so it stays warm across every student
      // in the cohort.
      try {
        if (!cohortId) return;
        const { data: mods, error } = await supabase
          .from("modules")
          .select("week, title, summary, lessons:lessons(title, description, position)")
          .eq("cohort_id", cohortId)
          .order("week", { ascending: true });
        if (error) throw error;
        if (mods && mods.length > 0) {
          curriculumCorpus = buildCurriculumContext(mods);
        }
      } catch (err) {
        console.error("[ai-chat] curriculum corpus build failed", err);
      }
    })(),
  ]);

  const systemText = buildSystemPrompt({
    studentName: profile?.full_name ?? null,
    startupContext: profile?.ai_context ?? null,
    retrieval: {
      application: application
        ? {
            status: application.status,
            startup_idea: application.startup_idea,
            why_join: application.why_join,
            experience: application.experience,
          }
        : null,
      team: teamRetrieval,
      assignments: assignmentContext,
    },
  });

  // The history read predates the user-message insert, so the new turn is
  // appended locally — together they form the same HISTORY_WINDOW-message
  // context a post-insert read would produce. A resend's turn is already the
  // newest row of that history, so it isn't appended twice.
  const orderedHistory = (history ?? []).slice().reverse();
  const messages: Anthropic.MessageParam[] = [
    ...orderedHistory
      .filter((m: any) => m.role === "user" || m.role === "assistant")
      .map((m: any) => ({ role: m.role, content: m.content })),
    ...(resend ? [] : [{ role: "user" as const, content: trimmedMessage }]),
  ];

  const client = new Anthropic({ apiKey: env.anthropicApiKey });

  // Stream and accumulate.
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let assembled = "";
      // Set once the assistant message is in ai_messages: a failure after
      // that (quota accrual, the title update) didn't cost the student a reply.
      let saved = false;
      let usage:
        | {
            input_tokens?: number;
            output_tokens?: number;
            cache_creation_input_tokens?: number;
            cache_read_input_tokens?: number;
          }
        | null = null;
      try {
        // Two system blocks so the curriculum corpus (large, stable for
        // a whole cohort) caches independently from the per-student
        // system prompt (smaller, changes per request). Both marked
        // ephemeral; the cache keys diverge because the texts diverge.
        const systemBlocks = curriculumCorpus
          ? [
              {
                type: "text" as const,
                text: curriculumCorpus,
                cache_control: { type: "ephemeral" as const },
              },
              {
                type: "text" as const,
                text: systemText,
                cache_control: { type: "ephemeral" as const },
              },
            ]
          : [
              {
                type: "text" as const,
                text: systemText,
                cache_control: { type: "ephemeral" as const },
              },
            ];
        const response = await client.messages.create({
          model: "claude-sonnet-4-6",
          max_tokens: 2048,
          system: systemBlocks,
          messages,
          stream: true,
        });

        for await (const evt of response) {
          if (
            evt.type === "content_block_delta" &&
            evt.delta.type === "text_delta"
          ) {
            assembled += evt.delta.text;
            controller.enqueue(encoder.encode(evt.delta.text));
          }
          if (evt.type === "message_start") {
            // message_start carries the request-level usage so far.
            usage = (evt as any).message?.usage ?? null;
          }
          if (evt.type === "message_delta") {
            // message_delta supplies the final output_tokens count once
            // the model stops; merge into the running usage object.
            const u = (evt as any).usage ?? null;
            if (u) usage = { ...(usage ?? {}), ...u };
          }
        }

        const input = usage?.input_tokens ?? 0;
        const output = usage?.output_tokens ?? 0;
        const cacheCreation = usage?.cache_creation_input_tokens ?? 0;
        const cacheRead = usage?.cache_read_input_tokens ?? 0;

        // Persist the assistant message + its token cost.
        const { error: saveError } = await admin.from("ai_messages").insert({
          conversation_id: conversationId,
          role: "assistant",
          content: assembled,
          input_tokens: input,
          output_tokens: output,
          cache_creation_tokens: cacheCreation,
          cache_read_tokens: cacheRead,
        });
        if (saveError) console.error("[ai-chat] reply not saved", saveError.message);
        else saved = true;

        // Accrue against the monthly quota; this also issues a fee
        // charge for any overage portion of this request.
        const { chargedCents } = await applyUsage({
          userId: user.id,
          delta: {
            input_tokens: input,
            output_tokens: output,
            cache_creation_tokens: cacheCreation,
            cache_read_tokens: cacheRead,
          },
        });

        // Surface charging as a footer in the stream so the user sees it.
        if (chargedCents > 0) {
          controller.enqueue(
            encoder.encode(
              // Plain text: the chat bubble doesn't render markdown.
              `\n\nNote: this message put you over the free tier. $${(chargedCents / 100).toFixed(2)} added to your account.`,
            ),
          );
        }

        // Auto-title the conversation if it's still untitled.
        if (!convo.title) {
          const title = trimmedMessage.slice(0, 60);
          await admin
            .from("ai_conversations")
            .update({
              title,
              updated_at: new Date().toISOString(),
            })
            .eq("id", conversationId);
        } else {
          await admin
            .from("ai_conversations")
            .update({ updated_at: new Date().toISOString() })
            .eq("id", conversationId);
        }
      } catch (err: any) {
        // A reply that dies mid-stream saves nothing past the user's message:
        // not the partial text, not its tokens (PRODUCTION_READINESS.md, P3
        // #7). This line is the only trace it leaves — it used to leave none
        // on the server at all. The student gets a plain instruction instead
        // of the provider's raw error JSON; what streamed before the failure
        // stays on their screen above it, and sending the question again
        // answers the saved one instead of saving it twice. A failure after
        // the reply was saved (quota accrual, the title) costs them nothing,
        // so it says nothing.
        console.error("[ai-chat] stream failed", {
          conversationId,
          streamedChars: assembled.length,
          saved,
          resend,
          error: err?.message ?? String(err),
        });
        if (!saved) {
          controller.enqueue(encoder.encode(replyFailedNotice(assembled.length)));
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-store",
      "X-Accel-Buffering": "no",
    },
  });
}
