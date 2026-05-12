import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildSystemPrompt } from "@/lib/ai/system-prompt";
import { env } from "@/lib/env";
import { checkRateLimit } from "@/lib/rate-limit";
import { canUseAi } from "@/lib/access";
import { applyUsage, isOverHardCap } from "@/lib/ai/usage";
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

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return new Response(JSON.stringify({ error: "Not signed in" }), {
      status: 401,
    });
  }

  // Gate: only accepted+ students (and staff) can use the AI co-founder.
  const { data: profileRow } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  const role = (profileRow?.role as Role | undefined) ?? "student";
  const allowed = await canUseAi(role);
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
  if (role !== "admin" && (await isOverHardCap(user.id))) {
    return new Response(
      JSON.stringify({
        error:
          "You've hit the AI usage hard cap for this month. Contact SparkLine if you need more.",
      }),
      { status: 402 },
    );
  }

  // Modest per-user rate limit, separate from token quota.
  const rl = await checkRateLimit({
    kind: "ai-chat",
    identifier: user.id,
    limit: 60,
    windowSeconds: 60 * 60,
  });
  if (!rl.ok) {
    return new Response(
      JSON.stringify({
        error: "You've hit the hourly chat limit. Try again later.",
      }),
      { status: 429 },
    );
  }

  const body = await req.json().catch(() => ({}));
  const { conversationId, message } = body as {
    conversationId?: string;
    message?: string;
  };
  if (!conversationId || !message?.trim()) {
    return new Response(JSON.stringify({ error: "Missing fields" }), {
      status: 400,
    });
  }
  // Hard ceiling per turn — bigger inputs are usually accidents.
  const trimmedMessage = message.trim().slice(0, 8000);

  const admin = createAdminClient();

  // Verify conversation belongs to user.
  const { data: convo } = await admin
    .from("ai_conversations")
    .select("id, user_id, title, team_id")
    .eq("id", conversationId)
    .single();
  if (!convo || convo.user_id !== user.id) {
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
    });
  }

  // Persist the user's message immediately so it survives even if streaming fails.
  await admin.from("ai_messages").insert({
    conversation_id: conversationId,
    role: "user",
    content: trimmedMessage,
  });

  // Pull profile + recent history + live retrieval context. We deliberately
  // cap history to HISTORY_WINDOW to keep cost predictable; older context
  // is captured in retrieval-block summaries.
  const [
    { data: profile },
    { data: history },
    { data: application },
    { data: membership },
    { data: latestCheckin },
  ] = await Promise.all([
    admin
      .from("profiles")
      .select("full_name, ai_context")
      .eq("id", user.id)
      .single(),
    admin
      .from("ai_messages")
      .select("role, content, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(HISTORY_WINDOW),
    admin
      .from("applications")
      .select("status, startup_idea, why_join, experience")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    admin
      .from("team_members")
      .select("team_id")
      .eq("user_id", user.id)
      .limit(1)
      .maybeSingle(),
    admin
      .from("student_checkins")
      .select("week_start, accomplished, next_up, blockers")
      .eq("user_id", user.id)
      .order("week_start", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  // Resolve the team context: a conversation may be pinned to a team via
  // team_id, otherwise we fall back to the user's current membership.
  const teamId = convo.team_id ?? membership?.team_id ?? null;

  let teamRetrieval: any = null;
  if (teamId) {
    const { data: team } = await admin
      .from("teams")
      .select("name, tagline, description")
      .eq("id", teamId)
      .maybeSingle();
    const { count } = await admin
      .from("team_members")
      .select("id", { count: "exact", head: true })
      .eq("team_id", teamId);
    const { data: pitch } = await admin
      .from("pitch_submissions")
      .select("submitted_at")
      .eq("team_id", teamId)
      .maybeSingle();
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
  }

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
      latest_checkin: latestCheckin
        ? {
            week_start: latestCheckin.week_start,
            accomplished: latestCheckin.accomplished,
            next_up: latestCheckin.next_up,
            blockers: latestCheckin.blockers,
          }
        : null,
    },
  });

  const orderedHistory = (history ?? []).slice().reverse();
  const messages: Anthropic.MessageParam[] = orderedHistory
    .filter((m: any) => m.role === "user" || m.role === "assistant")
    .map((m: any) => ({ role: m.role, content: m.content }));

  const client = new Anthropic({ apiKey: env.anthropicApiKey });

  // Stream and accumulate.
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let assembled = "";
      let usage:
        | {
            input_tokens?: number;
            output_tokens?: number;
            cache_creation_input_tokens?: number;
            cache_read_input_tokens?: number;
          }
        | null = null;
      try {
        const response = await client.messages.create({
          model: "claude-sonnet-4-6",
          max_tokens: 2048,
          system: [
            {
              type: "text",
              text: systemText,
              cache_control: { type: "ephemeral" },
            },
          ],
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
        await admin.from("ai_messages").insert({
          conversation_id: conversationId,
          role: "assistant",
          content: assembled,
          input_tokens: input,
          output_tokens: output,
          cache_creation_tokens: cacheCreation,
          cache_read_tokens: cacheRead,
        });

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
              `\n\n_Note: this message put you over the free tier. $${(chargedCents / 100).toFixed(2)} added to your account._`,
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
        controller.enqueue(
          encoder.encode(`\n\n[error: ${err?.message ?? "stream failed"}]`),
        );
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

