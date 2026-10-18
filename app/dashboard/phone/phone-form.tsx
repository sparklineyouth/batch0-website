"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Check, Loader2, ShieldCheck, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, FieldError } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/dialog";
import { LocalTime } from "@/components/ui/local-time";
import {
  formatE164,
  isReachableByTollFree,
  isValidPhone,
  normalizeToE164,
} from "@/lib/phone";
import { optOutAction, savePhoneAction } from "./actions";

/** The bits of a `messaging_consent` row this screen renders. */
export type ConsentSnapshot = {
  transactional: boolean;
  optedOutAt: string | null;
  /** False when the opt-out came from a STOP or a request, which only START can undo. */
  liftableHere: boolean;
  lastOptedInAt: string | null;
};

/**
 * Whether this page offers texts at all, decided on the server.
 *
 *   unavailable — 0106 hasn't run: the number field alone, nothing to opt into.
 *   under_age   — the applicant is under 13 (lib/sms/policy.ts): no checkbox.
 *   ready       — the opt-in, for the number saved on the application.
 */
export type TextsState =
  | { kind: "unavailable" }
  | { kind: "under_age" }
  | {
      kind: "ready";
      /** False until provider credentials exist — the page says so. */
      live: boolean;
      /** The normalized number the snapshot belongs to. */
      savedE164: string | null;
      consent: ConsentSnapshot | null;
    };

/**
 * /dashboard/phone — the number, and the opt-in screen.
 *
 * This is the page a carrier's vetting team looks at when it decides whether
 * to approve our sending number, so its shape is dictated by what that review
 * asks for: the disclosure is rendered in full, next to its own checkbox,
 * unchecked, and separate from every other agreement on the page. Anything that
 * shortens the copy, pre-ticks the box, or bundles it with saving the number
 * makes it stop being a deliberate choice about texting — so none of it is a
 * styling decision.
 *
 * The number is validated with the same `normalizeToE164` the server uses, and
 * the result is echoed back before submit, because the cost of a mistyped
 * digit here is a text to a stranger.
 */
export function PhoneForm({
  initialPhone,
  texts,
  consentCopy,
}: {
  initialPhone: string;
  texts: TextsState;
  /**
   * CONSENT_COPY.studentTransactional, handed down from the server rather than
   * imported: it lives in lib/sms/consent.ts next to the gate that enforces it,
   * and that module pulls in the service-role Supabase client.
   */
  consentCopy: string;
}) {
  const [phone, setPhone] = useState(initialPhone);
  // Unchecked on every render, including a re-render after a save. Nothing in
  // this component may default it to true.
  const [grant, setGrant] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [saved, setSaved] = useState(false);
  const [confirmOptOut, setConfirmOptOut] = useState(false);
  const [pending, startTransition] = useTransition();

  const view = texts.kind === "ready" ? consentView(texts, normalizeToE164(phone)) : null;

  function clearFeedback() {
    setSaved(false);
    setNotice(undefined);
    setFormError(undefined);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = phone.trim();
    if (!trimmed) {
      setError("Required");
      return;
    }
    if (!isValidPhone(trimmed)) {
      setError("Enter a valid phone number");
      return;
    }
    if (grant && !normalizeToE164(trimmed)) {
      setError(UNREADABLE);
      return;
    }
    setError(undefined);
    setFormError(undefined);
    setNotice(undefined);
    const fd = new FormData();
    fd.append("phone", trimmed);
    // Only a ticked box is posted at all, mirroring a native checkbox. The
    // server treats an absent field as "don't grant" — never as "revoke".
    if (grant) fd.append("consentStudent", "on");
    startTransition(async () => {
      const res = await savePhoneAction(null, fd);
      if (res.ok) {
        setSaved(true);
        setNotice(res.notice);
        // Drop the tick. The page revalidates and the section below switches to
        // its "texts are on" state from the server's snapshot, so leaving it
        // checked would show the same permission twice.
        setGrant(false);
      } else {
        setFormError(res.error ?? "Something went wrong — please try again.");
      }
    });
  }

  function handleOptOut() {
    clearFeedback();
    // The dialog stays open, with its buttons disabled, until the revoke has
    // actually landed. Closing first would show the opt-out succeeding before
    // we know it did, and a failed suppression that looks like a success is the
    // one outcome here nobody would think to check.
    startTransition(async () => {
      const res = await optOutAction();
      setConfirmOptOut(false);
      if (res.ok) setNotice(res.notice);
      else setFormError(res.error ?? "Something went wrong — please try again.");
    });
  }

  return (
    <>
      <form onSubmit={handleSubmit} className="mt-6 space-y-5" noValidate>
        <div>
          <Label htmlFor="phone" required>
            Phone number{" "}
            <span aria-hidden className="text-phosphor-ink">
              *
            </span>
          </Label>
          <Input
            id="phone"
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            error={error}
            value={phone}
            onChange={(e) => {
              setPhone(e.target.value);
              clearFeedback();
              if (error) setError(undefined);
            }}
            placeholder="+1 (555) 123-4567"
            maxLength={30}
            required
            aria-required
          />
          <FieldError id="phone-error">{error}</FieldError>
          {texts.kind === "ready" && <NumberEcho raw={phone} />}
        </div>

        {texts.kind === "under_age" && (
          <p className="text-xs text-ink-soft">
            We don&rsquo;t offer texts to students under 13, so we&rsquo;ll keep
            reaching you by email — and through your parent or guardian&rsquo;s
            email. Your number is only used to call you about the program.
          </p>
        )}

        {texts.kind === "ready" && view && (
          <fieldset className="border-t border-line pt-5">
            <legend className="font-mono text-xs font-medium uppercase tracking-wider text-ink">
              Text messages
            </legend>
            <p className="mt-1.5 text-sm text-ink-soft">
              Optional, and separate from saving your number. Nothing about
              your place in the program depends on it.
              {!texts.live && (
                <>
                  {" "}
                  We haven&rsquo;t started sending texts yet — if you turn them
                  on now, the first one will arrive once we do.
                </>
              )}
            </p>
            <div className="mt-4">
              {view.kind === "granted" ? (
                <OptedIn
                  since={view.since}
                  pending={pending}
                  onOptOut={() => setConfirmOptOut(true)}
                />
              ) : view.kind === "stopped" ? (
                <p className="rounded-lg border border-line bg-paper p-4 text-sm text-ink-soft">
                  This number turned texts off on{" "}
                  <LocalTime value={view.at} mode="date" className="text-ink" />.
                  To turn them back on, reply <strong>START</strong> to any text
                  you&rsquo;ve had from us, from this phone.
                </p>
              ) : (
                <ConsentBox
                  checked={grant}
                  onChange={(next) => {
                    setGrant(next);
                    clearFeedback();
                  }}
                  copy={consentCopy}
                  view={view}
                  disabled={pending}
                />
              )}
            </div>
          </fieldset>
        )}

        {formError && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">
            {formError}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={pending}>
            {pending ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                Saving…
              </span>
            ) : saved ? (
              "Update number"
            ) : (
              "Save phone number"
            )}
          </Button>
          {saved && !pending && (
            <span className="inline-flex items-center gap-1.5 text-sm font-medium text-phosphor-ink">
              <Check className="h-4 w-4" />
              {notice ?? "Saved — thank you!"}
            </span>
          )}
          {!saved && notice && !pending && (
            <span className="text-sm text-phosphor-ink">{notice}</span>
          )}
        </div>
      </form>

      <ConfirmDialog
        open={confirmOptOut}
        destructive
        pending={pending}
        title="Stop texting you?"
        description={
          <span className="text-sm text-ink-soft">
            We&rsquo;ll stop every text to this number straight away, including
            program updates — we&rsquo;ll reach you by email instead. You can
            turn texts back on from this page whenever you like.
          </span>
        }
        confirmLabel="Turn texts off"
        cancelLabel="Keep texts on"
        onConfirm={handleOptOut}
        onCancel={() => setConfirmOptOut(false)}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

const UNREADABLE =
  "We couldn't read that number well enough to text it. Include the area code — or the country code with a + if it's outside the US or Canada.";

/**
 * What the form should render for the number's consent.
 *
 * `granted` is deliberately narrow: it requires a snapshot, requires it to
 * belong to the number currently in the field, and requires program-text
 * consent on it. Anything else falls through to a checkbox, because a screen
 * that says "texts are on" next to a number nobody agreed to is worse than
 * asking twice. `changed` is the same thing with an explanation attached — the
 * field no longer holds the number on file.
 */
type ConsentView =
  | { kind: "granted"; since: string | null }
  | { kind: "stopped"; at: string }
  | { kind: "revoked"; at: string }
  | { kind: "changed" }
  | { kind: "needed" };

function consentView(
  texts: Extract<TextsState, { kind: "ready" }>,
  typedE164: string | null,
): ConsentView {
  const { savedE164, consent } = texts;
  if (typedE164 && savedE164 && typedE164 !== savedE164) return { kind: "changed" };
  if (!consent || !savedE164 || typedE164 !== savedE164) return { kind: "needed" };
  // An opt-out outranks the purpose flag, exactly as the transport reads it.
  if (consent.optedOutAt) {
    return consent.liftableHere
      ? { kind: "revoked", at: consent.optedOutAt }
      : { kind: "stopped", at: consent.optedOutAt };
  }
  return consent.transactional
    ? { kind: "granted", since: consent.lastOptedInAt }
    : { kind: "needed" };
}

/**
 * The number as we will actually dial it, echoed under the field.
 *
 * Shown with the country code visible: the whole point of the echo is that the
 * reader checks every digit, and "(555) 123-4567" alone hides the +1 that
 * normalization just inferred.
 */
function NumberEcho({ raw }: { raw: string }) {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const e164 = normalizeToE164(trimmed);
  if (!e164) return null;

  if (!isReachableByTollFree(e164)) {
    // Toll-free traffic leaves the North American Numbering Plan and is dropped
    // by the carrier while still reporting as sent. Saying so here is the only
    // place this is honest rather than mysterious.
    return (
      <p className="mt-1.5 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-300">
        <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0" />
        <span>
          We can only text US and Canadian numbers, so we&rsquo;ll email you
          instead. We&rsquo;ll still keep{" "}
          <span className="font-mono">{e164}</span> on file to call you.
        </span>
      </p>
    );
  }
  return (
    <p className="mt-1.5 text-xs text-ink-soft">
      We&rsquo;d text{" "}
      <span className="font-mono text-ink">+1 {formatE164(e164)}</span>
    </p>
  );
}

/**
 * The disclosure and its checkbox.
 *
 * `copy` is rendered as a single text node inside the label — not split across
 * elements, not truncated, not behind a "read more". A reviewer has to be able
 * to screenshot the checkbox and the words it governs together, and a screen
 * reader has to announce the whole sentence as the control's name.
 *
 * The policy links sit outside the label on purpose: an anchor inside a label
 * is a click target that toggles the box when you meant to read the policy.
 */
function ConsentBox({
  checked,
  onChange,
  copy,
  view,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  copy: string;
  view: ConsentView;
  disabled: boolean;
}) {
  return (
    <div className="rounded-lg border border-line bg-paper p-4">
      {view.kind === "revoked" && (
        <p className="mb-3 text-xs text-ink-soft">
          You turned texts off on{" "}
          <LocalTime value={view.at} mode="date" className="text-ink" />. Tick
          the box and save to turn them back on.
        </p>
      )}
      {view.kind === "changed" && (
        <p className="mb-3 text-xs text-ink-soft">
          That&rsquo;s a different number from the one on file, so texts need
          turning on for the new one.
        </p>
      )}
      <label htmlFor="consent-student" className="flex cursor-pointer gap-3">
        <input
          id="consent-student"
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0 accent-phosphor"
        />
        <span className="text-sm leading-relaxed text-ink-soft">{copy}</span>
      </label>
      <p className="mt-3 pl-7 text-xs text-ink-faint">
        <Link href="/privacy" className="text-phosphor-ink underline">
          Privacy Policy
        </Link>
        {" · "}
        <Link href="/texts" className="text-phosphor-ink underline">
          Text message terms
        </Link>
      </p>
    </div>
  );
}

/** Current state for a number that has opted in, plus the way out. */
function OptedIn({
  since,
  pending,
  onOptOut,
}: {
  since: string | null;
  pending: boolean;
  onOptOut: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-phosphor/40 bg-phosphor/[0.06] px-4 py-3">
      <span className="inline-flex items-center gap-1.5 text-sm font-medium text-phosphor-ink">
        <ShieldCheck className="h-4 w-4" />
        Texts are on
      </span>
      {since && (
        <span className="text-xs text-ink-soft">
          since <LocalTime value={since} mode="date" className="text-ink" />
        </span>
      )}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="ml-auto"
        disabled={pending}
        onClick={onOptOut}
      >
        Turn texts off
      </Button>
    </div>
  );
}
