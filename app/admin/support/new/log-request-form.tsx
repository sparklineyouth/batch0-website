"use client";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { AlertTriangle, Loader2, Lock, UserCheck, UserX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FieldError, Input, Label, Select, Textarea } from "@/components/ui/input";
import { getActionError } from "@/lib/action-error";
import {
  logSupportRequest,
  lookUpRequester,
  type RequesterLookup,
} from "@/app/admin/support/actions";
import {
  CATEGORY_GROUPS,
  CATEGORY_LABELS,
  CHANNEL_LABELS,
  PRIORITY_LABELS,
  REQUESTER_NAME_MAX,
  STAFF_LOG_CHANNELS,
  TICKET_BODY_MAX,
  TICKET_BODY_MIN,
  TICKET_PRIORITIES,
  TICKET_SUBJECT_MAX,
  checkStaffReceivedAt,
  codePointLength,
  defaultPriorityFor,
  easternLocalToIso,
  formatReceivedAt,
  isSensitiveCategory,
  parseCategory,
  toEasternLocalInput,
  toPriority,
  type StaffLogChannel,
  type TicketCategory,
  type TicketPriority,
} from "@/lib/support-access";
import { EMAIL_MAX, looksLikeEmail } from "./requester-email";

/**
 * The "log a request" form: a request that reached the team by email, by
 * phone or some other way, filed as a ticket like any other.
 *
 * The field that matters most is the arrival time. Email to the team inbox is
 * a binding refund channel, and the 48 hours in the refund policy stop when
 * the request arrived — not when someone got round to logging it — so the
 * time is entered as New York wall time (the zone batch0 runs on, whatever
 * zone this laptop is in) and previewed in the words the requester's receipt
 * will use.
 *
 * The address is looked up as it's typed, only so the form can say whose
 * request this becomes: an account's, which then also shows on their
 * dashboard, or the address alone, followed through the emailed link.
 * logSupportRequest matches the address again when it files; nothing the
 * lookup said is trusted later.
 *
 * Success is a redirect to the new request, which also says whether the
 * confirmation went (`?logged=`). Only a refusal comes back here.
 */

type Field = "email" | "receivedAt" | "category" | "body";

/** Validation order, top to bottom, so focus goes to the first problem. */
const FIELD_IDS: Record<Field, string> = {
  email: "log-email",
  receivedAt: "log-received",
  category: "log-category",
  body: "log-body",
};

type Lookup =
  | { status: "idle" }
  | { status: "looking"; email: string }
  | { status: "found"; email: string; account: NonNullable<RequesterLookup["account"]> }
  | { status: "none"; email: string }
  | { status: "failed"; email: string; message: string };

/** The body counter appears once a paste gets this close to the cap. */
const BODY_COUNTER_FROM = Math.floor(TICKET_BODY_MAX * 0.8);

export function LogRequestForm({
  canSeeSensitive,
  defaultReceivedAt,
  earliestReceivedAt,
  initialEmail = "",
  initialName = "",
}: {
  /** support.sensitive: may log a confidential concern. The action refuses it otherwise. */
  canSeeSensitive: boolean;
  /**
   * "Now" as New York wall time, worked out by the page — a clock read here
   * would differ between the server render and hydration.
   */
  defaultReceivedAt: string;
  /** The oldest arrival time the action accepts, same format. */
  earliestReceivedAt: string;
  /** From `?email=` — e.g. "Log a request for them" on a person's page. Looked up on mount. */
  initialEmail?: string;
  /** From `?name=`. */
  initialName?: string;
}) {
  const [email, setEmail] = useState(initialEmail);
  const [name, setName] = useState(initialName);
  const [channel, setChannel] = useState<StaffLogChannel>("email");
  const [receivedAt, setReceivedAt] = useState(defaultReceivedAt);
  // The picker's upper bound. It starts at the page's "now" and is moved up
  // whenever the field is touched: a form left open over lunch must still
  // accept the email that arrived during it.
  const [latest, setLatest] = useState(defaultReceivedAt);
  const [category, setCategory] = useState<TicketCategory | null>(null);
  // null = follow the category's default. Once someone picks a priority it
  // stays theirs, even if they change the category afterwards.
  const [priority, setPriority] = useState<TicketPriority | null>(null);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sendConfirmation, setSendConfirmation] = useState(true);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<Field, string>>>({});
  const [err, setErr] = useState<string | undefined>();
  const [lookup, setLookup] = useState<Lookup>({ status: "idle" });
  const [pending, start] = useTransition();

  // The preview of the recorded time is formatted by Intl, and the server's
  // ICU and the browser's don't always punctuate a date the same way. Shown
  // after hydration only, so they never have to agree.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  // --- the account lookup -------------------------------------------------

  // `lookedUp` is the address the current answer (or question) is about, so a
  // blur after the debounce doesn't ask twice; `seq` drops an answer that
  // arrives after a newer question.
  const lookedUp = useRef<string | null>(null);
  const seq = useRef(0);

  const lookUp = useCallback((raw: string) => {
    const address = raw.trim().toLowerCase();
    if (!looksLikeEmail(address) || address === lookedUp.current) return;
    lookedUp.current = address;
    const mine = ++seq.current;
    setLookup({ status: "looking", email: address });
    lookUpRequester({ email: address }).then(
      (res) => {
        if (mine !== seq.current) return;
        if (!res.ok) setLookup({ status: "failed", email: address, message: res.error });
        else if (res.data?.account) {
          setLookup({ status: "found", email: address, account: res.data.account });
        } else setLookup({ status: "none", email: address });
      },
      () => {
        if (mine !== seq.current) return;
        // Only a lost connection lands here — the action returns its
        // refusals. Forget the address so the next blur asks again.
        lookedUp.current = null;
        setLookup({
          status: "failed",
          email: address,
          message: "Couldn't check that address just now. You can still log the request.",
        });
      },
    );
  }, []);

  // A linked address is looked up straight away; a typed one once typing
  // pauses (and on blur, below).
  useEffect(() => {
    if (initialEmail) lookUp(initialEmail);
  }, [initialEmail, lookUp]);
  useEffect(() => {
    const t = setTimeout(() => lookUp(email), 600);
    return () => clearTimeout(t);
  }, [email, lookUp]);

  // An answer about an address that has since been edited says nothing.
  const typed = email.trim().toLowerCase();
  const answer = lookup.status !== "idle" && lookup.email === typed ? lookup : null;
  const account = answer?.status === "found" ? answer.account : null;

  // --- the rest -------------------------------------------------------------

  function clearError(field: Field) {
    setFieldErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }

  function chooseCategory(value: string) {
    const next = parseCategory(value);
    // The disabled option can't be picked, but a select is only a suggestion
    // to a determined keyboard — and the action refuses it regardless.
    if (!next || (isSensitiveCategory(next) && !canSeeSensitive)) return;
    setCategory(next);
    clearError("category");
  }

  function setToNow() {
    const now = toEasternLocalInput(Date.now());
    setLatest(now);
    setReceivedAt(now);
    clearError("receivedAt");
  }

  const receivedIso = easternLocalToIso(receivedAt);
  const defaultPriority = category ? defaultPriorityFor(category) : null;
  const shownPriority: TicketPriority = priority ?? defaultPriority ?? "normal";
  const bodyLength = codePointLength(body.trim());

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    setErr(undefined);
    // The action checks every one of these again; checking here keeps a
    // pasted email on screen with the problem next to it instead of a round
    // trip away.
    const problems: Partial<Record<Field, string>> = {};
    if (!looksLikeEmail(email)) problems.email = "Enter the email address the request came from.";
    const timeProblem = checkStaffReceivedAt(receivedIso);
    if (timeProblem) problems.receivedAt = timeProblem;
    if (!category) problems.category = "Choose what kind of request it is.";
    if (bodyLength < TICKET_BODY_MIN) {
      problems.body = `Paste the request itself — at least ${TICKET_BODY_MIN} characters.`;
    } else if (bodyLength > TICKET_BODY_MAX) {
      problems.body = `Keep it under ${TICKET_BODY_MAX.toLocaleString("en-US")} characters — paste the part that matters.`;
    }
    setFieldErrors(problems);
    const firstProblem = (Object.keys(FIELD_IDS) as Field[]).find((f) => problems[f]);
    if (firstProblem) {
      document.getElementById(FIELD_IDS[firstProblem])?.focus();
      return;
    }

    start(async () => {
      try {
        const res = await logSupportRequest({
          email: email.trim(),
          name: name.trim() || null,
          channel,
          receivedAt,
          category: category!,
          // null lets the server apply the category's default — the same
          // value the select is showing.
          priority,
          subject: subject.trim() || null,
          body,
          sendConfirmation,
        });
        // Success redirects to the new request; reaching here means it
        // didn't go through.
        if (!res.ok) setErr(res.error);
      } catch (e) {
        // The redirect itself arrives here as a rejection. getActionError
        // throws it back to Next, which navigates. Anything else means no
        // answer came back — possibly after the request was filed — so the
        // form stays filled in and the message doesn't invite a blind retry
        // that would log it twice.
        setErr(
          `${getActionError(e, "No answer came back")} — it may or may not have been logged. Check the queue before trying again.`,
        );
      }
    });
  }

  return (
    <form onSubmit={submit} noValidate className="grid gap-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="log-email" required>
            Their email
          </Label>
          <Input
            id="log-email"
            type="email"
            inputMode="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              clearError("email");
            }}
            onBlur={() => lookUp(email)}
            placeholder="parent@example.com"
            maxLength={EMAIL_MAX}
            autoComplete="off"
            spellCheck={false}
            error={fieldErrors.email}
            disabled={pending}
          />
          <FieldError id="log-email-error">{fieldErrors.email}</FieldError>
          {/* Always mounted, so a screen reader hears the answer arrive. */}
          <div aria-live="polite" className="mt-1.5 text-xs">
            {answer?.status === "looking" && (
              <p className="flex items-center gap-1.5 text-ink-faint">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                Checking for a batch0 account…
              </p>
            )}
            {answer?.status === "found" && (
              <p className="flex items-start gap-1.5 text-ink-soft">
                <UserCheck className="mt-px h-3.5 w-3.5 shrink-0 text-phosphor-ink" aria-hidden />
                <span>
                  On batch0:{" "}
                  <span className="font-medium text-ink">
                    {answer.account.name ?? answer.account.email}
                  </span>{" "}
                  · {answer.account.roleLabel}. It&rsquo;ll show on their dashboard too.
                </span>
              </p>
            )}
            {answer?.status === "none" && (
              <p className="flex items-start gap-1.5 text-ink-soft">
                <UserX className="mt-px h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden />
                <span>
                  No account with this address —{" "}
                  {sendConfirmation
                    ? "they'll follow the request from the emailed link."
                    : "your first reply emails them their thread link."}
                </span>
              </p>
            )}
            {answer?.status === "failed" && (
              <p className="flex items-start gap-1.5 text-amber-700 dark:text-amber-300">
                <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
                <span>{answer.message}</span>
              </p>
            )}
          </div>
        </div>

        <div>
          <Label htmlFor="log-name">
            Their name{" "}
            <span className="normal-case tracking-normal text-ink-faint">(optional)</span>
          </Label>
          <Input
            id="log-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={account?.name ?? "As they signed it"}
            maxLength={REQUESTER_NAME_MAX}
            autoComplete="off"
            disabled={pending}
          />
          <p className="mt-1.5 text-xs text-ink-faint">
            {account
              ? "Leave it blank to use the name on their account."
              : "Mostly for someone without an account — a parent, say."}
          </p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <fieldset>
          <legend className="mb-1.5 block font-mono text-xs font-medium uppercase tracking-wider text-ink-soft">
            How it reached us
          </legend>
          <div className="flex flex-wrap gap-1.5">
            {STAFF_LOG_CHANNELS.map((c) => (
              <label
                key={c}
                className={`press flex h-10 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-phosphor/40 ${
                  channel === c
                    ? "border-ink bg-wash text-ink"
                    : "border-line bg-paper text-ink-soft hover:border-ink/30"
                }`}
              >
                <input
                  type="radio"
                  name="channel"
                  value={c}
                  checked={channel === c}
                  onChange={() => setChannel(c)}
                  disabled={pending}
                  className="h-4 w-4 shrink-0 accent-phosphor focus:outline-none"
                />
                {CHANNEL_LABELS[c]}
              </label>
            ))}
          </div>
        </fieldset>

        <div>
          <Label htmlFor="log-received" required>
            When it arrived{" "}
            <span className="normal-case tracking-normal text-ink-faint">(New York time)</span>
          </Label>
          <div className="flex gap-2">
            <Input
              id="log-received"
              type="datetime-local"
              value={receivedAt}
              min={earliestReceivedAt}
              max={latest}
              onFocus={() => setLatest(toEasternLocalInput(Date.now()))}
              onChange={(e) => {
                setReceivedAt(e.target.value);
                clearError("receivedAt");
              }}
              error={fieldErrors.receivedAt}
              disabled={pending}
            />
            <Button variant="secondary" onClick={setToNow} disabled={pending}>
              Now
            </Button>
          </div>
          <FieldError id="log-received-error">{fieldErrors.receivedAt}</FieldError>
          <p className="mt-1.5 text-xs text-ink-faint">
            {hydrated && receivedIso && !fieldErrors.receivedAt ? (
              <>
                Recorded as{" "}
                <span className="text-ink-soft">{formatReceivedAt(receivedIso)}</span>.
              </>
            ) : (
              "When the email landed or the call came in, not when you're logging it."
            )}
          </p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="log-category" required>
            Kind of request
          </Label>
          <Select
            id="log-category"
            value={category ?? ""}
            onChange={(e) => chooseCategory(e.target.value)}
            error={fieldErrors.category}
            disabled={pending}
          >
            <option value="" disabled>
              Choose one…
            </option>
            {CATEGORY_GROUPS.map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.categories.map((c) => {
                  const locked = isSensitiveCategory(c) && !canSeeSensitive;
                  return (
                    <option key={c} value={c} disabled={locked}>
                      {CATEGORY_LABELS[c]}
                      {locked ? " (needs confidential access)" : ""}
                    </option>
                  );
                })}
              </optgroup>
            ))}
          </Select>
          <FieldError id="log-category-error">{fieldErrors.category}</FieldError>
          {!canSeeSensitive && (
            <p className="mt-1.5 text-xs text-ink-faint">
              A safety, harassment or wellbeing report goes to someone who can
              see confidential concerns. Hand it to them — filed under another
              kind, the whole team could read it.
            </p>
          )}
        </div>

        <div>
          <Label htmlFor="log-priority">Priority</Label>
          <Select
            id="log-priority"
            value={shownPriority}
            onChange={(e) => setPriority(toPriority(e.target.value))}
            disabled={pending || !category}
          >
            {TICKET_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABELS[p]}
              </option>
            ))}
          </Select>
          <p className="mt-1.5 text-xs text-ink-faint">
            {!defaultPriority ? (
              "Set by the kind of request — choose that first."
            ) : priority && priority !== defaultPriority ? (
              <>
                Usually {PRIORITY_LABELS[defaultPriority].toLowerCase()} for this kind.{" "}
                <button
                  type="button"
                  onClick={() => setPriority(null)}
                  disabled={pending}
                  className="link-ink"
                >
                  Use that
                </button>
              </>
            ) : (
              "The usual for this kind of request. Change it if you know better."
            )}
          </p>
        </div>
      </div>

      {/* What the chosen kind needs said before it's filed. */}
      {category === "refund" && (
        <p
          role="note"
          className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm leading-relaxed text-amber-800 dark:text-amber-200"
        >
          The 48 hours stop at the time it arrived. Set &ldquo;When it
          arrived&rdquo; to when the email or call came in, not to now — that
          is the time the refund window is checked against.
        </p>
      )}
      {category === "concern" && (
        <p
          role="note"
          className="flex items-start gap-2 rounded-lg border border-line bg-wash px-4 py-3 text-sm leading-relaxed text-ink-soft"
        >
          <Lock className="mt-1 h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden />
          <span>
            Confidential from the moment it&rsquo;s logged: only staff who can
            see confidential concerns can open it, and the team alert and bells
            carry no content.
          </span>
        </p>
      )}

      <div>
        <Label htmlFor="log-subject">
          Subject{" "}
          <span className="normal-case tracking-normal text-ink-faint">(optional)</span>
        </Label>
        <Input
          id="log-subject"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="Their email's subject line, or one line on what they need"
          maxLength={TICKET_SUBJECT_MAX}
          autoComplete="off"
          disabled={pending}
        />
        <p className="mt-1.5 text-xs text-ink-faint">
          Leave it blank to use the first line of the request.
        </p>
      </div>

      <div>
        <Label htmlFor="log-body" required>
          The request
        </Label>
        {/* No maxLength: the browser would silently cut a long pasted thread
            short, and nobody would notice the end was missing. The counter
            and the check say so instead. */}
        <Textarea
          id="log-body"
          value={body}
          onChange={(e) => {
            setBody(e.target.value);
            clearError("body");
          }}
          rows={10}
          error={fieldErrors.body}
          disabled={pending}
          placeholder={
            channel === "email"
              ? "Paste the email — the whole message, as they sent it."
              : channel === "phone"
                ? "What they asked for, as close to their words as you can, and anything you told them on the call."
                : "What they asked for, and how it reached you."
          }
        />
        <FieldError id="log-body-error">{fieldErrors.body}</FieldError>
        <div className="mt-1.5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-xs text-ink-faint">
          <p>
            It opens their thread, so they&rsquo;ll see it as their own first
            message. Keep notes for the team for an internal note afterwards.
          </p>
          {bodyLength >= BODY_COUNTER_FROM && (
            <span
              className={`shrink-0 tabular-nums ${
                bodyLength > TICKET_BODY_MAX ? "font-medium text-red-700 dark:text-red-300" : ""
              }`}
            >
              {bodyLength.toLocaleString("en-US")} / {TICKET_BODY_MAX.toLocaleString("en-US")}
            </span>
          )}
        </div>
      </div>

      <label className="flex cursor-pointer select-none items-start gap-2.5 text-sm">
        <input
          type="checkbox"
          checked={sendConfirmation}
          onChange={(e) => setSendConfirmation(e.target.checked)}
          disabled={pending}
          className="mt-0.5 h-4 w-4 shrink-0 accent-phosphor"
        />
        <span>
          <span className="font-medium text-ink">
            Email them a confirmation with their thread link
          </span>
          <span className="mt-0.5 block text-xs text-ink-faint">
            {sendConfirmation
              ? "The reference, the recorded arrival time and a private link to follow the request — the same receipt as one filed on the site."
              : "No email now. Your first reply sends them the thread link."}
          </span>
        </span>
      </label>

      {err && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {err}
        </p>
      )}

      <div>
        <Button type="submit" disabled={pending} aria-busy={pending}>
          {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          {pending ? "Logging…" : "Log request"}
        </Button>
      </div>
    </form>
  );
}
