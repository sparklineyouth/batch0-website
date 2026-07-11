import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireUser, getProfile } from "@/lib/auth";
import { canUseAi } from "@/lib/access";
import { Card } from "@/components/ui/card";
import { AiChat } from "./ai-chat";
import { ConversationList } from "./conversation-list";
import { ContextEditor } from "./context-editor";
import { UsageMeter } from "./usage-meter";
import { getCurrentUsage } from "@/lib/ai/usage";
import {
  MONTHLY_FREE_INPUT_TOKENS,
  MONTHLY_FREE_OUTPUT_TOKENS,
} from "@/lib/ai/pricing";
import { env } from "@/lib/env";
import { Lock, Sparkles } from "lucide-react";

export const metadata = { title: "AI co-founder · Sparkline Youth" };

export default async function AiPage({
  searchParams,
}: {
  searchParams: { c?: string };
}) {
  const user = await requireUser();
  const profile = await getProfile();

  // Gate access. Staff always gets in; students need an accepted+ application.
  const allowed = profile ? await canUseAi(profile.role) : false;
  if (!allowed) {
    return <LockedView />;
  }

  if (!env.anthropicApiKey) {
    return (
      <div className="mx-auto max-w-3xl">
        <h1 className="text-3xl font-bold tracking-tight">AI co-founder</h1>
        <Card className="mt-6 border-amber-500/30 bg-amber-500/10">
          <p className="text-sm text-amber-700 dark:text-amber-300">
            The AI co-founder isn't enabled on this deployment yet. Set{" "}
            <code className="rounded border border-line bg-paper px-1.5 py-0.5">ANTHROPIC_API_KEY</code>{" "}
            in your production env vars and redeploy.
          </p>
        </Card>
      </div>
    );
  }

  const supabase = createClient();
  const [{ data: convos }, { data: profileRow }, usage] = await Promise.all([
    supabase
      .from("ai_conversations")
      .select("id, title, updated_at")
      .order("updated_at", { ascending: false }),
    supabase
      .from("profiles")
      .select("ai_context")
      .eq("id", user.id)
      .maybeSingle(),
    getCurrentUsage(user.id),
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

  return (
    <div className="mx-auto grid max-w-6xl gap-6 lg:grid-cols-[260px_1fr]">
      <aside className="space-y-6">
        <ConversationList
          conversations={list as any}
          selectedId={selectedId ?? null}
        />
        <UsageMeter
          inputTokens={usage.input_tokens}
          outputTokens={usage.output_tokens}
          billedCents={usage.billed_cents}
          freeInput={MONTHLY_FREE_INPUT_TOKENS}
          freeOutput={MONTHLY_FREE_OUTPUT_TOKENS}
        />
        <Card className="!p-0">
          <details className="group">
            <summary className="cursor-pointer list-none select-none px-5 py-4 text-sm font-semibold text-ink">
              <span className="mr-1 inline-block transition-transform group-open:rotate-90">
                ›
              </span>
              Startup context
            </summary>
            <div className="px-5 pb-5">
              <p className="mb-3 text-xs text-ink-soft">
                The AI uses these as background in every chat. Update as your
                idea evolves.
              </p>
              <ContextEditor
                initial={(profileRow?.ai_context as Record<string, string>) ?? {}}
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
            <p className="text-sm text-ink-soft">
              Start a new chat to talk to your AI co-founder.
            </p>
          </Card>
        )}
      </section>
    </div>
  );
}

function LockedView() {
  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-3xl font-bold tracking-tight">AI co-founder</h1>
      <Card className="mt-6">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-spark/10 text-spark-ink">
            <Lock className="h-4 w-4" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-ink">
              Locked until you're accepted
            </h2>
            <p className="mt-1 text-sm text-ink-soft">
              The AI co-founder is part of the Sparkline Youth program. It unlocks
              the moment your application is accepted — submit your
              application and we'll review it on a rolling basis.
            </p>
            <div className="mt-4 flex flex-wrap gap-2 text-sm">
              <Link
                href="/apply"
                className="inline-flex items-center gap-1.5 rounded-full bg-spark px-3 py-1.5 font-semibold text-on-spark hover:bg-spark-200"
              >
                <Sparkles className="h-3.5 w-3.5" />
                Apply now
              </Link>
              <Link
                href="/dashboard/application"
                className="inline-flex items-center rounded-full border border-line px-3 py-1.5 text-ink hover:border-ink/30 hover:bg-wash"
              >
                View application status
              </Link>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
