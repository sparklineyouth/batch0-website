"use client";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Input, Textarea, Label, FieldError } from "@/components/ui/input";
import { Toggle } from "@/components/ui/toggle";
import { LocalTime } from "@/components/ui/local-time";
import { getActionError } from "@/lib/action-error";
import {
  AUDIENCE_MODES,
  DECK_EXTENSIONS,
  DECK_MIME_TYPES,
  MAX_UPLOAD_BYTES,
  formatBytes,
  isDeckFile,
  type AudienceMode,
} from "@/lib/webinars";
import {
  getWebinarUploadToken,
  registerWebinarAsset,
  removeWebinarAsset,
  sendSpeakerInvite,
  speakerInviteLink,
} from "@/app/admin/events/webinar-actions";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Copy,
  FileText,
  Mail,
  Film,
  Loader2,
  Plus,
  Upload,
  X,
} from "lucide-react";

/**
 * The webinar half of the admin event form.
 *
 * Split out of events-manager.tsx rather than grown inside it, for a reason
 * that is about the event form and not about file length: everything in here
 * is inert for the overwhelming majority of events. A demo day has no
 * audience mode, no premiere, no guest speakers and no deck, and the version
 * of this form that showed all of it inline had eleven controls that did
 * nothing on most of the events it was used to edit. An admin who scrolls
 * past a setting nine times out of ten is an admin who does not read it the
 * tenth.
 *
 * This component owns NO part of the event. It is a pure function of `value`
 * plus an `onChange` — the parent holds the draft, the parent saves it, and
 * the parent decides whether to render this at all. Holding a private copy of
 * `audienceMode` here is exactly the bug that makes a form show `private`
 * while the row that gets written says `open`, so there is no `useState` in
 * here that shadows a field of `WebinarFieldsValue`. Local state is confined
 * to two things that genuinely have no home in the draft: how far an upload
 * has got, and what went wrong.
 *
 * Uploads are the one place this component talks to the server on its own,
 * and that is deliberate rather than an oversight in the contract. A file is
 * already in storage the moment the bytes finish moving — there is nothing
 * for "save event" to do with it afterwards, and staging a 500 MB premiere in
 * browser memory until the admin presses Save is how you lose it to a tab
 * crash forty minutes later. So an upload registers its asset immediately and
 * hands the parent the row through `onChange`, and the parent's job is only
 * to keep the list it is given. That is also why uploads are disabled until
 * the event has an id: an asset row needs an event to point at.
 *
 * What this deliberately does NOT do:
 *
 *   - it does not validate the event. `starts_at`, the title, the cohort and
 *     the visibility are the parent's, and a second opinion about them here
 *     would be a second opinion to keep in step;
 *   - it does not decide anything about privacy. `audienceMode` is a value it
 *     collects and nothing more — the guarantee is enforced in RLS and in
 *     what the server chooses to send, and a component that started making
 *     its own decisions about who may see whom would be a fourth place for
 *     that rule to drift;
 *   - it does not delete a speaker's account or an uploaded file from
 *     storage. Removing a speaker row here removes a per-event grant; the
 *     person keeps whatever access they had before it.
 */

export type WebinarFieldsValue = {
  audienceMode: AudienceMode;
  autoRecord: boolean;
  autoShare: boolean;
  liveMode: "external" | "hosted" | "premiere";
  /** Length of the premiere recording. Filled in by the upload, not typed. */
  premiereSeconds: number | null;
  /** A `datetime-local` string, in the admin's own timezone, or null. */
  qaOpensAt: string | null;
  speakers: SpeakerDraft[];
  /**
   * Have the event's existing speakers been read back yet?
   *
   * False for a saved event until `fetchWebinarExtras` lands. The parent MUST
   * NOT call `saveSpeakers` while it is false: that action replaces the whole
   * list, so writing the empty seed would delete every guest speaker the event
   * already had. True immediately for a new event, which has none to lose.
   */
  speakersLoaded: boolean;
  assets: AssetDraft[];
};

export type SpeakerDraft = {
  id?: string;
  name: string;
  title: string;
  bio: string;
  email: string;
  photoUrl: string;
  linkUrl: string;
  /**
   * The account that claimed this slot, when the parent knows of one.
   *
   * Optional and read-only here — this form cannot create it and must not
   * pretend to. Its only job is to tell an admin whether the invite has
   * landed, because "I added them and they still can't start the room" is
   * otherwise an invisible state.
   */
  userId?: string | null;
};

export type AssetDraft = {
  id?: string;
  kind: "deck" | "handout" | "premiere";
  storagePath: string;
  filename: string;
  mimeType: string | null;
  sizeBytes: number | null;
  durationSeconds: number | null;
};

/**
 * The three modes, with the copy an admin actually reads.
 *
 * The descriptions are plain English about consequences and say nothing about
 * the implementation, because the person choosing is picking a promise to
 * make to a room of students — several of whom are minors — and "moderated"
 * on its own does not tell them what a student will see. `AUDIENCE_MODES`
 * orders them; this map only supplies words, so adding a fourth mode to
 * lib/webinars.ts surfaces here as a missing key rather than a silently
 * absent option.
 */
const AUDIENCE_COPY: Record<AudienceMode, { label: string; description: string }> = {
  private: {
    label: "Private",
    description:
      "Students see only their own questions. No chat. Nobody can tell who else is watching.",
  },
  moderated: {
    label: "Moderated",
    description:
      "Students can chat and ask questions. Nothing reaches the room until you approve it.",
  },
  open: {
    label: "Open",
    description:
      "Everyone sees every message and who sent it. Best for a cohort call, not a public webinar.",
  },
};

const LIVE_MODE_COPY: {
  value: WebinarFieldsValue["liveMode"];
  label: string;
  description: string;
}[] = [
  {
    value: "external",
    label: "External link",
    description:
      "Students leave batch0 to join. Nothing on this page applies to the call itself.",
  },
  {
    value: "hosted",
    label: "Live on batch0",
    description:
      "You broadcast from your browser and students watch here, on the site.",
  },
  {
    value: "premiere",
    label: "Premiere",
    description:
      "A recording plays to everyone at the same moment, then hands over to you for live Q&A.",
  },
];

/** A blank speaker row. A name is the only thing that has to be filled in. */
function emptySpeaker(): SpeakerDraft {
  return { name: "", title: "", bio: "", email: "", photoUrl: "", linkUrl: "" };
}

/** "40 min", "1 h 12 min" — the shape a schedule is read in, not seconds. */
function formatDuration(seconds: number | null): string {
  if (!seconds || !Number.isFinite(seconds)) return "";
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.round((total - hours * 3600) / 60);
  if (hours > 0) return minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`;
  return `${Math.max(1, minutes)} min`;
}

export function WebinarFields({
  value,
  onChange,
  eventId,
  disabled,
  startsAt,
  visibility,
}: {
  value: WebinarFieldsValue;
  onChange: (next: WebinarFieldsValue) => void;
  /** Null for an unsaved event — uploads are disabled until it has an id. */
  eventId: string | null;
  disabled?: boolean;
  /**
   * The event's start, as the parent currently has it in the form.
   *
   * Optional, and only ever used to draw the premiere's read-only schedule
   * line. It is read from the live form state rather than from the saved row
   * on purpose: an admin who moves the start time is usually moving it
   * *because* of what that line says, and a line computed from the row on
   * disk would keep describing the old plan until they pressed Save.
   */
  startsAt?: string | null;
  /**
   * The event's visibility, as the parent's draft has it. Read for one thing:
   * a `staff` rehearsal never emails a follow-up (the save forces auto_share
   * off and the follow-up job skips it), so "Share afterwards" is shown off
   * and disabled rather than offered and silently ignored.
   */
  visibility?: string;
}) {
  const [error, setError] = useState<string | undefined>();
  // Which file is in flight and how far along, or null. Not part of the
  // draft: an interrupted upload has no row to save, so there is nothing here
  // the parent could usefully keep.
  const [upload, setUpload] = useState<
    { kind: AssetDraft["kind"]; filename: string; percent: number } | null
  >(null);
  const [removingPath, setRemovingPath] = useState<string | null>(null);
  const [removing, startRemoving] = useTransition();
  /**
   * The asset an admin has clicked the X on, waiting on a confirmation.
   *
   * `removeWebinarAsset` deletes the bytes out of the bucket there and then —
   * it is not staged until Save and there is no undo — so a single mis-aimed
   * click on a row that reads "premiere.mp4" used to destroy a 2 GB upload an
   * admin had spent forty minutes pushing over hotel wifi. Holding the row
   * here instead of calling straight through is what puts a sentence between
   * the click and the deletion.
   */
  const [confirmDrop, setConfirmDrop] = useState<AssetDraft | null>(null);
  /**
   * The mode an admin has selected while the room is still `private`, pending
   * a confirmation. See `pickAudienceMode` for why only that direction asks.
   */
  const [confirmMode, setConfirmMode] = useState<AudienceMode | null>(null);

  /**
   * The draft, readable from a callback that was created in an older render.
   *
   * `patch` used to close over `value`, and an upload is the one thing in this
   * form that finishes long after the click that started it. Arm the deck
   * picker and the premiere picker in the same minute and the second upload to
   * land would call `onChange` with the `value` that was current when IT
   * started — the one without the other upload's asset row — silently erasing
   * a row from the form while it stayed in the database, so the event saved
   * with no deck and an orphaned deck row nobody could see or remove. Reading
   * through a ref means every patch is applied to the draft as it stands now,
   * not as it stood when the file was picked.
   */
  const valueRef = useRef(value);
  valueRef.current = value;

  /**
   * Whether an upload has the slot, checked and claimed SYNCHRONOUSLY.
   *
   * The state below drives the disabled attributes, and state is exactly one
   * render too late to stop the second pick: `pickPremiere` awaits the video's
   * metadata before it ever calls `setUpload`, so for that half-second the
   * deck picker is still live and a second upload could start against the same
   * form. A ref is the only thing a click handler can test and set in the same
   * tick.
   */
  const uploadingRef = useRef(false);
  const [uploadBusy, setUploadBusy] = useState(false);

  /**
   * The request currently pushing bytes, so it can be cancelled.
   *
   * `putWithProgress` used to keep its `XMLHttpRequest` entirely private,
   * which meant a form unmounted mid-upload — Save, Cancel, a click on another
   * event in the list — left half a gigabyte still climbing the wire on a
   * component nobody could see, with every later `setUpload`/`setError` going
   * nowhere. Aborting on unmount stops the transfer instead of orphaning it.
   */
  const xhrRef = useRef<XMLHttpRequest | null>(null);

  const busy = !!disabled || !!upload || uploadBusy || removing;

  const patch = useCallback(
    (next: Partial<WebinarFieldsValue>) =>
      onChange({ ...valueRef.current, ...next }),
    [onChange],
  );

  // Kill the transfer when the form goes away. Without this the XHR outlives
  // its component: the bytes keep uploading, the asset never gets registered
  // (the code that would do it is gone), and the admin is billed a gigabyte of
  // egress for a file no row will ever point at.
  useEffect(() => {
    return () => {
      xhrRef.current?.abort();
      xhrRef.current = null;
    };
  }, []);

  // A reload during a premiere upload is ten minutes of someone's evening, and
  // browsers give us exactly one chance to say so. Keyed on the boolean rather
  // than on `upload` itself, because that object is replaced on every progress
  // tick and would otherwise re-register this listener a hundred times a file.
  const uploading = !!upload;
  useEffect(() => {
    if (!uploading) return;
    const warn = (ev: BeforeUnloadEvent) => {
      ev.preventDefault();
      // Legacy spelling: Firefox and older Chrome still want returnValue set,
      // and the string itself is ignored by every current browser.
      ev.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [uploading]);

  /** Take the single upload slot, or explain why it is not free. */
  function claimUploadSlot(): boolean {
    if (uploadingRef.current) {
      setError(
        "One upload at a time — wait for the one in progress to finish, then pick the next file.",
      );
      return false;
    }
    uploadingRef.current = true;
    setUploadBusy(true);
    return true;
  }

  function releaseUploadSlot() {
    uploadingRef.current = false;
    setUploadBusy(false);
  }

  const deck = value.assets.find((a) => a.kind === "deck") ?? null;
  const premiere = value.assets.find((a) => a.kind === "premiere") ?? null;

  /**
   * When the recording stops and the host takes over.
   *
   * Mirrors the precedence in `premiereState`: an explicit `qaOpensAt` wins,
   * and without one the handover is simply the end of the recording. Kept in
   * a memo so the line does not recompute a Date on every keystroke in an
   * unrelated field — and computed from the same two inputs the server will
   * use, so what an admin reads here is what the room will do.
   *
   * `invalid` closes a schedule that cannot happen. A `qaOpensAt` at or before
   * the start means the room hands over to live Q&A at the same instant the
   * premiere is meant to begin, so the recording an admin just uploaded never
   * plays a frame — and because an explicit handover WINS over the recording's
   * length, the mistake is silent: the form used to render that impossible
   * schedule in the confirmation line as if it were the plan, so the first
   * sign of it was an audience watching a black screen at 7pm. A datetime
   * typed a day out, or a start time moved later after the handover was set,
   * is how it gets there.
   */
  const schedule = useMemo(() => {
    const start = startsAt ? new Date(startsAt) : null;
    if (!start || Number.isNaN(start.getTime())) return null;
    const explicit = value.qaOpensAt ? new Date(value.qaOpensAt) : null;
    const explicitValid = explicit && !Number.isNaN(explicit.getTime());
    if (explicitValid && explicit!.getTime() <= start.getTime()) {
      return { start, handover: null, invalid: true };
    }
    const handover = explicitValid
      ? explicit
      : value.premiereSeconds
        ? new Date(start.getTime() + value.premiereSeconds * 1000)
        : null;
    return { start, handover, invalid: false };
  }, [startsAt, value.qaOpensAt, value.premiereSeconds]);

  /**
   * Put the bytes in the bucket, then register the row.
   *
   * Two upload paths, and the difference is the whole reason this function
   * takes `withProgress`. Everything else in the repo uploads through
   * supabase-js's `uploadToSignedUrl`, which is a single await with no
   * progress events — perfectly fine for a 4 MB deck, where the spinner is
   * gone before anyone looks at it. A premiere is the only upload in the repo
   * big enough that the absence of a percentage is itself the bug: half a
   * gigabyte over a conference-centre connection is ten minutes of a form
   * that looks hung, and a hung-looking form gets reloaded. So the premiere
   * goes up over `XMLHttpRequest`, which is still the only browser API that
   * reports request-body progress.
   */
  async function uploadAsset(
    file: File,
    kind: AssetDraft["kind"],
    withProgress: boolean,
    durationSeconds: number | null,
  ) {
    // The slot is claimed by the caller, before its own awaits — but an
    // eventless form can still get here, and leaving the flag set would jam
    // every later pick behind an upload that never started.
    if (!eventId) {
      releaseUploadSlot();
      return;
    }
    setError(undefined);
    setUpload({ kind, filename: file.name, percent: 0 });
    try {
      const { path, token, signedUrl } = await getWebinarUploadToken(
        eventId,
        kind,
        file.name,
      );

      if (withProgress) {
        await putWithProgress(
          signedUrl,
          file,
          (percent) => setUpload((u) => (u ? { ...u, percent } : u)),
          // Handed out so the unmount cleanup can abort it. See `xhrRef`.
          (xhr) => {
            xhrRef.current = xhr;
          },
        );
      } else {
        // Deferred import keeps supabase-js out of the route's first-load JS;
        // it's only needed here, at the moment an upload starts.
        const { createClient } = await import("@/lib/supabase/client");
        const supabase = createClient();
        const { error: putError } = await supabase.storage
          .from(BUCKET)
          .uploadToSignedUrl(path, token, file);
        if (putError) throw putError;
      }

      const saved = await registerWebinarAsset(eventId, {
        kind,
        storagePath: path,
        filename: file.name,
        mimeType: file.type || null,
        sizeBytes: file.size,
        durationSeconds,
      });

      /*
        Rebuilt field by field rather than spread, and `kind` comes from what
        we asked for rather than from the row.

        `EventAsset` carries a fourth kind this form has no business holding:
        `recording`, which is written by the recorder from inside the live
        room, one row per two-minute segment. A form that spread the server's
        row into its asset list would type-widen to include it, and the first
        person to open a finished webinar in the editor would find eleven
        recording segments listed under "Slides" with an X beside each one.
        Narrowing here keeps the draft to the three kinds an admin uploads.
      */
      const asset: AssetDraft = {
        id: saved.id,
        kind,
        storagePath: saved.storagePath,
        filename: saved.filename,
        mimeType: saved.mimeType,
        sizeBytes: saved.sizeBytes,
        durationSeconds: saved.durationSeconds,
      };

      // A deck and a premiere are one-per-event, so the new row replaces any
      // existing one of the same kind rather than stacking beside it — two
      // premieres in the list would leave the room with no way to say which
      // one plays.
      // Read through the ref, not through the render's `value`: by the time
      // this line runs the admin may have finished a second upload, and the
      // captured `value` would write that row back out of existence.
      patch({
        assets: [...valueRef.current.assets.filter((a) => a.kind !== kind), asset],
        ...(kind === "premiere" ? { premiereSeconds: durationSeconds } : {}),
      });
    } catch (e: any) {
      setError(getActionError(e));
    } finally {
      xhrRef.current = null;
      releaseUploadSlot();
      setUpload(null);
    }
  }

  function pickDeck(file: File) {
    // Claimed first, before anything else in the handler, so two pickers armed
    // at once cannot both get through. Released on every path that does not
    // reach `uploadAsset`'s `finally`.
    if (!claimUploadSlot()) return;
    setError(undefined);
    if (!isDeckFile(file.name, file.type)) {
      releaseUploadSlot();
      setError(
        `“${file.name}” isn't a deck. Upload a PDF, a .pptx or a .ppt — anything else can't be shown or emailed afterwards.`,
      );
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      releaseUploadSlot();
      setError(tooBigMessage(file));
      return;
    }
    void uploadAsset(file, "deck", false, null);
  }

  async function pickPremiere(file: File) {
    // Claimed synchronously, above the `await` below: reading the video's
    // metadata takes long enough for an admin to click the deck picker too,
    // and the state that disables it has not rendered yet.
    if (!claimUploadSlot()) return;
    setError(undefined);
    // Checked before a single byte moves. The bucket's own limit is the one
    // that binds, but it rejects at the END of the upload — which on a 4 GB
    // file is a ten-minute wait for a failure that was knowable instantly.
    if (file.size > MAX_UPLOAD_BYTES) {
      releaseUploadSlot();
      setError(tooBigMessage(file));
      return;
    }
    const durationSeconds = await readVideoDuration(file);
    if (durationSeconds === null) {
      releaseUploadSlot();
      setError(
        `The browser couldn't read “${file.name}” as a video. Upload an MP4 or a WebM — the premiere needs a length to schedule the handover to Q&A.`,
      );
      return;
    }
    void uploadAsset(file, "premiere", true, durationSeconds);
  }

  /**
   * The X on a file row. Asks first, for everything that is really in storage.
   *
   * An unregistered row (no id) can only exist if the parent put it there —
   * nothing was uploaded, so there is nothing to delete and nothing to warn
   * about; it is dropped from the draft on the spot.
   */
  function requestDrop(asset: AssetDraft) {
    setError(undefined);
    if (!eventId || !asset.id) {
      patch({
        assets: valueRef.current.assets.filter((a) => a !== asset),
        ...(asset.kind === "premiere" ? { premiereSeconds: null } : {}),
      });
      return;
    }
    setConfirmDrop(asset);
  }

  function dropAsset(asset: AssetDraft) {
    setError(undefined);
    if (!eventId || !asset.id) return;
    const id = asset.id;
    setRemovingPath(asset.storagePath);
    startRemoving(async () => {
      try {
        await removeWebinarAsset(eventId, id);
        // Filtered out of the current draft rather than the one captured when
        // the X was clicked — an upload that finished in between must survive
        // the delete of an unrelated file.
        patch({
          assets: valueRef.current.assets.filter((a) => a.id !== id),
          ...(asset.kind === "premiere" ? { premiereSeconds: null } : {}),
        });
      } catch (e: any) {
        setError(getActionError(e));
      } finally {
        setRemovingPath(null);
      }
    });
  }

  function setSpeaker(index: number, next: Partial<SpeakerDraft>) {
    patch({
      speakers: value.speakers.map((s, i) => (i === index ? { ...s, ...next } : s)),
    });
  }

  /**
   * Reorder by button rather than by drag.
   *
   * The order is the order speakers are listed on the event page, so it is
   * worth being able to change — but drag-and-drop would be a dependency, a
   * keyboard story and a touch story for a list that is almost always two
   * rows long. Two buttons are reorderable by keyboard for free.
   */
  function moveSpeaker(index: number, delta: -1 | 1) {
    const target = index + delta;
    if (target < 0 || target >= value.speakers.length) return;
    const next = [...value.speakers];
    [next[index], next[target]] = [next[target], next[index]];
    patch({ speakers: next });
  }

  const uploadsReady = !!eventId;

  /**
   * Is there anything for the follow-up to send?
   *
   * This used to be `autoRecord` alone, which made "email the slides
   * afterwards" unreachable: the follow-up cron
   * (app/api/cron/webinar-followups/route.ts) sends when there is a recording
   * OR a deck/handout, so a webinar with a deck and no recording is a perfectly
   * ordinary thing to want to share — and the form refused to let anyone ask
   * for it. Worse, the recording toggle force-cleared `autoShare` on its way
   * off, so opening a saved event and flicking recording off and on again
   * destroyed a sharing setting the admin never touched.
   */
  const hasShareableDoc = value.assets.some(
    (a) => a.kind === "deck" || a.kind === "handout",
  );
  const staffOnly = visibility === "staff";
  const canAutoShare = !staffOnly && (value.autoRecord || hasShareableDoc);

  /**
   * Per-speaker invite state: which row is busy, and the last thing that
   * happened to each ("Link copied", "Invite sent", or an error). Local on
   * purpose — none of it belongs in the draft, and none of it is saved.
   */
  const [inviteBusy, setInviteBusy] = useState<string | null>(null);
  const [inviteNote, setInviteNote] = useState<
    Record<string, { ok: boolean; text: string }>
  >({});

  /**
   * Copy a guest's claim link, or email it to them.
   *
   * Both go through the server: `speakerInviteLink` mints the URL from the
   * token the list never carries (0084 revokes the column from every browser
   * role), and `sendSpeakerInvite` emails the address on the SAVED row, never
   * one typed here — so an edited-but-unsaved email is not where it goes, and
   * the note says to save first. Both refuse once the slot is claimed.
   *
   * These existed server-side with no caller, so a guest speaker could never
   * actually receive the link that makes them a host.
   */
  async function speakerInvite(speakerId: string, how: "copy" | "send") {
    if (!eventId) return;
    setInviteBusy(speakerId);
    try {
      if (how === "copy") {
        const url = await speakerInviteLink(eventId, speakerId);
        await navigator.clipboard.writeText(url);
        setInviteNote((n) => ({
          ...n,
          [speakerId]: {
            ok: true,
            text: "Link copied. It works once, for whoever opens it signed in.",
          },
        }));
      } else {
        await sendSpeakerInvite(eventId, speakerId);
        setInviteNote((n) => ({
          ...n,
          [speakerId]: { ok: true, text: "Invite sent to the saved email." },
        }));
      }
    } catch (e: any) {
      setInviteNote((n) => ({
        ...n,
        [speakerId]: { ok: false, text: getActionError(e) },
      }));
    } finally {
      setInviteBusy(null);
    }
  }

  /**
   * Moving away from Private is the one change worth stopping to confirm.
   *
   * Not because it is irreversible — it is not, and the old copy here claiming
   * so was simply wrong: 0084 gates a question's and a message's visibility on
   * `approved_at is not null`, and nothing asked while the room was Private is
   * ever stamped, so widening the mode cannot retroactively publish anything.
   * It is worth confirming because it is the moment a room of students — some
   * of them minors — starts seeing each other's names on messages from then
   * on. Narrowing back to Private needs no dialog: it only ever hides things.
   */
  function pickAudienceMode(mode: AudienceMode) {
    if (mode === value.audienceMode) return;
    if (value.audienceMode === "private") {
      setConfirmMode(mode);
      return;
    }
    patch({ audienceMode: mode });
  }

  return (
    <div className="space-y-5 rounded-2xl border border-line bg-wash p-4">
      <div>
        {/* Size, not weight: .font-display ships one weight and globals.css
            pins font-weight to 400, so a bold class here would be inert. */}
        <h4 className="font-display text-xl tracking-[-0.01em] text-ink">
          Webinar
        </h4>
        <p className="mt-1 text-xs text-ink-faint">
          Only applies when students watch on batch0. An external link ignores
          all of it.
        </p>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Audience mode                                                       */}
      {/* ------------------------------------------------------------------ */}
      <fieldset disabled={busy} className="disabled:opacity-60">
        <legend className="mb-1.5 block font-mono text-xs font-medium uppercase tracking-wider text-ink-soft">
          What the audience can see of itself
        </legend>
        {/*
          What this paragraph used to say — that the choice "cannot be taken
          back" — was not true, and it was frightening admins about the wrong
          thing while saying nothing about what actually changes. A question or
          a message is shown to the room only when `approved_at` is set (0084),
          and nothing sent while the room was Private is ever stamped, so
          widening the mode publishes nothing that was already said. What it
          does do is change the room from this point on, which is the thing the
          person choosing actually needs to know.
        */}
        <p className="mb-2.5 text-xs text-ink-faint">
          This applies from the moment you save it. Questions and messages
          already in the room stay exactly as they were sent — nothing asked
          under Private becomes visible later — and switching back to Private
          hides the chat again. Private is what every webinar did before this
          setting existed, and is still the right answer for anything public.
        </p>
        <div className="space-y-2">
          {AUDIENCE_MODES.map((mode) => {
            const copy = AUDIENCE_COPY[mode];
            const active = value.audienceMode === mode;
            return (
              <label
                key={mode}
                className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 ${
                  active
                    ? "border-phosphor/50 bg-phosphor/10"
                    : "border-line bg-paper"
                }`}
              >
                <input
                  type="radio"
                  name="audience-mode"
                  className="mt-0.5 h-4 w-4 accent-[#ffbb00]"
                  checked={active}
                  onChange={() => pickAudienceMode(mode)}
                />
                <span className="min-w-0">
                  <span
                    className={`block text-sm font-medium ${
                      active ? "text-phosphor-ink" : "text-ink"
                    }`}
                  >
                    {copy.label}
                  </span>
                  <span className="mt-0.5 block text-xs text-ink-soft">
                    {copy.description}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      {/* ------------------------------------------------------------------ */}
      {/* How the video gets to the room                                      */}
      {/* ------------------------------------------------------------------ */}
      <div>
        <Label>How it runs</Label>
        <nav className="flex gap-1 overflow-x-auto rounded-xl border border-line bg-wash p-1">
          {LIVE_MODE_COPY.map((m) => {
            const active = value.liveMode === m.value;
            return (
              <button
                key={m.value}
                type="button"
                disabled={busy}
                onClick={() => patch({ liveMode: m.value })}
                className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-medium transition disabled:opacity-50 ${
                  active
                    ? "bg-phosphor/15 text-phosphor-ink"
                    : "text-ink-soft hover:text-ink"
                }`}
              >
                {m.label}
              </button>
            );
          })}
        </nav>
        <p className="mt-1.5 text-xs text-ink-faint">
          {LIVE_MODE_COPY.find((m) => m.value === value.liveMode)?.description}
        </p>
      </div>

      {value.liveMode === "premiere" && (
        <div className="space-y-3 rounded-xl border border-line bg-paper p-3">
          <div>
            <Label>Premiere recording</Label>
            <p className="text-xs text-ink-faint">
              Everyone is positioned at the same offset from the wall clock, so
              a student who arrives twenty minutes late joins twenty minutes
              in. That is what makes it read as live rather than as a video
              they pressed play on.
            </p>
            {premiere ? (
              <AssetRow
                asset={premiere}
                removing={removing && removingPath === premiere.storagePath}
                disabled={busy}
                onRemove={() => requestDrop(premiere)}
              />
            ) : (
              <FilePicker
                icon={<Film className="h-4 w-4" />}
                label="Pick the recording"
                accept="video/*"
                disabled={busy || !uploadsReady}
                onPick={(f) => void pickPremiere(f)}
              />
            )}
          </div>

          {/*
            The warning, not a blocked Save. A premiere scheduled for next
            Sunday with the video still rendering is a perfectly ordinary state
            to save in — what is not ordinary is discovering it at the start
            time, so it is said here every time the form is open.
          */}
          {!premiere && (
            <div className="flex items-start gap-2.5 rounded-xl border border-amber-500/40 bg-amber-400/10 p-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <p className="text-xs text-ink-soft">
                No recording uploaded yet. As it stands, students arriving at
                the start time see a waiting screen until a host goes live.
              </p>
            </div>
          )}

          <div>
            <Label htmlFor="qa-opens-at">Hand over to Q&amp;A at (optional)</Label>
            <Input
              id="qa-opens-at"
              type="datetime-local"
              disabled={busy}
              value={value.qaOpensAt ?? ""}
              onChange={(ev) => patch({ qaOpensAt: ev.target.value || null })}
            />
            {/* Said here, beside the field that caused it, rather than left to
                the confirmation line below — which now refuses to draw an
                impossible schedule at all. */}
            {schedule?.invalid && (
              <FieldError>
                Q&amp;A can&apos;t start before the premiere does — the recording
                would never play.
              </FieldError>
            )}
            <p className="mt-1.5 text-xs text-ink-faint">
              Leave blank to hand over the moment the recording ends. Set it for
              a talk that runs short of the hour you promised. Either way, going
              live early overrides it — the schedule yields to a host on camera.
            </p>
          </div>

          {/* Read-only, and computed from exactly the two values the server
              resolves the phase from, so the line cannot describe a plan the
              room will not follow. */}
          {schedule?.handover && (
            <p className="rounded-md border border-line bg-wash px-3 py-2.5 text-xs text-ink-soft">
              Plays from <LocalTime value={schedule.start} mode="datetime-short" />{" "}
              and hands over to live Q&amp;A at{" "}
              <LocalTime value={schedule.handover} mode="datetime-short" />
              {value.premiereSeconds ? (
                <span className="text-ink-faint">
                  {" "}
                  · {formatDuration(value.premiereSeconds)} of recording
                </span>
              ) : null}
            </p>
          )}
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Deck                                                                */}
      {/* ------------------------------------------------------------------ */}
      <div>
        <Label>Slides (optional)</Label>
        <p className="text-xs text-ink-faint">
          Attached to the event and, if you turn on sharing below, emailed out
          with the recording afterwards.
        </p>
        {deck ? (
          <AssetRow
            asset={deck}
            removing={removing && removingPath === deck.storagePath}
            disabled={busy}
            onRemove={() => requestDrop(deck)}
          />
        ) : (
          <FilePicker
            icon={<Upload className="h-4 w-4" />}
            label="Pick a deck"
            // Both lists, because browsers disagree about pptx: some send the
            // long OpenXML type, some send application/octet-stream, and a
            // file dragged out of a zip arrives with an empty type. Extensions
            // alone would miss a renamed export; MIME alone would hide half
            // the admin's real files from the picker.
            accept={DECK_EXTENSIONS.join(",") + "," + DECK_MIME_TYPES.join(",")}
            disabled={busy || !uploadsReady}
            onPick={pickDeck}
          />
        )}
      </div>

      {!uploadsReady && (
        <p className="text-xs text-ink-faint">
          Save the event once and the uploads open up — a file has to belong to
          something before it can be stored.
        </p>
      )}

      {upload && (
        <div className="rounded-xl border border-line bg-paper p-3">
          <div className="flex items-center gap-2 text-xs text-ink-soft">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-phosphor-ink" />
            <span className="truncate">Uploading {upload.filename}</span>
            <span className="ml-auto shrink-0 font-mono text-[10px] text-ink-faint">
              {upload.percent}%
            </span>
          </div>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-wash">
            <div
              className="h-full rounded-full bg-phosphor transition-[width]"
              style={{ width: `${upload.percent}%` }}
            />
          </div>
          {/* Says out loud what the in-flight guard enforces, so a picker that
              refuses a second file is not read as the form ignoring a click. */}
          <p className="mt-2 text-xs text-ink-faint">
            Leave this tab open until it finishes. The other uploads are on hold
            until then — one file at a time.
          </p>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Speakers                                                            */}
      {/* ------------------------------------------------------------------ */}
      <div>
        <Label>Guest speakers</Label>
        {/*
          A row here is a per-event broadcast grant and nothing more — it is
          what `canBroadcast` in lib/webinars.ts reads beside `events.manage`.
          That is the entire reason the table exists: the alternative to a
          speaker row is handing a visiting founder `events.manage`, which is
          the run of the admin panel — every cohort, every student record,
          every other event — for the forty minutes they are on camera. A row
          expires with the event, in the sense that it grants nothing anywhere
          else.
        */}
        {/*
          What a speaker CAN do in the room is broadcast and moderate (chat,
          questions, polls). What they cannot: see who is watching (they get a
          headcount, never names — audience privacy), end a room a staff host
          is running (their End only appears when no staff host is on), reopen
          an ended webinar, or record.
        */}
        <p className="text-xs text-ink-faint">
          A speaker can broadcast and moderate the chat, questions and polls in
          this room, and nothing else. They never get the admin panel, and
          never see who is watching. Save, then send each guest their invite
          link — it works once, for the signed-in account that opens it.
        </p>

        <div className="mt-3 space-y-3">
          {value.speakers.length === 0 && (
            <p className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-xs text-ink-faint">
              No guests. Admins and staff with Manage events can broadcast; add
              a speaker to give a guest the camera too.
            </p>
          )}
          {value.speakers.map((speaker, i) => (
            <div
              key={speaker.id ?? `new-${i}`}
              className="rounded-xl border border-line bg-paper p-3"
            >
              <div className="mb-2 flex items-center gap-2">
                <span className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">
                  Speaker {i + 1}
                </span>
                {/* Only meaningful once the row is saved: an unsaved speaker
                    has not been invited yet, so "not claimed" would be true
                    and useless. */}
                {speaker.id && !speaker.userId && (
                  <span className="rounded-full border border-line px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-ink-faint">
                    Invite not claimed yet
                  </span>
                )}
                {speaker.id && speaker.userId && (
                  <span className="rounded-full border border-phosphor/40 bg-phosphor/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-phosphor-ink">
                    Claimed — can broadcast
                  </span>
                )}
                <div className="ml-auto flex items-center gap-1">
                  <button
                    type="button"
                    disabled={busy || i === 0}
                    onClick={() => moveSpeaker(i, -1)}
                    className="rounded-md p-1 text-ink-faint hover:text-ink disabled:opacity-30"
                    aria-label={`Move ${speaker.name || `speaker ${i + 1}`} up`}
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    disabled={busy || i === value.speakers.length - 1}
                    onClick={() => moveSpeaker(i, 1)}
                    className="rounded-md p-1 text-ink-faint hover:text-ink disabled:opacity-30"
                    aria-label={`Move ${speaker.name || `speaker ${i + 1}`} down`}
                  >
                    <ArrowDown className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      patch({ speakers: value.speakers.filter((_, n) => n !== i) })
                    }
                    className="rounded-md p-1 text-ink-faint hover:text-red-600 disabled:opacity-30 dark:hover:text-red-400"
                    aria-label={`Remove ${speaker.name || `speaker ${i + 1}`}`}
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor={`speaker-name-${i}`} required>
                    Name *
                  </Label>
                  <Input
                    id={`speaker-name-${i}`}
                    disabled={busy}
                    value={speaker.name}
                    onChange={(ev) => setSpeaker(i, { name: ev.target.value })}
                    placeholder="Ada Lovelace"
                  />
                </div>
                <div>
                  <Label htmlFor={`speaker-title-${i}`}>Title</Label>
                  <Input
                    id={`speaker-title-${i}`}
                    disabled={busy}
                    value={speaker.title}
                    onChange={(ev) => setSpeaker(i, { title: ev.target.value })}
                    placeholder="Founder, Analytical Engines"
                  />
                </div>
                <div>
                  <Label htmlFor={`speaker-email-${i}`}>Email</Label>
                  <Input
                    id={`speaker-email-${i}`}
                    type="email"
                    disabled={busy}
                    value={speaker.email}
                    onChange={(ev) => setSpeaker(i, { email: ev.target.value })}
                    placeholder="ada@example.com"
                  />
                  {/* The address is how the grant finds a person at all, and
                      it is staff-only downstream — lib/webinar-data.ts leaves
                      it out of every student-facing select. */}
                  <p className="mt-1.5 text-xs text-ink-faint">
                    Where the invite goes. Students never see it.
                  </p>
                </div>
                <div>
                  <Label htmlFor={`speaker-link-${i}`}>Link</Label>
                  <Input
                    id={`speaker-link-${i}`}
                    type="url"
                    disabled={busy}
                    value={speaker.linkUrl}
                    onChange={(ev) => setSpeaker(i, { linkUrl: ev.target.value })}
                    placeholder="https://…"
                  />
                </div>
              </div>
              <div className="mt-3">
                <Label htmlFor={`speaker-bio-${i}`}>Bio</Label>
                <Textarea
                  id={`speaker-bio-${i}`}
                  rows={2}
                  disabled={busy}
                  value={speaker.bio}
                  onChange={(ev) => setSpeaker(i, { bio: ev.target.value })}
                  placeholder="One or two lines, as you'd introduce them."
                />
              </div>

              {/* The claim link, for a saved row nobody has claimed yet. A
                  claimed row has no token left to hand out; an unsaved one
                  has no row for the token to live on. */}
              {eventId && speaker.id && !speaker.userId && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy || inviteBusy === speaker.id}
                    onClick={() => void speakerInvite(speaker.id!, "copy")}
                  >
                    <Copy className="h-3.5 w-3.5" /> Copy invite link
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy || inviteBusy === speaker.id}
                    onClick={() => void speakerInvite(speaker.id!, "send")}
                  >
                    <Mail className="h-3.5 w-3.5" /> Send invite
                  </Button>
                  {inviteNote[speaker.id] && (
                    <span
                      className={`text-xs ${
                        inviteNote[speaker.id].ok
                          ? "text-ink-faint"
                          : "text-red-700 dark:text-red-400"
                      }`}
                    >
                      {inviteNote[speaker.id].text}
                    </span>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="mt-3">
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => patch({ speakers: [...value.speakers, emptySpeaker()] })}
          >
            <Plus className="h-4 w-4" /> Add a speaker
          </Button>
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Afterwards                                                          */}
      {/* ------------------------------------------------------------------ */}
      <div className="space-y-3">
        <Toggle
          label="Record automatically"
          // One recorder per webinar: the server picks one staff host who is
          // on air (guest speakers never record), and it starts on its own.
          description="Records while a staff host is on air — it starts on its own, with no button to forget. Guest speakers never record."
          checked={value.autoRecord}
          // Deliberately touches nothing but its own field. This used to clear
          // `autoShare` on the way off, which meant an admin who flicked
          // recording off and back on — to read the description, say — saved
          // the event with a sharing setting they had never changed silently
          // turned off, and the cohort got no follow-up.
          onChange={(on) => patch({ autoRecord: on })}
          disabled={busy}
        />
        <Toggle
          label="Share afterwards"
          description="Emails the deck and the recording to everyone invited, once it ends."
          // Drawn off for a staff-only rehearsal whatever the draft holds —
          // the save forces it off there, and a checked-but-disabled toggle
          // would promise an email that is never sent.
          checked={value.autoShare && !staffOnly}
          onChange={(on) => patch({ autoShare: on })}
          // Enabled by a deck as well as by recording, because the follow-up
          // job sends whichever of the two exists. Gating it on recording
          // alone made "email the slides afterwards" impossible to ask for.
          disabled={busy || !canAutoShare}
        />
        {staffOnly ? (
          <p className="text-xs text-ink-faint">
            A staff-only rehearsal emails nobody. Change who can see it to
            share afterwards.
          </p>
        ) : (
          !canAutoShare &&
          value.liveMode !== "external" && (
            <p className="text-xs text-ink-faint">
              Sharing needs something to send — turn recording on, or upload a
              deck above.
            </p>
          )
        )}
      </div>

      {error && <FieldError>{error}</FieldError>}

      {/* The sentence between a mis-aimed click and a deleted upload. */}
      <ConfirmDialog
        open={!!confirmDrop}
        title="Delete this file?"
        description={
          <>
            “{confirmDrop?.filename}” is deleted from storage the moment you
            confirm. It does not wait for Save and it cannot be undone — the
            only way back is to upload the file again.
          </>
        }
        confirmLabel="Delete file"
        cancelLabel="Keep it"
        destructive
        onConfirm={() => {
          const asset = confirmDrop;
          setConfirmDrop(null);
          if (asset) dropAsset(asset);
        }}
        onCancel={() => setConfirmDrop(null)}
      />

      {/*
        Kept for the widening direction only, with copy that describes the
        actual effect rather than the irreversibility it does not have.
      */}
      <ConfirmDialog
        open={!!confirmMode}
        title={
          confirmMode
            ? `Let the audience see itself (${AUDIENCE_COPY[confirmMode].label})?`
            : "Let the audience see itself?"
        }
        description={
          <>
            {confirmMode ? AUDIENCE_COPY[confirmMode].description : null} This
            starts once you save, and applies to the room from then on.
            Questions and messages already sent keep the visibility they were
            sent under, so nothing asked while the room was Private becomes
            visible. Switching back to Private hides the chat again.
          </>
        }
        confirmLabel="Change the mode"
        cancelLabel="Stay private"
        onConfirm={() => {
          const mode = confirmMode;
          setConfirmMode(null);
          if (mode) patch({ audienceMode: mode });
        }}
        onCancel={() => setConfirmMode(null)}
      />
    </div>
  );
}

/**
 * The storage bucket every webinar file lands in.
 *
 * Named here as well as on the server because `uploadToSignedUrl` is called
 * from the browser and needs it; the token issued by `getWebinarUploadToken`
 * is scoped to this bucket and this path, so a mismatch fails at the bucket
 * rather than writing somewhere unexpected.
 */
const BUCKET = "webinar-media";

/** The dashed drop-zone, in the shape the resource form established. */
function FilePicker({
  icon,
  label,
  accept,
  disabled,
  onPick,
}: {
  icon: React.ReactNode;
  label: string;
  accept: string;
  disabled: boolean;
  onPick: (file: File) => void;
}) {
  return (
    <label
      className={`mt-3 flex items-center justify-center gap-2 rounded-lg border border-dashed border-line px-4 py-6 text-sm ${
        disabled
          ? "cursor-not-allowed text-ink-faint opacity-60"
          : "cursor-pointer text-ink-soft hover:border-ink/30 hover:text-ink"
      }`}
    >
      {icon}
      {label}
      <input
        type="file"
        className="hidden"
        accept={accept}
        disabled={disabled}
        onChange={(ev) => {
          const f = ev.target.files?.[0];
          // Cleared so picking the same file twice after a failed validation
          // still fires a change event — otherwise the second attempt looks
          // like the form ignoring them.
          ev.target.value = "";
          if (f) onPick(f);
        }}
      />
    </label>
  );
}

/** A file that is already in the bucket. */
function AssetRow({
  asset,
  removing,
  disabled,
  onRemove,
}: {
  asset: AssetDraft;
  removing: boolean;
  disabled: boolean;
  onRemove: () => void;
}) {
  const meta = [
    formatBytes(asset.sizeBytes),
    formatDuration(asset.durationSeconds),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-line bg-paper p-2">
      <div className="flex min-w-0 items-center gap-2 text-sm text-ink-soft">
        {asset.kind === "premiere" ? (
          <Film className="h-4 w-4 shrink-0 text-phosphor-ink" />
        ) : (
          <FileText className="h-4 w-4 shrink-0 text-phosphor-ink" />
        )}
        <span className="truncate">{asset.filename}</span>
        {meta && (
          <span className="shrink-0 font-mono text-[10px] text-ink-faint">
            {meta}
          </span>
        )}
      </div>
      <button
        type="button"
        disabled={disabled}
        onClick={onRemove}
        className="rounded-md p-1 text-ink-faint hover:text-ink disabled:opacity-40"
        aria-label={`Remove ${asset.filename}`}
      >
        {removing ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <X className="h-4 w-4" />
        )}
      </button>
    </div>
  );
}

/** Why a file was refused, in the units the admin's own file manager uses. */
function tooBigMessage(file: File): string {
  return `“${file.name}” is ${formatBytes(file.size)}. The limit is ${formatBytes(
    MAX_UPLOAD_BYTES,
  )} — export it smaller and try again. (Refused before uploading, so you don't wait for it.)`;
}

/**
 * How long the premiere runs, measured in the browser before it is uploaded.
 *
 * The length has to be known to schedule the handover to Q&A, and there is no
 * good server-side way to get it: probing a video in a serverless function
 * means ffmpeg, a cold start and the whole file in memory. The browser
 * already has the file and already has a decoder, so it is asked — a
 * throwaway `<video>` with `preload="metadata"` reads the container header and
 * nothing else, which is a few hundred kilobytes rather than the whole file.
 *
 * The object URL is revoked on every exit, including the error path. It is a
 * reference to a file that may be gigabytes; leaking one keeps that file alive
 * in the tab for as long as the admin leaves the form open.
 *
 * Returns null rather than throwing for anything unreadable — a MOV the
 * browser has no decoder for, a corrupt file, a stream with no duration in its
 * header — and the caller turns that into a message rather than an upload with
 * a length of zero, which would schedule a premiere that hands over the
 * instant it starts.
 */
function readVideoDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    let settled = false;
    const finish = (seconds: number | null) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      video.removeAttribute("src");
      resolve(seconds);
    };
    // A file the browser cannot decode AT ALL fires neither `loadedmetadata`
    // nor `error` — a .mov with a codec it does not ship, or a file picked off
    // a network drive that stalls mid-read. Without this timer the promise
    // never settles, the caller's in-flight slot is never released, and the
    // whole form is disabled with no error and nothing to click. Failing after
    // fifteen seconds gives the admin a sentence and their form back.
    const timer = setTimeout(() => finish(null), 15_000);
    const done = (seconds: number | null) => {
      clearTimeout(timer);
      finish(seconds);
    };

    video.preload = "metadata";
    video.onloadedmetadata = () => {
      const d = video.duration;
      // Infinity is what a stream-copied or fragmented MP4 reports until it
      // has been played through, and it would serialize into the row as a
      // premiere that never ends.
      done(Number.isFinite(d) && d > 0 ? Math.round(d) : null);
    };
    video.onerror = () => done(null);
    video.src = url;
  });
}

/**
 * PUT a file to a signed URL, reporting progress.
 *
 * `fetch` cannot do this: there is no upload-progress event on a `fetch`
 * request, and the streaming-request workaround is Chromium-only and requires
 * HTTP/2. `XMLHttpRequest` is the old API precisely because it predates that
 * gap, and `upload.onprogress` is the only reason it is used here.
 *
 * Note `lengthComputable`: a proxy that re-encodes the body can leave the
 * total unknown, in which case the percentage stays where it was rather than
 * jumping to a number that is a guess.
 *
 * `onXhr` hands the request back to the caller, which is the only way to
 * cancel it. Without it the transfer was unreachable once started: a form
 * unmounted mid-upload (Save, Cancel, a click on another event) left a
 * half-gigabyte PUT climbing the wire with nothing left to receive its result.
 */
function putWithProgress(
  signedUrl: string,
  file: File,
  onProgress: (percent: number) => void,
  onXhr?: (xhr: XMLHttpRequest) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    onXhr?.(xhr);
    xhr.open("PUT", signedUrl, true);
    xhr.setRequestHeader(
      "Content-Type",
      file.type || "application/octet-stream",
    );
    xhr.upload.onprogress = (ev) => {
      if (!ev.lengthComputable || ev.total === 0) return;
      // Capped at 99: the last percent belongs to the server answering, and
      // a bar that sits at 100% while nothing visibly happens reads as stuck.
      onProgress(Math.min(99, Math.round((ev.loaded / ev.total) * 100)));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(100);
        resolve();
        return;
      }
      reject(new Error(`The upload was refused (${xhr.status}).`));
    };
    xhr.onerror = () =>
      reject(
        new Error(
          "The upload was interrupted. Check the connection and try again — nothing was saved.",
        ),
      );
    xhr.onabort = () => reject(new Error("Upload cancelled."));
    xhr.send(file);
  });
}
