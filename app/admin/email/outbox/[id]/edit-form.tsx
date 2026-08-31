"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Save, Send, Unlink, XCircle, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/dialog";
import { RichTextEditor } from "@/components/admin/rich-text-editor";
import { getActionError } from "@/lib/action-error";
import { COMMON_VARIABLES } from "@/lib/email/catalog";
import {
  updateQueuedEmail,
  detachQueuedEmail,
  sendQueuedNow,
  cancelQueued,
  previewQueued,
} from "../actions";

export type QueuedRowView = {
  id: string;
  status: string;
  toEmail: string;
  toName: string;
  sendAfter: string;
  subject: string;
  bodyHtml: string;
  templateId: string | null;
  templateName: string | null;
  automationName: string | null;
  variables: Record<string, string>;
};

/** ISO instant → the `YYYY-MM-DDTHH:mm` a datetime-local input wants, local. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

/**
 * Edit one email that hasn't gone out yet.
 *
 * The interesting case is a template-backed row. Its wording isn't stored on
 * the row at all — it's rendered from the template at send time, which is what
 * lets a typo fix reach mail already queued. So "edit the copy" here is a
 * genuine fork, and the UI makes the admin pick rather than guessing:
 *
 *   · change the template  → affects everyone queued against it
 *   · detach this one      → freezes today's wording onto this single email
 *
 * Recipient and send time are editable either way; neither depends on where
 * the copy comes from.
 */
export function QueuedEmailEditor({
  row,
  canEdit,
}: {
  row: QueuedRowView;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [toEmail, setToEmail] = useState(row.toEmail);
  const [toName, setToName] = useState(row.toName);
  const [sendAfter, setSendAfter] = useState(toLocalInput(row.sendAfter));
  const [subject, setSubject] = useState(row.subject);
  const [bodyHtml, setBodyHtml] = useState(row.bodyHtml);
  const [templateId, setTemplateId] = useState(row.templateId);

  const [pending, start] = useTransition();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [confirmDetach, setConfirmDetach] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [previewHtml, setPreviewHtml] = useState("");

  const attached = Boolean(templateId);
  const editable = canEdit && row.status === "pending";

  // The preview always comes from the server so it goes through the same
  // sanitize → interpolate → wrap path a real send does. `savedAt` is real
  // state, not a ref: mutating a ref doesn't schedule a render, so using one
  // as an effect dependency only re-ran this by accident, via the
  // router.refresh() that happened to follow.
  const [savedAt, setSavedAt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    previewQueued(row.id)
      .then((res) => {
        if (!cancelled && res.ok) setPreviewHtml(res.html);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [row.id, savedAt]);

  function run(
    fn: () => Promise<{ ok: boolean; error?: string }>,
    successMessage: string,
    after?: () => void,
  ) {
    setError(undefined);
    setNotice(undefined);
    start(async () => {
      try {
        const res = await fn();
        if (!res.ok) {
          setError(res.error ?? "Something went wrong.");
          return;
        }
        setNotice(successMessage);
        setSavedAt((n) => n + 1);
        after?.();
        router.refresh();
      } catch (err) {
        setError(getActionError(err));
      }
    });
  }

  return (
    <div className="mx-auto max-w-[1200px]">
      <Link
        href="/admin/email/outbox"
        className="inline-flex items-center gap-1.5 text-sm text-ink-soft hover:text-ink"
      >
        <ArrowLeft className="h-4 w-4" /> Outbox
      </Link>
      <h1 className="mt-2 font-display text-3xl font-bold tracking-[-0.02em] text-ink">
        Edit queued email
      </h1>
      <p className="mt-1 text-sm text-ink-soft">
        To {row.toEmail}
        {row.automationName && ` · queued by “${row.automationName}”`}
      </p>

      {!editable && (
        <Card className="mt-5 border-amber-500/30 bg-amber-500/5">
          <p className="text-sm text-ink-soft">
            {!canEdit ? (
              <>
                You can view this queued email but not change it — that needs
                the <strong className="text-ink">Send email</strong> permission.
              </>
            ) : (
              <>
                This email is <strong className="text-ink">{row.status}</strong>
                , so it can no longer be changed. Once a message leaves the
                queue there's nothing to edit — it's in someone's inbox.
              </>
            )}
          </p>
        </Card>
      )}

      {error && (
        <div className="mt-5 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}
      {notice && (
        <div className="mt-5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-300">
          {notice}
        </div>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_420px]">
        <div className="space-y-5">
          <Card className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="q-to">Recipient</Label>
                <Input
                  id="q-to"
                  type="email"
                  value={toEmail}
                  onChange={(e) => setToEmail(e.target.value)}
                  disabled={!editable}
                />
              </div>
              <div>
                <Label htmlFor="q-name">Name</Label>
                <Input
                  id="q-name"
                  value={toName}
                  onChange={(e) => setToName(e.target.value)}
                  placeholder="optional"
                  disabled={!editable}
                />
              </div>
            </div>
            <div>
              <Label htmlFor="q-when">Send at</Label>
              <Input
                id="q-when"
                type="datetime-local"
                value={sendAfter}
                onChange={(e) => setSendAfter(e.target.value)}
                disabled={!editable}
                className="max-w-[260px]"
              />
              <p className="mt-1 text-xs text-ink-faint">
                Your local time. It goes out on the first queue run after that
                moment — the queue is checked every five minutes.
              </p>
            </div>
          </Card>

          <Card className="space-y-4">
            {attached ? (
              <div className="space-y-3">
                <div className="flex items-start gap-2 rounded-lg border border-line bg-paper px-3 py-2.5 text-xs text-ink-soft">
                  <FileText className="mt-0.5 h-4 w-4 shrink-0 text-ink-faint" />
                  <span>
                    The wording comes from the{" "}
                    <Link
                      href={`/admin/email/templates/${templateId}`}
                      className="font-medium text-phosphor-ink underline"
                    >
                      {row.templateName ?? "template"}
                    </Link>{" "}
                    template and is rendered when this sends — so editing that
                    template updates this email too, along with every other one
                    queued against it. To change the words for{" "}
                    <strong className="text-ink">this recipient only</strong>,
                    detach it first.
                  </span>
                </div>
                <div>
                  <Label>Body (from the template)</Label>
                  <div
                    className="max-h-64 overflow-y-auto rounded-lg border border-line bg-paper p-3 text-sm text-ink-soft [&_a]:text-phosphor-ink [&_a]:underline"
                    dangerouslySetInnerHTML={{ __html: bodyHtml }}
                  />
                </div>
                <Button
                  variant="secondary"
                  onClick={() => setConfirmDetach(true)}
                  disabled={!editable || pending}
                >
                  <Unlink className="h-4 w-4" /> Detach &amp; edit this one
                </Button>
              </div>
            ) : (
              <>
                <div className="rounded-lg border border-line bg-paper px-3 py-2 text-xs text-ink-soft">
                  This email has its own copy — editing it here changes nothing
                  else. Merge tags like{" "}
                  <code className="font-mono text-phosphor-ink">
                    {`{{first_name}}`}
                  </code>{" "}
                  still fill in when it sends.
                </div>
                <div>
                  <Label htmlFor="q-subject">Subject</Label>
                  <Input
                    id="q-subject"
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    disabled={!editable}
                  />
                </div>
                <div>
                  <Label>Body</Label>
                  <RichTextEditor
                    value={bodyHtml}
                    onChange={setBodyHtml}
                    variables={COMMON_VARIABLES}
                    minHeight={220}
                    disabled={!editable}
                  />
                </div>
              </>
            )}
          </Card>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={() =>
                run(
                  () =>
                    updateQueuedEmail({
                      id: row.id,
                      toEmail,
                      toName,
                      // datetime-local has no zone; resolve it to a real
                      // instant here, where the admin's timezone is known.
                      sendAfter: new Date(sendAfter).toISOString(),
                      subject,
                      bodyHtml,
                    }),
                  "Saved.",
                )
              }
              disabled={!editable || pending}
            >
              <Save className="h-4 w-4" /> {pending ? "Saving…" : "Save changes"}
            </Button>
            <Button
              variant="secondary"
              onClick={() => run(() => sendQueuedNow(row.id), "Moved to the front of the queue.")}
              disabled={!editable || pending}
            >
              <Send className="h-4 w-4" /> Send on next run
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => setConfirmCancel(true)}
              disabled={!editable || pending}
            >
              <XCircle className="h-4 w-4" /> Cancel this email
            </Button>
          </div>
        </div>

        <div className="lg:sticky lg:top-6 lg:self-start">
          <Card className="!p-0 overflow-hidden">
            <div className="border-b border-line px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-ink-faint">
              As it will send
            </div>
            <div className="bg-[#0a0a0a] p-2">
              <iframe
                title="Queued email preview"
                srcDoc={previewHtml}
                sandbox=""
                className="h-[560px] w-full rounded-lg border-0 bg-[#0a0a0a]"
              />
            </div>
          </Card>
          <p className="mt-2 text-xs text-ink-faint">
            Rendered by the server through the same path a real send uses. Save
            first — the preview reflects what's stored, not what's typed.
          </p>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDetach}
        onCancel={() => setConfirmDetach(false)}
        onConfirm={() => {
          setConfirmDetach(false);
          run(
            () => detachQueuedEmail(row.id),
            "Detached. The copy below is now this email's own.",
            () => setTemplateId(null),
          );
        }}
        title="Detach this email from its template?"
        description={`It keeps the wording the "${row.templateName ?? "template"}" template produces today, as its own copy. Later edits to that template will no longer reach this one — and this is not reversible from here.`}
        confirmLabel="Detach it"
        pending={pending}
      />
      <ConfirmDialog
        open={confirmCancel}
        onCancel={() => setConfirmCancel(false)}
        onConfirm={() => {
          setConfirmCancel(false);
          run(() => cancelQueued(row.id), "Cancelled — it won't send.", () =>
            router.push("/admin/email/outbox"),
          );
        }}
        title="Cancel this email?"
        description="It stays in the outbox as a cancelled row so there's a record, but it won't be sent. You can put it back with Retry."
        confirmLabel="Cancel it"
        pending={pending}
        destructive
      />
    </div>
  );
}
