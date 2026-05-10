import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildSystemPrompt } from "@/lib/ai/system-prompt";
import { env } from "@/lib/env";
import { checkRateLimit } from "@/lib/rate-limit";
import { canUseAi } from "@/lib/access";
import type { Role } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Streaming chat endpoint. Body: { conversationId, message }
 * Streams text deltas to the client; on completion, persists both the
 * user message and the full assistant message to ai_messages.
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

  // Modest per-user limit so a runaway loop can't burn cost.
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

  const admin = createAdminClient();

  // Verify conversation belongs to user.
  const { data: convo } = await admin
    .from("ai_conversations")
    .select("id, user_id, title")
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
    content: message.trim(),
  });

  // Pull profile + recent history for context.
  const [{ data: profile }, { data: history }] = await Promise.all([
    admin
      .from("profiles")
      .select("full_name, ai_context")
      .eq("id", user.id)
      .single(),
    admin
      .from("ai_messages")
      .select("role, content, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true })
      .limit(40),
  ]);

  const systemText = buildSystemPrompt({
    studentName: profile?.full_name ?? null,
    startupContext: profile?.ai_context ?? null,
  });

  const messages: Anthropic.MessageParam[] = (history ?? [])
    .filter((m: any) => m.role === "user" || m.role === "assistant")
    .map((m: any) => ({ role: m.role, content: m.content }));

  const client = new Anthropic({ apiKey: env.anthropicApiKey });

  // Stream and accumulate.
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let assembled = "";
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
        }

        // Persist the assistant message.
        await admin.from("ai_messages").insert({
          conversation_id: conversationId,
          role: "assistant",
          content: assembled,
        });

        // Auto-title the conversation if it's still untitled.
        if (!convo.title) {
          const title = message.trim().slice(0, 60);
          await admin
            .from("ai_conversations")
            .update({ title })
            .eq("id", conversationId);
        }

        // Bump updated_at so the convo sorts to top.
        await admin
          .from("ai_conversations")
          .update({ updated_at: new Date().toISOString() })
          .eq("id", conversationId);
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
