"use client";

import { useState, useTransition } from "react";
import { Input, Textarea, Select, Label } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { getActionError } from "@/lib/action-error";
// Value imports come from the crypto-free topics module so this client
// component doesn't pull node:crypto into the bundle; the type is erased.
import { FEEDBACK_TOPICS, feedbackTopicLabel } from "@/lib/founder-pass-topics";
import type { FeedbackRequest } from "@/lib/founder-pass-perks";
import { redeemFeedbackCreditAction } from "./actions";

/**
 * The one-time feedback credit (perk 5). Two states, no more: if the holder has
 * a live request we show its status and the team's reply once it lands; if not,
 * we show the redeem form. The copy is deliberately request-shaped ("the team
 * will get back to you") rather than a guarantee of turnaround — the credit is
 * real, the timing is human.
 */
export function FeedbackCredit({
  request,
}: {
  request: FeedbackRequest | null;
}) {
  if (request) return <FeedbackStatus request={request} />;
  return <FeedbackForm />;
}

function FeedbackStatus({ request }: { request: FeedbackRequest }) {
  const delivered = request.status === "delivered";
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-ink">
          Feedback on {feedbackTopicLabel(request.topic).toLowerCase()}
        </p>
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
            delivered
              ? "bg-phosphor/10 text-phosphor-ink"
              : "bg-wash text-ink-soft"
          }`}
        >
          {delivered
            ? "Delivered"
            : request.status === "scheduled"
              ? "Scheduled"
              : "In the queue"}
        </span>
      </div>
      {request.detail && (
        <p className="whitespace-pre-wrap text-sm text-ink-soft">
          {request.detail}
        </p>
      )}
      {delivered && request.response ? (
        <div className="rounded-lg border border-phosphor/30 bg-phosphor/[0.04] p-3">
          <div className="text-[11px] font-medium uppercase tracking-wider text-phosphor-ink">
            From the team
          </div>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm text-ink-soft">
            {request.response}
          </p>
        </div>
      ) : (
        <p className="text-xs text-ink-faint">
          You've redeemed your credit. The team will reply here on your
          dashboard, or invite you to a live clinic.
        </p>
      )}
    </div>
  );
}

function FeedbackForm() {
  const [topic, setTopic] = useState<string>("");
  const [detail, setDetail] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();

  function submit() {
    setError(undefined);
    if (!topic) {
      setError("Pick what you'd like feedback on.");
      return;
    }
    start(async () => {
      try {
        const res = await redeemFeedbackCreditAction({ topic, detail, linkUrl });
        if (!res.ok) setError(res.message);
        // On success the page revalidates and this form is replaced by the
        // status view, so there's nothing to reset here.
      } catch (e) {
        setError(getActionError(e));
      }
    });
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-soft">
        Redeem your one feedback credit for focused, human feedback on one thing.
      </p>
      <div>
        <Label htmlFor="feedback-topic">What should we look at?</Label>
        <Select
          id="feedback-topic"
          value={topic}
          disabled={pending}
          onChange={(e) => setTopic(e.target.value)}
        >
          <option value="">Choose one…</option>
          {FEEDBACK_TOPICS.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label htmlFor="feedback-detail">Context</Label>
        <Textarea
          id="feedback-detail"
          rows={3}
          value={detail}
          maxLength={4000}
          placeholder="What do you want a second pair of eyes on? What's the decision you're stuck on?"
          disabled={pending}
          onChange={(e) => setDetail(e.target.value)}
        />
      </div>
      <div>
        <Label htmlFor="feedback-link">Link (optional)</Label>
        <Input
          id="feedback-link"
          value={linkUrl}
          placeholder="Deck, landing page, repo, Figma…"
          disabled={pending}
          onChange={(e) => setLinkUrl(e.target.value)}
        />
      </div>
      {error && <p className="text-xs text-red-700 dark:text-red-300">{error}</p>}
      <Button size="sm" onClick={submit} disabled={pending}>
        {pending ? "Redeeming…" : "Redeem feedback credit"}
      </Button>
      <p className="text-xs text-ink-faint">
        One credit per pass. You can redeem it any time.
      </p>
    </div>
  );
}
