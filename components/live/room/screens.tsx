"use client";
import type { ReactNode } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, CloudUpload, Loader2, LogOut, PhoneOff, Radio, ShieldOff } from "lucide-react";
import { LocalTime } from "@/components/ui/local-time";
import type { StageNoticeKind } from "./logic";
import type { RoomBusy, RoomEnd, RoomKind, RoomPhase, RoomSelf } from "./types";
import { FOCUS, Notice, RoomButton, Spinner } from "./ui";

/**
 * The room's full-screen states after the call (left / ended / closed), and
 * the notices drawn on an empty stage (connecting, waiting for the host, the
 * host stepped away, join failed). Copy is one line each.
 */

const BACK =
  `inline-flex h-10 items-center justify-center rounded-md border border-[#34343a] bg-[#18181b] px-4 text-sm font-medium text-[#f4f4f5] hover:bg-[#26262b] ${FOCUS}`;

export function EndScreen({
  kind,
  phase,
  self,
  end,
  backHref,
  busy,
  error,
  pendingUploads,
  onRejoin,
  onReopen,
  onBack,
}: {
  kind: RoomKind;
  phase: Exclude<RoomPhase, "prejoin" | "live">;
  self: RoomSelf;
  end: RoomEnd;
  backHref: string;
  busy: RoomBusy;
  error: string | null | undefined;
  /** Recording parts still uploading from this tab. */
  pendingUploads: number;
  onRejoin: () => void;
  onReopen?: () => void;
  /** Back while uploads are pending: the room waits for them, then navigates. */
  onBack?: () => void;
}) {
  // One way off this screen at a time; the one waiting for the upload says so.
  const exiting = busy === "rejoining" || busy === "reopening" || busy === "back";
  let icon: ReactNode = <LogOut className="h-7 w-7" />;
  let title: string;
  let detail: ReactNode = null;
  let rejoin = false;
  let reopen = false;

  if (phase === "left") {
    title = kind === "call" ? "You left the call" : "You've left";
    detail =
      kind === "call" ? (
        end.rejoinUntil ? (
          <>
            You can rejoin until <LocalTime value={end.rejoinUntil} mode="time" />.
          </>
        ) : null
      ) : (
        "The webinar is still running."
      );
    rejoin = true;
  } else if (phase === "ended") {
    icon = <PhoneOff className="h-7 w-7" />;
    if (kind === "call") {
      title = end.reason === "cancelled" ? "This call was cancelled" : "This call has ended";
    } else if (end.reopened) {
      icon = <Radio className="h-7 w-7" />;
      title = "The webinar was reopened";
      rejoin = true;
    } else if (end.byMe) {
      title = "You ended the webinar for everyone";
    } else if (self.broadcaster) {
      title = "The webinar was ended";
    } else {
      title = "This webinar has ended";
    }
    if (!end.reopened && end.at) {
      detail = (
        <>
          Ended at <LocalTime value={end.at} mode="time" />.
        </>
      );
    }
    reopen = kind === "webinar" && !!end.canReopen && !end.reopened && !!onReopen;
  } else {
    icon = <ShieldOff className="h-7 w-7" />;
    if (end.reason === "revoked") title = "You no longer have access to this room";
    else if (end.reason === "cancelled") title = "This call was cancelled";
    else title = kind === "call" ? "This call is over" : "This webinar is over";
  }

  return (
    <div className="grid h-full place-items-center overflow-y-auto py-10" data-testid={`end-${phase}`}>
      <div className="flex w-full flex-col items-center gap-6">
        <Notice icon={icon} title={title} detail={detail}>
          {rejoin ? (
            <RoomButton
              variant="primary"
              onClick={onRejoin}
              busy={busy === "rejoining"}
              disabled={exiting}
              data-testid="end-rejoin"
            >
              Rejoin
            </RoomButton>
          ) : null}
          {reopen ? (
            <RoomButton
              variant="primary"
              onClick={onReopen}
              busy={busy === "reopening"}
              disabled={exiting}
              data-testid="end-reopen"
            >
              Reopen
            </RoomButton>
          ) : null}
          {exiting ? (
            <RoomButton variant="subtle" busy={busy === "back"} disabled data-testid="end-back">
              Back
            </RoomButton>
          ) : (
            <Link
              href={backHref}
              className={BACK}
              data-testid="end-back"
              onClick={(e) => {
                // A modified click opens a new tab and leaves this one uploading.
                if (!onBack || pendingUploads === 0) return;
                if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                e.preventDefault();
                onBack();
              }}
            >
              Back
            </Link>
          )}
        </Notice>
        {error ? (
          <p className="max-w-md px-6 text-center text-sm text-[#ff8a8d]" role="alert">
            {error}
          </p>
        ) : null}
        {pendingUploads > 0 ? (
          <div className="px-6">
            <UploadingRecording />
          </div>
        ) : end.recording ? (
          <div className="px-6">
            <RecordingOutcome saved={end.recording.saved} error={end.recording.error} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Once this tab's upload is done: whether the recording made it. A take that
 * stopped early says so ("What reached the server is saved"); a start that
 * failed says the recording didn't start.
 */
function RecordingOutcome({ saved, error }: { saved: boolean; error: string | null }) {
  if (error) {
    return (
      <p
        className="flex max-w-md items-start gap-2 rounded-md border border-[#4a3a12] bg-[#241d0c] px-3 py-2.5 text-sm text-[#ffe3a3]"
        role="status"
        data-testid="recording-outcome"
        data-outcome="error"
      >
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#ffb224]" aria-hidden />
        <span>{saved ? error : "The recording didn't start."}</span>
      </p>
    );
  }
  if (!saved) return null;
  return (
    <p
      className="flex max-w-md items-center gap-2 text-sm text-[#a1a1aa]"
      role="status"
      data-testid="recording-outcome"
      data-outcome="saved"
    >
      <CheckCircle2 className="h-4 w-4 shrink-0 text-[#46a758]" aria-hidden />
      Recording saved.
    </p>
  );
}

/** While this tab still uploads the recording. */
export function UploadingRecording() {
  return (
    <div
      className="flex max-w-md items-center gap-2.5 rounded-md border border-[#34343a] bg-[#18181b] px-3 py-2.5 text-sm text-[#f4f4f5]"
      role="status"
      data-testid="uploading-recording"
    >
      <CloudUpload className="h-4 w-4 shrink-0 text-[#FFBB00]" aria-hidden />
      <span>Saving the recording. Keep this tab open.</span>
      <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[#a1a1aa]" aria-hidden />
    </div>
  );
}

export type { StageNoticeKind };

/** The empty stage: what a viewer sees with nobody on air. */
export function StageNotice({
  kind,
  startsAt,
  message,
  onRetry,
}: {
  kind: StageNoticeKind;
  startsAt?: string | null;
  message?: string | null;
  onRetry?: () => void;
}) {
  switch (kind) {
    case "failed":
      return (
        <Notice
          testId="notice-failed"
          icon={<AlertTriangle className="h-6 w-6 text-[#ffb224]" />}
          title="Couldn't join this room"
          detail={message ?? "Something went wrong connecting."}
        >
          {onRetry ? (
            <RoomButton variant="primary" onClick={onRetry} data-testid="notice-retry">
              Try again
            </RoomButton>
          ) : null}
        </Notice>
      );
    case "connecting":
      return <Notice testId="notice-connecting" icon={<Spinner className="h-6 w-6" />} title="Connecting…" />;
    case "reconnecting":
      return (
        <Notice testId="notice-reconnecting" icon={<Spinner className="h-6 w-6" />} title="Reconnecting to the host…" />
      );
    case "away":
      return (
        <Notice
          testId="notice-away"
          icon={<Spinner className="h-6 w-6" />}
          title="The host stepped away"
          detail="You'll reconnect automatically."
        />
      );
    case "starts":
      return (
        <Notice
          testId="notice-starts"
          icon={<Spinner className="h-6 w-6" />}
          title="Waiting for the host to start"
          detail={
            startsAt ? (
              <>
                Starts at <LocalTime value={startsAt} mode="time" />. You&rsquo;ll join automatically.
              </>
            ) : (
              "You'll join automatically."
            )
          }
        />
      );
    default:
      return (
        <Notice
          testId="notice-waiting"
          icon={<Spinner className="h-6 w-6" />}
          title="The host isn't on air right now"
          detail="You'll join automatically."
        />
      );
  }
}
