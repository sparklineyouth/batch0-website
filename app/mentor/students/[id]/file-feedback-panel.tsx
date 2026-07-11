"use client";
import { useState, useTransition, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea, FieldError } from "@/components/ui/input";
import { LocalTime } from "@/components/ui/local-time";
import { Download, FileText, MessageSquare } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { getDownloadUrl } from "@/app/dashboard/files/actions";
import { postFileFeedback } from "./actions";
import { formatRelativeTime } from "@/lib/format-time";
import { getActionError } from "@/lib/action-error";

type File = {
  id: string;
  name: string;
  size_bytes: number | null;
  mime_type: string | null;
  created_at: string;
};

type Feedback = {
  id: string;
  body: string;
  created_at: string;
  author: { full_name: string | null; email: string };
};

function fmtBytes(n: number | null) {
  if (!n) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

export function FileFeedbackPanel({
  studentId: _studentId,
  files,
}: {
  studentId: string;
  files: File[];
}) {
  const router = useRouter();
  const [active, setActive] = useState<string | null>(
    files[0]?.id ?? null,
  );
  const [pending, start] = useTransition();
  const [feedback, setFeedback] = useState<Feedback[]>([]);
  const [body, setBody] = useState("");
  const [err, setErr] = useState<string | undefined>();

  useEffect(() => {
    if (!active) {
      setFeedback([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const { data } = await supabase
        .from("file_feedback")
        .select("id, body, created_at, author:profiles(full_name, email)")
        .eq("student_file_id", active)
        .order("created_at", { ascending: true });
      if (!cancelled) {
        const items = (data ?? []).map((f: any) => ({
          ...f,
          author: Array.isArray(f.author) ? f.author[0] : f.author,
        }));
        setFeedback(items as any);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active]);

  async function download(id: string) {
    setErr(undefined);
    try {
      const url = await getDownloadUrl(id);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (e: any) {
      setErr(getActionError(e));
    }
  }

  function send() {
    if (!active) return;
    const text = body.trim();
    if (!text) return;
    setErr(undefined);
    start(async () => {
      try {
        await postFileFeedback({ studentFileId: active, body: text });
        setBody("");
        router.refresh();
        // Re-fetch feedback list.
        const supabase = createClient();
        const { data } = await supabase
          .from("file_feedback")
          .select("id, body, created_at, author:profiles(full_name, email)")
          .eq("student_file_id", active)
          .order("created_at", { ascending: true });
        const items = (data ?? []).map((f: any) => ({
          ...f,
          author: Array.isArray(f.author) ? f.author[0] : f.author,
        }));
        setFeedback(items as any);
      } catch (e: any) {
        setErr(getActionError(e));
      }
    });
  }

  return (
    <Card className="!p-0 overflow-hidden">
      <div className="border-b border-line px-4 py-3 md:px-5">
        <h2 className="font-display text-base font-semibold tracking-[-0.02em] text-ink">Files + feedback</h2>
        <p className="text-xs text-ink-faint">
          The student's personal uploads. Open one to download or leave
          mentor feedback.
        </p>
      </div>
      {files.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-ink-faint">
          No files uploaded yet.
        </p>
      ) : (
        <div className="grid md:grid-cols-[16rem_minmax(0,1fr)]">
          <ul className="max-h-80 divide-y divide-line overflow-y-auto md:max-h-[28rem] md:border-r md:border-line">
            {files.map((f) => (
              <li key={f.id}>
                <button
                  type="button"
                  onClick={() => setActive(f.id)}
                  className={`flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm transition ${
                    active === f.id
                      ? "bg-spark/10 text-ink"
                      : "text-ink-soft hover:bg-wash"
                  }`}
                >
                  <FileText className="h-4 w-4 shrink-0 text-ink-faint" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate">{f.name}</div>
                    <div className="text-[11px] text-ink-faint">
                      {fmtBytes(f.size_bytes)} ·{" "}
                      <LocalTime value={f.created_at} mode="date" />
                    </div>
                  </div>
                </button>
              </li>
            ))}
          </ul>

          <div className="p-4 md:p-5">
            {active ? (
              <>
                <div className="mb-3 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-ink">
                      {files.find((f) => f.id === active)?.name}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => download(active)}
                  >
                    <Download className="h-3.5 w-3.5" /> Download
                  </Button>
                </div>
                <ul className="space-y-3">
                  {feedback.length === 0 && (
                    <li className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-xs text-ink-faint">
                      No feedback yet.
                    </li>
                  )}
                  {feedback.map((f) => (
                    <li
                      key={f.id}
                      className="rounded-lg border border-line bg-paper p-3"
                    >
                      <div className="flex items-baseline justify-between text-xs text-ink-faint">
                        <span>
                          {f.author.full_name ?? f.author.email}
                        </span>
                        <span>{formatRelativeTime(f.created_at)}</span>
                      </div>
                      <p className="mt-1 whitespace-pre-wrap break-words text-sm text-ink-soft">
                        {f.body}
                      </p>
                    </li>
                  ))}
                </ul>
                <div className="mt-4 border-t border-line pt-3">
                  <Textarea
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    placeholder="Leave feedback for the student"
                    rows={3}
                    maxLength={4000}
                  />
                  <div className="mt-2 flex items-center justify-between">
                    <FieldError>{err}</FieldError>
                    <Button
                      size="sm"
                      onClick={send}
                      disabled={pending || !body.trim()}
                    >
                      <MessageSquare className="h-3.5 w-3.5" />
                      {pending ? "Sending…" : "Send"}
                    </Button>
                  </div>
                </div>
              </>
            ) : (
              <p className="text-sm text-ink-faint">Pick a file to review.</p>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
