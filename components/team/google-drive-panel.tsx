"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  ClipboardList,
  ExternalLink,
  Eye,
  EyeOff,
  File,
  FileSpreadsheet,
  FileText,
  Folder,
  LayoutGrid,
  List,
  PenTool,
  Pencil,
  Presentation,
  Trash2,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button, buttonClasses } from "@/components/ui/button";
import { Input, FieldError } from "@/components/ui/input";
import {
  KIND_LABEL,
  MAX_TITLE,
  embedUrl,
  linkFromRow,
  openUrl,
  type GoogleKind,
  type GoogleLink,
} from "@/lib/google-drive-links";
import type { ActionResult } from "@/lib/action-result";
import type { DriveLinkRow, TeamDriveState } from "@/lib/team-drive";
import {
  addTeamPin,
  clearTeamFolder,
  removeTeamPin,
  renameTeamPin,
  setTeamFolder,
} from "@/app/dashboard/team/drive-link-actions";

const ICON: Record<GoogleKind, typeof File> = {
  folder: Folder,
  doc: FileText,
  sheet: FileSpreadsheet,
  slides: Presentation,
  form: ClipboardList,
  drawing: PenTool,
  file: File,
};

/**
 * A Google Drive iframe. The src is always rebuilt from a validated id on
 * Google's own hosts (lib/google-drive-links.ts), never taken from input.
 * Popups may escape the sandbox so "open in new tab" inside Google's viewer
 * works; top navigation is never allowed, and no camera/mic is granted.
 */
function GoogleFrame({ src, title, className }: { src: string; title: string; className: string }) {
  return (
    <iframe
      src={src}
      title={title}
      loading="lazy"
      referrerPolicy="no-referrer"
      sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms allow-downloads allow-storage-access-by-user-activation"
      allow="fullscreen; clipboard-write"
      allowFullScreen
      className={`w-full rounded-md border border-line bg-paper ${className}`}
    />
  );
}

function OpenLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={buttonClasses("secondary", "sm")}
    >
      <ExternalLink className="h-3.5 w-3.5" /> {label}
    </a>
  );
}

/**
 * The team's Google Drive: one shared folder embedded in place, plus pinned
 * Docs/Sheets/Slides/Forms/files with in-app previews. Students edit it on
 * their team's Drive tab; admins (teams.manage) on the admin team page;
 * mentors see it read-only.
 */
export function GoogleDrivePanel({
  teamId,
  drive,
  canEdit,
  className = "",
}: {
  teamId: string;
  drive: TeamDriveState;
  canEdit: boolean;
  className?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | undefined>();

  function run(fn: () => Promise<ActionResult>, after?: () => void) {
    setErr(undefined);
    start(async () => {
      const res = await fn();
      if (!res.ok) {
        setErr(res.error);
        return;
      }
      after?.();
      router.refresh();
    });
  }

  if (!drive.ready) {
    return (
      <Card className={className}>
        <h3 className="text-base font-semibold">Google Drive</h3>
        <p className="mt-1 text-sm text-ink-faint">Not set up yet. Check back soon.</p>
      </Card>
    );
  }

  return (
    <Card className={className}>
      <FolderSection
        teamId={teamId}
        row={drive.folder}
        canEdit={canEdit}
        pending={pending}
        run={run}
      />
      <div className="mt-6 border-t border-line pt-5">
        <PinsSection
          teamId={teamId}
          pins={drive.pins}
          canEdit={canEdit}
          pending={pending}
          run={run}
        />
      </div>
      <FieldError>{err}</FieldError>
    </Card>
  );
}

type Run = (fn: () => Promise<ActionResult>, after?: () => void) => void;

function FolderSection({
  teamId,
  row,
  canEdit,
  pending,
  run,
}: {
  teamId: string;
  row: DriveLinkRow | null;
  canEdit: boolean;
  pending: boolean;
  run: Run;
}) {
  const folder = row ? linkFromRow(row) : null;
  // List by default: titles and dates read better than thumbnails, and it
  // works on a phone.
  const [view, setView] = useState<"grid" | "list">("list");
  const [replacing, setReplacing] = useState(false);
  const [url, setUrl] = useState("");
  const showForm = canEdit && (!folder || replacing);

  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-base font-semibold">Google Drive</h3>
        {folder && (
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-md border border-line bg-paper p-0.5" role="group" aria-label="Folder layout">
              {(["list", "grid"] as const).map((v) => {
                const Icon = v === "grid" ? LayoutGrid : List;
                return (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setView(v)}
                    aria-pressed={view === v}
                    aria-label={v === "grid" ? "Grid" : "List"}
                    className={`inline-flex h-7 w-8 items-center justify-center rounded ${
                      view === v ? "bg-phosphor/20 text-ink" : "text-ink-faint hover:text-ink"
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                  </button>
                );
              })}
            </div>
            <OpenLink href={openUrl(folder)} label="Open in Drive" />
          </div>
        )}
      </div>

      {showForm && (
        <form
          className="mt-3 flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            run(
              () => setTeamFolder({ teamId, url }),
              () => {
                setUrl("");
                setReplacing(false);
              },
            );
          }}
        >
          <Input
            aria-label="Google Drive folder link"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://drive.google.com/drive/folders/…"
            inputMode="url"
            autoComplete="off"
            required
          />
          <div className="flex gap-2">
            <Button type="submit" disabled={pending || !url.trim()}>
              {folder ? "Replace" : "Link folder"}
            </Button>
            {replacing && (
              <Button variant="ghost" onClick={() => setReplacing(false)} disabled={pending}>
                Cancel
              </Button>
            )}
          </div>
        </form>
      )}
      {!folder && (
        <p className="mt-2 text-xs text-ink-faint">
          {canEdit
            ? "Share the folder with your team in Google Drive, then paste its link."
            : "No folder linked yet."}
        </p>
      )}

      {folder && (
        <>
          <GoogleFrame
            key={`${folder.id}-${view}`}
            src={embedUrl(folder, view)}
            title="Team folder — Google Drive"
            className="mt-3 h-[60vh] min-h-[320px] max-h-[720px]"
          />
          <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <p className="text-xs text-ink-faint">
              Blank or asking to sign in? In Drive, share the folder with “Anyone with the link”.
            </p>
            {canEdit && !replacing && (
              <div className="flex gap-1">
                <Button variant="ghost" size="sm" onClick={() => setReplacing(true)} disabled={pending}>
                  Change folder
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  onClick={() => run(() => clearTeamFolder({ teamId }))}
                >
                  Unlink
                </Button>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function PinsSection({
  teamId,
  pins,
  canEdit,
  pending,
  run,
}: {
  teamId: string;
  pins: DriveLinkRow[];
  canEdit: boolean;
  pending: boolean;
  run: Run;
}) {
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const rows = pins
    .map((row) => ({ row, link: linkFromRow(row) }))
    .filter((p): p is { row: DriveLinkRow; link: GoogleLink } => !!p.link);

  return (
    <section>
      <h3 className="text-sm font-semibold">
        Pinned{rows.length > 0 ? ` (${rows.length})` : ""}
      </h3>
      {rows.length === 0 && !canEdit && (
        <p className="mt-1 text-xs text-ink-faint">Nothing pinned.</p>
      )}

      {rows.length > 0 && (
        <ul className="mt-2 divide-y divide-line">
          {rows.map(({ row, link }) => {
            const Icon = ICON[link.kind];
            const previewing = previewId === row.id;
            const renaming = renamingId === row.id;
            return (
              <li key={row.id} className="py-2.5">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <Icon className="h-4 w-4 shrink-0 text-ink-faint" aria-hidden />
                  {renaming ? (
                    <form
                      className="flex min-w-0 flex-1 gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        run(
                          () => renameTeamPin({ id: row.id, title: draft }),
                          () => setRenamingId(null),
                        );
                      }}
                    >
                      <Input
                        aria-label="Pin title"
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        maxLength={MAX_TITLE}
                        className="!h-8"
                        autoFocus
                      />
                      <Button type="submit" size="sm" disabled={pending}>
                        Save
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setRenamingId(null)}>
                        Cancel
                      </Button>
                    </form>
                  ) : (
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-ink">{row.title}</div>
                      <div className="text-xs text-ink-faint">{KIND_LABEL[link.kind]}</div>
                    </div>
                  )}
                  {!renaming && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Button
                        variant="secondary"
                        size="sm"
                        aria-expanded={previewing}
                        onClick={() => setPreviewId(previewing ? null : row.id)}
                      >
                        {previewing ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                        {previewing ? "Hide" : "Preview"}
                      </Button>
                      <OpenLink href={openUrl(link)} label="Open" />
                      {canEdit && (
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`Rename ${row.title}`}
                            onClick={() => {
                              setDraft(row.title);
                              setRenamingId(row.id);
                            }}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`Unpin ${row.title}`}
                            disabled={pending}
                            onClick={() => run(() => removeTeamPin({ id: row.id }))}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </>
                      )}
                    </div>
                  )}
                </div>
                {previewing && (
                  <GoogleFrame
                    src={embedUrl(link, "list")}
                    title={`${row.title} — Google Drive`}
                    className={link.kind === "slides" ? "mt-3 aspect-video" : "mt-3 h-[70vh] min-h-[360px]"}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}

      {canEdit && (
        <form
          className="mt-3 grid gap-2 sm:grid-cols-[1fr_12rem_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            run(
              () => addTeamPin({ teamId, url, title }),
              () => {
                setUrl("");
                setTitle("");
              },
            );
          }}
        >
          <Input
            aria-label="Google Docs, Sheets, Slides, Forms or Drive link"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="Paste a Docs, Sheets, Slides, Forms or Drive link"
            inputMode="url"
            autoComplete="off"
            required
          />
          <Input
            aria-label="Title (optional)"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Title (optional)"
            maxLength={MAX_TITLE}
          />
          <Button type="submit" variant="secondary" disabled={pending || !url.trim()}>
            Pin
          </Button>
        </form>
      )}
    </section>
  );
}
