"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { Sparkles, Send, Loader2 } from "lucide-react";
import { getActionError } from "@/lib/action-error";

type Msg = { role: "user" | "assistant"; content: string };

export function AiChat({
  conversationId,
  initialMessages,
}: {
  conversationId: string;
  initialMessages: Msg[];
}) {
  const router = useRouter();
  const [messages, setMessages] = useState<Msg[]>(initialMessages);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const scrollRef = useRef<HTMLDivElement>(null);

  // When the conversation changes, reset.
  useEffect(() => {
    setMessages(initialMessages);
    setStreaming(false);
    setError(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, streaming]);

  async function send() {
    const text = input.trim();
    if (!text || streaming) return;
    setError(undefined);
    setInput("");
    const next: Msg[] = [
      ...messages,
      { role: "user", content: text },
      { role: "assistant", content: "" },
    ];
    setMessages(next);
    setStreaming(true);

    try {
      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId, message: text }),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Request failed (${res.status})`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let assembled = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        assembled += decoder.decode(value, { stream: true });
        setMessages((prev) => {
          const out = [...prev];
          out[out.length - 1] = { role: "assistant", content: assembled };
          return out;
        });
      }
      router.refresh();
    } catch (e: any) {
      setError(getActionError(e));
    } finally {
      setStreaming(false);
    }
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div className="flex h-[calc(100vh-9rem)] min-h-[480px] flex-col rounded-2xl border border-white/10 bg-zinc-900/30">
      <div className="flex items-center gap-2 border-b border-white/10 px-5 py-3">
        <Sparkles className="h-4 w-4 text-spark" />
        <span className="text-sm font-semibold text-white">
          AI co-founder
        </span>
        <span className="ml-auto text-[10px] uppercase tracking-wider text-white/40">
          Claude Sonnet 4.6
        </span>
      </div>
      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto px-5 py-6">
        {messages.length === 0 && (
          <Welcome />
        )}
        {messages.map((m, i) => (
          <Bubble key={i} message={m} />
        ))}
        {streaming && messages[messages.length - 1]?.content === "" && (
          <div className="flex items-center gap-2 text-xs text-white/40">
            <Loader2 className="h-3 w-3 animate-spin" />
            Thinking…
          </div>
        )}
      </div>
      {error && (
        <div className="border-t border-red-400/30 bg-red-400/5 px-5 py-2 text-xs text-red-300">
          {error}
        </div>
      )}
      <div className="border-t border-white/10 p-4">
        <Textarea
          rows={2}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          placeholder="Ask anything — idea critique, customer interview script, pitch feedback…"
          className="resize-none"
          disabled={streaming}
        />
        <div className="mt-2 flex items-center justify-between">
          <span className="text-[11px] text-white/40">
            Press Enter to send · Shift+Enter for newline
          </span>
          <Button
            type="button"
            onClick={send}
            disabled={streaming || !input.trim()}
            size="sm"
          >
            {streaming ? "Sending…" : (
              <>
                Send <Send className="h-3.5 w-3.5" />
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Bubble({ message }: { message: Msg }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-br-md bg-spark/15 px-4 py-2.5 text-sm text-white">
          {message.content}
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-spark/15 text-spark">
        <Sparkles className="h-3.5 w-3.5" />
      </div>
      <div className="max-w-[80%] whitespace-pre-wrap break-words [overflow-wrap:anywhere] rounded-2xl rounded-tl-md bg-white/5 px-4 py-2.5 text-sm text-white/90">
        {message.content || "…"}
      </div>
    </div>
  );
}

function Welcome() {
  return (
    <div className="rounded-xl border border-white/10 bg-black/30 p-5 text-sm text-white/70">
      <div className="mb-2 inline-flex items-center gap-2 rounded-full bg-spark/10 px-2.5 py-0.5 text-xs font-semibold text-spark">
        <Sparkles className="h-3.5 w-3.5" />
        Your AI co-founder
      </div>
      <p>
        I'm here to think with you about your startup. Try asking:
      </p>
      <ul className="mt-3 space-y-1.5 text-white/60">
        <li>• "Help me write a customer interview script for my idea."</li>
        <li>• "Critique my Lean Canvas: [paste it here]."</li>
        <li>• "Draft a cold email to a potential customer."</li>
        <li>• "What's a tight 60-second elevator pitch?"</li>
      </ul>
    </div>
  );
}
