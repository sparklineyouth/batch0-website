import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { AiChat } from "./ai-chat";
import { ConversationList } from "./conversation-list";
import { ContextEditor } from "./context-editor";
import { env } from "@/lib/env";

export const metadata = { title: "AI co-founder · SparkLine" };

export default async function AiPage({
  searchParams,
}: {
  searchParams: { c?: string };
}) {
  const user = await requireUser();
  const supabase = createClient();

  const [{ data: convos }, { data: profile }] = await Promise.all([
    supabase
      .from("ai_conversations")
      .select("id, title, updated_at")
      .order("updated_at", { ascending: false }),
    supabase
      .from("profiles")
      .select("ai_context")
      .eq("id", user.id)
      .maybeSingle(),
  ]);

  const list = convos ?? [];
  const selectedId = searchParams.c ?? list[0]?.id;

  let messages: any[] = [];
  if (selectedId) {
    const { data } = await supabase
      .from("ai_messages")
      .select("id, role, content, created_at")
      .eq("conversation_id", selectedId)
      .order("created_at", { ascending: true });
    messages = data ?? [];
  }

  if (!env.anthropicApiKey) {
    return (
      <div className="mx-auto max-w-3xl">
        <h1 className="text-3xl font-bold tracking-tight">AI co-founder</h1>
        <Card className="mt-6 border-amber-300/30 bg-amber-300/5">
          <p className="text-sm text-amber-200">
            The AI co-founder isn't enabled on this deployment yet.
            Set <code className="rounded bg-black/40 px-1.5 py-0.5">ANTHROPIC_API_KEY</code> in your
            production env vars and redeploy.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto grid max-w-6xl gap-6 lg:grid-cols-[260px_1fr]">
      <aside className="space-y-6">
        <ConversationList
          conversations={list as any}
          selectedId={selectedId ?? null}
        />
        <Card className="!p-0">
          <details className="group">
            <summary className="cursor-pointer list-none select-none px-5 py-4 text-sm font-semibold text-white">
              <span className="mr-1 inline-block transition-transform group-open:rotate-90">
                ›
              </span>
              Startup context
            </summary>
            <div className="px-5 pb-5">
              <p className="mb-3 text-xs text-white/50">
                The AI uses these as background in every chat. Update as your
                idea evolves.
              </p>
              <ContextEditor
                initial={(profile?.ai_context as Record<string, string>) ?? {}}
              />
            </div>
          </details>
        </Card>
      </aside>
      <section className="min-h-[60vh]">
        {selectedId ? (
          <AiChat
            conversationId={selectedId}
            initialMessages={messages.map((m) => ({
              role: m.role,
              content: m.content,
            }))}
          />
        ) : (
          <Card>
            <p className="text-sm text-white/60">
              Start a new chat to talk to your AI co-founder.
            </p>
          </Card>
        )}
      </section>
    </div>
  );
}
