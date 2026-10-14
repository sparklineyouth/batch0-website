"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { getActionError } from "@/lib/action-error";
import { sendSpeakerInvite, speakerInviteLink } from "./webinar-actions";
import { Copy, Mail, Plus, X } from "lucide-react";

export type SpeakerDraft = {
  id?: string;
  name: string;
  title: string;
  email: string;
  linkUrl: string;
  bio: string;
  photoUrl: string;
  /** The account that claimed the slot, when there is one. */
  userId?: string | null;
};

export function emptySpeaker(): SpeakerDraft {
  return { name: "", title: "", email: "", linkUrl: "", bio: "", photoUrl: "" };
}

/**
 * Guest speakers: a per-event broadcast grant for someone without
 * events.manage. Saved with the event; invites go out once a row is saved.
 */
export function SpeakersEditor({
  eventId,
  speakers,
  onChange,
  disabled,
}: {
  /** Null until the event is saved — invite links need a saved row. */
  eventId: string | null;
  speakers: SpeakerDraft[];
  onChange: (next: SpeakerDraft[]) => void;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<Record<string, { ok: boolean; text: string }>>({});

  function set(i: number, patch: Partial<SpeakerDraft>) {
    onChange(speakers.map((s, n) => (n === i ? { ...s, ...patch } : s)));
  }

  async function invite(speakerId: string, how: "copy" | "send") {
    if (!eventId) return;
    setBusy(speakerId);
    try {
      if (how === "copy") {
        const r = await speakerInviteLink(eventId, speakerId);
        if (!r.ok) throw new Error(r.error);
        await navigator.clipboard.writeText(r.data ?? "");
        setNote((n) => ({ ...n, [speakerId]: { ok: true, text: "Link copied. Works once." } }));
      } else {
        const r = await sendSpeakerInvite(eventId, speakerId);
        if (!r.ok) throw new Error(r.error);
        setNote((n) => ({ ...n, [speakerId]: { ok: true, text: "Invite sent." } }));
      }
    } catch (e) {
      setNote((n) => ({ ...n, [speakerId]: { ok: false, text: getActionError(e) } }));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      {speakers.map((sp, i) => (
        <div key={sp.id ?? `new-${i}`} className="rounded-md border border-line p-3">
          <div className="mb-2 flex items-center gap-2">
            <span className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">
              Speaker {i + 1}
              {sp.id ? (sp.userId ? " · joined" : " · invite not used yet") : ""}
            </span>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onChange(speakers.filter((_, n) => n !== i))}
              className="ml-auto rounded-md p-1 text-ink-faint hover:text-ink disabled:opacity-40"
              aria-label={`Remove ${sp.name || `speaker ${i + 1}`}`}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor={`sp-name-${i}`}>Name</Label>
              <Input
                id={`sp-name-${i}`}
                value={sp.name}
                disabled={disabled}
                onChange={(e) => set(i, { name: e.target.value })}
              />
            </div>
            <div>
              <Label htmlFor={`sp-email-${i}`}>Email</Label>
              <Input
                id={`sp-email-${i}`}
                type="email"
                value={sp.email}
                disabled={disabled}
                onChange={(e) => set(i, { email: e.target.value })}
              />
            </div>
            <div>
              <Label htmlFor={`sp-title-${i}`}>Title</Label>
              <Input
                id={`sp-title-${i}`}
                value={sp.title}
                disabled={disabled}
                onChange={(e) => set(i, { title: e.target.value })}
              />
            </div>
            <div>
              <Label htmlFor={`sp-link-${i}`}>Link</Label>
              <Input
                id={`sp-link-${i}`}
                type="url"
                placeholder="https://"
                value={sp.linkUrl}
                disabled={disabled}
                onChange={(e) => set(i, { linkUrl: e.target.value })}
              />
            </div>
          </div>
          {eventId && sp.id && !sp.userId && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={disabled || busy === sp.id}
                onClick={() => void invite(sp.id!, "copy")}
              >
                <Copy className="h-3.5 w-3.5" /> Copy invite link
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={disabled || busy === sp.id || !sp.email}
                onClick={() => void invite(sp.id!, "send")}
              >
                <Mail className="h-3.5 w-3.5" /> Email invite
              </Button>
              {note[sp.id] && (
                <span
                  className={`text-xs ${note[sp.id].ok ? "text-ink-faint" : "text-red-700 dark:text-red-400"}`}
                >
                  {note[sp.id].text}
                </span>
              )}
            </div>
          )}
        </div>
      ))}
      <Button
        size="sm"
        variant="secondary"
        disabled={disabled || speakers.length >= 20}
        onClick={() => onChange([...speakers, emptySpeaker()])}
      >
        <Plus className="h-4 w-4" /> Add speaker
      </Button>
      {speakers.some((s) => !s.id) && (
        <p className="text-xs text-ink-faint">Save to get invite links.</p>
      )}
    </div>
  );
}
