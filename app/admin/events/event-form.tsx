"use client";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { FieldError, Input, Label, Select, Textarea } from "@/components/ui/input";
import { getActionError } from "@/lib/action-error";
import {
  DEFAULT_AUDIENCE_MODE,
  formatBytes,
  isDeckFile,
  MAX_UPLOAD_BYTES,
  type AudienceMode,
} from "@/lib/webinars";
import {
  durationLabel,
  durationOf,
  durationOptions,
  DEFAULT_DURATION_MINUTES,
  EVENT_TYPE_LABEL,
  EVENT_TYPES,
  fromLocalInput,
  nextRoundHour,
  toLocalInput,
  validateEventFields,
  whoFromRow,
  type EventFieldErrors,
  type EventType,
} from "@/lib/event-form";
import { saveEvent } from "./actions";
import {
  discardDeckUpload,
  fetchWebinarExtras,
  getDeckUploadToken,
  removeWebinarAsset,
  saveSpeakers,
} from "./webinar-actions";
import { SpeakersEditor, type SpeakerDraft } from "./speakers-editor";
import type { StagedDeck } from "./deck";
import type { AdminEventRow, CohortOption } from "./types";
import { FileText, Loader2, Upload, X } from "lucide-react";

const CHAT_OPTIONS: { value: AudienceMode; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "moderated", label: "Moderated" },
  { value: "private", label: "Off" },
];

type SavedDeck = { id: string; filename: string; sizeBytes: number | null };

/**
 * Create or edit an event. Title and time are all a new event needs; the rest
 * defaults sensibly or sits under "More options".
 */
export function EventForm({
  event,
  cohorts,
  defaultCohortId,
  onClose,
  onSaved,
}: {
  event: AdminEventRow | null;
  cohorts: CohortOption[];
  defaultCohortId: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = !event;
  // Set once the event exists (an edit, or a new event after its first save
  // when something still needs attention), so a second Save updates it.
  const [eventId, setEventId] = useState<string | null>(event?.id ?? null);
  // A new event's id, minted by the first slide upload.
  const [draftId, setDraftId] = useState<string | null>(null);

  const [title, setTitle] = useState(event?.title ?? "");
  const [startsLocal, setStartsLocal] = useState(() =>
    toLocalInput(event ? event.startsAt : nextRoundHour()),
  );
  const initialDuration = event
    ? durationOf(event.startsAt, event.endsAt)
    : DEFAULT_DURATION_MINUTES;
  const [duration, setDuration] = useState(initialDuration);
  const [liveMode, setLiveMode] = useState<"hosted" | "external">(
    event?.liveMode ?? "hosted",
  );
  const [externalUrl, setExternalUrl] = useState(event?.externalUrl ?? "");
  const [who, setWho] = useState(() =>
    event
      ? whoFromRow({ visibility: event.visibility, cohort_id: event.cohortId }, defaultCohortId)
      : defaultCohortId
        ? `cohort:${defaultCohortId}`
        : "public",
  );
  const [notify, setNotify] = useState(isNew);

  const [description, setDescription] = useState(event?.description ?? "");
  const [type, setType] = useState<EventType>(event?.type ?? "webinar");
  const [typeTouched, setTypeTouched] = useState(!isNew);
  const [location, setLocation] = useState(event?.location ?? "");
  const [audienceMode, setAudienceMode] = useState<AudienceMode>(
    event?.audienceMode ?? DEFAULT_AUDIENCE_MODE,
  );
  const [autoRecord, setAutoRecord] = useState(event?.autoRecord ?? true);
  const [autoShare, setAutoShare] = useState(event?.autoShare ?? true);
  const [recordingUrl, setRecordingUrl] = useState(event?.recordingUrl ?? "");

  const [savedDeck, setSavedDeck] = useState<SavedDeck | null>(null);
  const [stagedDeck, setStagedDeck] = useState<StagedDeck | null>(null);
  const [uploading, setUploading] = useState(false);
  const [confirmRemoveDeck, setConfirmRemoveDeck] = useState(false);

  const [speakers, setSpeakers] = useState<SpeakerDraft[]>([]);
  const [speakersLoaded, setSpeakersLoaded] = useState(isNew);
  const [speakersDirty, setSpeakersDirty] = useState(false);

  const [errors, setErrors] = useState<EventFieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  // Speakers and slides for an existing event. Until this lands, Save leaves
  // the speaker list alone (saveSpeakers replaces the whole list).
  useEffect(() => {
    if (!event) return;
    let cancelled = false;
    void fetchWebinarExtras(event.id).then((r) => {
      if (cancelled || !r.ok || !r.data) return;
      setSpeakers(
        r.data.speakers.map((sp) => ({
          id: sp.id,
          name: sp.name,
          title: sp.title ?? "",
          email: sp.email ?? "",
          linkUrl: sp.linkUrl ?? "",
          bio: sp.bio ?? "",
          photoUrl: sp.photoUrl ?? "",
          userId: sp.userId,
        })),
      );
      setSpeakersLoaded(true);
      const d = r.data.deck;
      if (d) setSavedDeck({ id: d.id, filename: d.filename, sizeBytes: d.sizeBytes });
    });
    return () => {
      cancelled = true;
    };
  }, [event?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const staffOnly = who === "staff";
  const hosted = liveMode === "hosted";
  const startsIso = fromLocalInput(startsLocal);
  const inPast =
    !!startsIso &&
    new Date(startsIso).getTime() < Date.now() - 60_000 &&
    (isNew || startsIso !== event?.startsAt);

  function pickWhere(mode: "hosted" | "external") {
    setLiveMode(mode);
    if (!typeTouched) setType(mode === "hosted" ? "webinar" : "other");
  }

  async function pickDeck(file: File) {
    setFormError(null);
    if (!isDeckFile(file.name, file.type)) {
      setFormError("Slides have to be a PDF. Export them as PDF and try again.");
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setFormError(`That file is ${formatBytes(file.size)}. The limit is 2 GB.`);
      return;
    }
    setUploading(true);
    try {
      const token = await getDeckUploadToken(eventId ?? draftId, file.name);
      if (!token.ok || !token.data) throw new Error(token.ok ? "Try again." : token.error);
      const { eventId: forId, path, token: t } = token.data;
      const { createClient } = await import("@/lib/supabase/client");
      const { error } = await createClient()
        .storage.from("webinar-media")
        .uploadToSignedUrl(path, t, file, { contentType: "application/pdf" });
      if (error) throw error;
      if (!eventId) setDraftId(forId);
      setStagedDeck({
        storagePath: path,
        filename: file.name,
        mimeType: "application/pdf",
        sizeBytes: file.size,
      });
    } catch (e) {
      setFormError(getActionError(e));
    } finally {
      setUploading(false);
    }
  }

  function dropStagedDeck() {
    const staged = stagedDeck;
    const forId = eventId ?? draftId;
    setStagedDeck(null);
    if (staged && forId) void discardDeckUpload(forId, staged.storagePath);
  }

  async function removeSavedDeck() {
    if (!eventId || !savedDeck) return;
    setConfirmRemoveDeck(false);
    const r = await removeWebinarAsset(eventId, savedDeck.id);
    if (!r.ok) setFormError(r.error);
    else setSavedDeck(null);
  }

  function cancel() {
    if (stagedDeck) dropStagedDeck();
    onClose();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pending || uploading) return;
    setFormError(null);
    setWarning(null);
    const fieldErrors = validateEventFields({
      title,
      startsAt: startsIso,
      durationMinutes: duration,
      liveMode,
      externalUrl,
      recordingUrl,
      who,
    });
    setErrors(fieldErrors);
    if (Object.keys(fieldErrors).length > 0) {
      if (fieldErrors.title) titleRef.current?.focus();
      return;
    }
    setPending(true);
    try {
      const r = await saveEvent({
        id: eventId,
        draftId: eventId ? null : draftId,
        title,
        startsAt: startsIso!,
        durationMinutes: duration,
        liveMode,
        externalUrl,
        who,
        notify: notify && !staffOnly,
        description,
        type,
        location,
        audienceMode,
        autoRecord: hosted && autoRecord,
        autoShare: !staffOnly && autoShare,
        recordingUrl,
        deck: hosted ? stagedDeck : null,
      });
      if (!r.ok || !r.data) {
        setFormError(r.ok ? "Couldn't save. Try again." : r.error);
        return;
      }
      const id = r.data.id;
      setEventId(id);
      setNotify(false);
      let problem = r.data.warning ?? null;
      if (!problem && stagedDeck) {
        setSavedDeck({ id: "", filename: stagedDeck.filename, sizeBytes: stagedDeck.sizeBytes });
        setStagedDeck(null);
      }
      if (hosted && speakersLoaded && speakersDirty) {
        const sr = await saveSpeakers(
          id,
          speakers.map((sp, i) => ({
            id: sp.id,
            name: sp.name,
            title: sp.title || null,
            bio: sp.bio || null,
            email: sp.email || null,
            photoUrl: sp.photoUrl || null,
            linkUrl: sp.linkUrl || null,
            sortOrder: i,
          })),
        );
        if (!sr.ok) problem = `Saved the event, but not the speakers: ${sr.error}`;
        else setSpeakersDirty(false);
      }
      if (problem) {
        setWarning(problem);
        return;
      }
      onSaved();
    } catch (err) {
      setFormError(getActionError(err));
    } finally {
      setPending(false);
    }
  }

  const busy = pending || uploading;

  return (
    <form onSubmit={submit} noValidate className="space-y-5">
      <h2 className="font-display text-2xl text-ink">{isNew ? "New event" : "Edit event"}</h2>

      <div>
        <Label htmlFor="ev-title">Title</Label>
        <Input
          id="ev-title"
          ref={titleRef}
          value={title}
          maxLength={200}
          error={errors.title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Pitch practice"
        />
        <FieldError id="ev-title-error">{errors.title}</FieldError>
      </div>

      <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
        <div>
          <Label htmlFor="ev-start">When</Label>
          <Input
            id="ev-start"
            type="datetime-local"
            value={startsLocal}
            error={errors.startsAt}
            onChange={(e) => setStartsLocal(e.target.value)}
          />
          <FieldError id="ev-start-error">{errors.startsAt}</FieldError>
          {!errors.startsAt && inPast && (
            <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">That time has passed.</p>
          )}
        </div>
        <div>
          <Label htmlFor="ev-duration">Length</Label>
          <Select
            id="ev-duration"
            value={duration}
            error={errors.duration}
            onChange={(e) => setDuration(Number(e.target.value))}
          >
            {durationOptions(initialDuration).map((m) => (
              <option key={m} value={m}>
                {durationLabel(m)}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <fieldset>
        <legend className="mb-1.5 block font-mono text-xs font-medium uppercase tracking-wider text-ink-soft">
          Where
        </legend>
        <div className="inline-flex rounded-md border border-line p-0.5" role="radiogroup">
          {(
            [
              ["hosted", "batch0 video room"],
              ["external", "External link"],
            ] as const
          ).map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={liveMode === mode}
              onClick={() => pickWhere(mode)}
              className={`rounded px-3 py-1.5 text-sm ${
                liveMode === mode ? "bg-phosphor text-on-phosphor" : "text-ink-soft hover:text-ink"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {!hosted && (
          <div className="mt-3">
            <Label htmlFor="ev-url">Link</Label>
            <Input
              id="ev-url"
              type="url"
              inputMode="url"
              placeholder="https://zoom.us/j/…"
              value={externalUrl}
              error={errors.externalUrl}
              onChange={(e) => setExternalUrl(e.target.value)}
            />
            <FieldError id="ev-url-error">{errors.externalUrl}</FieldError>
          </div>
        )}
      </fieldset>

      <div>
        <Label htmlFor="ev-who">Who</Label>
        <Select
          id="ev-who"
          value={who}
          error={errors.who}
          onChange={(e) => {
            setWho(e.target.value);
            if (e.target.value === "staff") setNotify(false);
          }}
        >
          {cohorts.map((c) => (
            <option key={c.id} value={`cohort:${c.id}`}>
              {c.name}
            </option>
          ))}
          <option value="public">Everyone signed in</option>
          <option value="staff">Staff only (rehearsal)</option>
        </Select>
        <FieldError id="ev-who-error">{errors.who}</FieldError>
      </div>

      {!staffOnly && (
        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            className="h-4 w-4 accent-[#ffbb00]"
            checked={notify}
            onChange={(e) => setNotify(e.target.checked)}
          />
          {isNew ? "Notify now" : "Notify about this change"}
        </label>
      )}

      <details className="group rounded-md border border-line">
        <summary className="cursor-pointer select-none px-3 py-2.5 text-sm text-ink-soft hover:text-ink">
          More options
        </summary>
        <div className="space-y-4 border-t border-line p-3">
          <div>
            <Label htmlFor="ev-desc">Description</Label>
            <Textarea
              id="ev-desc"
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="ev-type">Type</Label>
              <Select
                id="ev-type"
                value={type}
                onChange={(e) => {
                  setType(e.target.value as EventType);
                  setTypeTouched(true);
                }}
              >
                {EVENT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {EVENT_TYPE_LABEL[t]}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="ev-location">Location</Label>
              <Input
                id="ev-location"
                value={location}
                placeholder="Online"
                onChange={(e) => setLocation(e.target.value)}
              />
            </div>
          </div>

          {hosted ? (
            <>
              <div>
                <Label htmlFor="ev-chat">Chat</Label>
                <Select
                  id="ev-chat"
                  value={audienceMode}
                  onChange={(e) => setAudienceMode(e.target.value as AudienceMode)}
                >
                  {CHAT_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
                {audienceMode === "moderated" && (
                  <p className="mt-1 text-xs text-ink-faint">Hosts approve each message.</p>
                )}
              </div>
              <Check checked={autoRecord} onChange={setAutoRecord}>
                Record automatically
              </Check>
              {!staffOnly && (
                <Check checked={autoShare} onChange={setAutoShare}>
                  Email the recording and slides afterwards
                </Check>
              )}

              <div>
                <Label>Slides (PDF)</Label>
                {savedDeck ? (
                  <FileRow
                    name={savedDeck.filename}
                    size={savedDeck.sizeBytes}
                    disabled={busy || !savedDeck.id}
                    onRemove={() => setConfirmRemoveDeck(true)}
                  />
                ) : stagedDeck ? (
                  <FileRow
                    name={stagedDeck.filename}
                    size={stagedDeck.sizeBytes}
                    disabled={busy}
                    onRemove={dropStagedDeck}
                  />
                ) : (
                  <label
                    className={`flex items-center justify-center gap-2 rounded-md border border-dashed border-line px-4 py-4 text-sm ${
                      busy ? "cursor-not-allowed opacity-60" : "cursor-pointer text-ink-soft hover:text-ink"
                    }`}
                  >
                    {uploading ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Upload className="h-4 w-4" />
                    )}
                    {uploading ? "Uploading…" : "Add slides"}
                    <input
                      type="file"
                      className="hidden"
                      accept=".pdf,application/pdf"
                      disabled={busy}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        e.target.value = "";
                        if (f) void pickDeck(f);
                      }}
                    />
                  </label>
                )}
                <p className="mt-1 text-xs text-ink-faint">Present them in the room.</p>
              </div>

              <details className="rounded-md border border-line">
                <summary className="cursor-pointer select-none px-3 py-2 text-sm text-ink-soft hover:text-ink">
                  Guest speakers{speakers.length ? ` (${speakers.length})` : ""}
                </summary>
                <div className="border-t border-line p-3">
                  {speakersLoaded ? (
                    <SpeakersEditor
                      eventId={eventId}
                      speakers={speakers}
                      disabled={busy}
                      onChange={(next) => {
                        setSpeakers(next);
                        setSpeakersDirty(true);
                      }}
                    />
                  ) : (
                    <p className="text-xs text-ink-faint">Loading…</p>
                  )}
                </div>
              </details>
            </>
          ) : (
            <div>
              <Label htmlFor="ev-recording">Recording link</Label>
              <Input
                id="ev-recording"
                type="url"
                inputMode="url"
                placeholder="https://"
                value={recordingUrl}
                error={errors.recordingUrl}
                onChange={(e) => setRecordingUrl(e.target.value)}
              />
              <FieldError id="ev-recording-error">{errors.recordingUrl}</FieldError>
            </div>
          )}
        </div>
      </details>

      {formError && <FieldError>{formError}</FieldError>}
      {warning && (
        <p role="status" className="text-xs text-amber-700 dark:text-amber-400">
          {warning}
        </p>
      )}

      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>
          {pending ? "Saving…" : "Save"}
        </Button>
        <Button variant="ghost" onClick={cancel} disabled={pending}>
          {warning ? "Done" : "Cancel"}
        </Button>
      </div>

      <ConfirmDialog
        open={confirmRemoveDeck}
        title="Remove the slides?"
        description={<p>{savedDeck?.filename} is deleted now.</p>}
        confirmLabel="Remove"
        destructive
        onConfirm={() => void removeSavedDeck()}
        onCancel={() => setConfirmRemoveDeck(false)}
      />
    </form>
  );
}

function Check({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-ink">
      <input
        type="checkbox"
        className="h-4 w-4 accent-[#ffbb00]"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {children}
    </label>
  );
}

function FileRow({
  name,
  size,
  disabled,
  onRemove,
}: {
  name: string;
  size: number | null;
  disabled: boolean;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-line px-3 py-2">
      <span className="flex min-w-0 items-center gap-2 text-sm text-ink-soft">
        <FileText className="h-4 w-4 shrink-0 text-phosphor-ink" />
        <span className="truncate">{name}</span>
        {size ? <span className="shrink-0 text-xs text-ink-faint">{formatBytes(size)}</span> : null}
      </span>
      <button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        className="rounded-md p-1 text-ink-faint hover:text-ink disabled:opacity-40"
        aria-label={`Remove ${name}`}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
