"use client";
import { ExternalLink } from "lucide-react";
import type { EventSpeaker } from "@/lib/webinars";

/**
 * Who is speaking, under the video.
 *
 * Small, and it earns its place for a reason that is easy to miss: a guest
 * speaker's credibility is most of why a student shows up, and until now the
 * room could not say who they were at all. A viewer joining nine minutes late
 * saw an unlabelled face. The tile's own name label is the account's
 * `full_name`, which is not the same thing as "Founder, Acme" — a billing is a
 * property of the webinar, not of the person's profile, and it has to render
 * before that person has ever signed in.
 *
 * Deliberately NOT part of the audience-privacy surface. These are people an
 * admin typed into the event, published on the event page, and put on a poster
 * — the opposite of the hidden roster. A speaker card is safe to show a viewer
 * precisely because it says nothing about who is watching.
 */
export function SpeakerStrip({
  speakers,
  compact = false,
}: {
  speakers: EventSpeaker[];
  /** Under the video, where horizontal room is scarce. */
  compact?: boolean;
}) {
  if (speakers.length === 0) return null;

  return (
    <ul
      className={
        compact
          ? "flex flex-wrap gap-x-4 gap-y-2"
          : "grid gap-3 sm:grid-cols-2"
      }
    >
      {speakers.map((s) => (
        <li
          key={s.id}
          className={
            compact
              ? "flex min-w-0 items-center gap-2"
              : "flex min-w-0 items-start gap-3 rounded-xl border border-line bg-wash p-3"
          }
        >
          {s.photoUrl ? (
            // A plain <img>: these are arbitrary external URLs an admin pasted,
            // and next/image would need every one of their hostnames listed in
            // next.config.js before it would render. A speaker photo that 404s
            // because nobody remembered to add a domain is a worse outcome than
            // an unoptimised 40px avatar.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={s.photoUrl}
              alt=""
              className={`shrink-0 rounded-full object-cover ${
                compact ? "h-7 w-7" : "h-10 w-10"
              }`}
            />
          ) : (
            <span
              aria-hidden
              className={`grid shrink-0 place-items-center rounded-full bg-phosphor/15 font-medium text-phosphor-ink ${
                compact ? "h-7 w-7 text-[11px]" : "h-10 w-10 text-sm"
              }`}
            >
              {initials(s.name)}
            </span>
          )}
          <div className="min-w-0">
            <p
              className={`truncate font-medium text-ink ${
                compact ? "text-xs" : "text-sm"
              }`}
            >
              {s.name}
            </p>
            {s.title && (
              <p
                className={`truncate text-ink-faint ${
                  compact ? "text-[11px]" : "text-xs"
                }`}
              >
                {s.title}
              </p>
            )}
            {!compact && s.bio && (
              <p className="mt-1.5 text-xs leading-relaxed text-ink-soft">
                {s.bio}
              </p>
            )}
            {!compact && s.linkUrl && (
              <a
                href={s.linkUrl}
                target="_blank"
                // noreferrer as well as noopener: these are links to somebody
                // else's site, pasted by an admin, opened from a page whose URL
                // contains a student's event id.
                rel="noopener noreferrer"
                className="mt-1.5 inline-flex items-center gap-1 text-xs text-phosphor-ink hover:underline"
              >
                <ExternalLink className="h-3 w-3" />
                More
              </a>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * Up to two initials, from the first and last word.
 *
 * Takes the LAST word rather than the second, so "Maria del Carmen Ruiz" reads
 * MR and not MD — and handles a single-word name without producing a stray
 * duplicate letter.
 */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
