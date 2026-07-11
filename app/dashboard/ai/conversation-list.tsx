"use client";
import Link from "next/link";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { createConversation, deleteConversation } from "./actions";

type Convo = { id: string; title: string | null; updated_at: string };

export function ConversationList({
  conversations,
  selectedId,
}: {
  conversations: Convo[];
  selectedId: string | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  function newChat() {
    start(async () => {
      const id = await createConversation();
      router.push(`/dashboard/ai?c=${id}`);
      router.refresh();
    });
  }

  function remove(id: string) {
    start(async () => {
      await deleteConversation(id);
      router.push("/dashboard/ai");
      router.refresh();
    });
  }

  return (
    <div className="rounded-2xl border border-line bg-wash p-3">
      <button
        type="button"
        onClick={newChat}
        disabled={pending}
        className="mb-3 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-spark px-3 py-2 text-xs font-semibold text-on-spark hover:bg-spark-200 disabled:opacity-50"
      >
        <Plus className="h-3.5 w-3.5" /> New chat
      </button>
      <ul className="space-y-1">
        {conversations.length === 0 && (
          <li className="px-2 py-3 text-xs text-ink-faint">No chats yet.</li>
        )}
        {conversations.map((c) => {
          const active = c.id === selectedId;
          return (
            <li key={c.id} className="group">
              <div
                className={`flex items-center gap-1 rounded-lg px-2 py-1.5 ${
                  active
                    ? "bg-spark/10"
                    : "hover:bg-wash"
                }`}
              >
                <Link
                  href={`/dashboard/ai?c=${c.id}`}
                  className={`min-w-0 flex-1 truncate text-sm ${
                    active ? "text-spark-ink" : "text-ink-soft"
                  }`}
                >
                  {c.title || "New chat"}
                </Link>
                <button
                  type="button"
                  onClick={() => remove(c.id)}
                  disabled={pending}
                  className="opacity-0 transition group-hover:opacity-100 text-ink-faint hover:text-red-600 dark:hover:text-red-400"
                  aria-label="Delete chat"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
