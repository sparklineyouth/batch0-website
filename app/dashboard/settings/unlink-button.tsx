"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * The Discord unlink control.
 *
 * A plain `<form action="/auth/discord/unlink" method="post">` was correct and
 * degraded fine without JavaScript, but it gave no sign anything was happening
 * — and the route behind it talks to Discord (a settings read plus up to four
 * role deletions), so a second or two of apparent nothing was the normal case.
 * The reliable read of a button that doesn't respond is that it's broken, so
 * people clicked again, and the second POST raced the first.
 *
 * This keeps the real form and the real POST — no fetch, no server action, so
 * it still works with JS off — and only adds the two things the bare form
 * couldn't do: confirm before firing, and stay disabled while in flight.
 *
 * `useFormStatus` would be the idiomatic way to get the pending state, but it
 * only reports on React *function* actions; a form posting to a URL is a
 * native browser navigation React never sees. Hence the local state.
 */
export function UnlinkDiscordButton() {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);

  return (
    <form
      action="/auth/discord/unlink"
      method="post"
      // Fires only for the confirm submit — the first click is a type="button"
      // that never submits. Not preventDefault'd: the browser still performs
      // the POST, this just latches the button before it leaves.
      onSubmit={() => setPending(true)}
      className="flex flex-wrap items-center gap-2"
    >
      {/* Note the first button is type="submit" with a preventDefault'd
          handler, not type="button". With JavaScript off the handler never
          runs and the click posts the form directly — which is the whole point
          of not having replaced this with a fetch. */}
      {confirming ? (
        <>
          <Button
            variant="danger"
            size="sm"
            type="submit"
            disabled={pending}
            aria-live="polite"
          >
            {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {pending ? "Unlinking…" : "Confirm unlink"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            type="button"
            disabled={pending}
            onClick={() => setConfirming(false)}
          >
            Cancel
          </Button>
        </>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          type="submit"
          onClick={(e) => {
            e.preventDefault();
            setConfirming(true);
          }}
        >
          Unlink
        </Button>
      )}
      {confirming && !pending && (
        <p className="basis-full text-xs text-ink-faint">
          You'll lose your batch0 roles in the server. You can link again any
          time.
        </p>
      )}
    </form>
  );
}
