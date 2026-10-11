"use client";
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { FieldError } from "@/components/ui/input";
import { LocalTime } from "@/components/ui/local-time";
import { ConfirmDialog } from "@/components/ui/dialog";
import {
  Download,
  Eye,
  FileAudio,
  FileImage,
  FileText,
  FileType2,
  FileVideo,
  Loader2,
  Trash2,
  Upload,
} from "lucide-react";
import { getActionError } from "@/lib/action-error";
import {
  canPreview,
  fmtBytes,
  MAX_UPLOAD_BYTES,
  previewKindFor,
} from "@/lib/drive-files";
import {
  deleteTeamDriveFile,
  getTeamDriveDownloadUrl,
  getTeamDriveUploadToken,
  registerTeamDriveFile,
} from "@/app/dashboard/team/actions";
import { DrivePreview } from "./drive-preview";

export type TeamDriveFile = {
  id: string;
  name: string;
  size_bytes: number | null;
  mime_type: string | null;
  created_at: string;
  uploader_id?: string | null;
  // Supabase hands back an object for a to-one join, an array when it can't
  // prove the relation is to-one — normalized in `uploaderName` below.
  uploader?:
    | { full_name: string | null; email: string | null }
    | { full_name: string | null; email: string | null }[]
    | null;
};

function iconFor(file: TeamDriveFile) {
  switch (previewKindFor(file)) {
    case "image":
      return FileImage;
    case "video":
      return FileVideo;
    case "audio":
      return FileAudio;
    case "pdf":
      return FileType2;
    default:
      return FileText;
  }
}

function uploaderName(file: TeamDriveFile): string | null {
  const u = Array.isArray(file.uploader) ? file.uploader[0] : file.uploader;
  if (!u) return null;
  return u.full_name || u.email || null;
}

/**
 * A team's shared drive: the same list everywhere it appears.
 *
 * `canUpload` turns on the drop zone and the per-row delete — members get
 * it on their own team page; mentors, investors and admins see the
 * read-only list with preview and download.
 */
export function TeamDrive({
  teamId,
  files,
  canUpload = false,
  title = "Team drive",
  subtitle = "Shared with all members, mentors, and (during demo day) investors.",
  className = "",
}: {
  teamId: string;
  files: TeamDriveFile[];
  canUpload?: boolean;
  title?: string;
  subtitle?: string;
  className?: string;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [err, setErr] = useState<string | undefined>();
  const [opening, setOpening] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    file: TeamDriveFile;
    url: string;
  } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<TeamDriveFile | null>(
    null,
  );
  const [pending, start] = useTransition();
  const uploading = progress !== null;

  async function handleFiles(list: File[]) {
    if (list.length === 0) return;
    setErr(undefined);
    const big = list.find((f) => f.size > MAX_UPLOAD_BYTES);
    if (big) {
      setErr(`"${big.name}" exceeds the 250 MB cap.`);
      return;
    }
    const empty = list.find((f) => f.size === 0);
    if (empty) {
      setErr(`"${empty.name}" is empty — nothing to upload.`);
      return;
    }
    try {
      // Deferred import keeps supabase-js out of the route's first-load JS;
      // it's only needed here, at the moment an upload starts.
      const { createClient } = await import("@/lib/supabase/client");
      const supabase = createClient();
      for (const [i, file] of list.entries()) {
        setProgress(
          list.length > 1
            ? `${file.name} (${i + 1} of ${list.length})`
            : file.name,
        );
        const { path, token } = await getTeamDriveUploadToken({
          teamId,
          filename: file.name,
        });
        const up = await supabase.storage
          .from("team-drive")
          .uploadToSignedUrl(path, token, file);
        if (up.error) throw up.error;
        await registerTeamDriveFile({
          teamId,
          name: file.name,
          path,
          size_bytes: file.size,
          mime_type: file.type || null,
        });
      }
      router.refresh();
    } catch (e: any) {
      setErr(getActionError(e));
    } finally {
      setProgress(null);
    }
  }

  async function openPreview(file: TeamDriveFile) {
    setErr(undefined);
    setOpening(file.id);
    try {
      const url = await getTeamDriveDownloadUrl({ fileId: file.id });
      setPreview({ file, url });
    } catch (e: any) {
      setErr(getActionError(e));
    } finally {
      setOpening(null);
    }
  }

  async function download(file: TeamDriveFile) {
    setErr(undefined);
    setOpening(file.id);
    try {
      const url = await getTeamDriveDownloadUrl({
        fileId: file.id,
        download: true,
      });
      // The signed URL carries a content-disposition attachment, so this
      // saves the file rather than leaving a blank tab behind.
      window.location.href = url;
    } catch (e: any) {
      setErr(getActionError(e));
    } finally {
      setOpening(null);
    }
  }

  function confirmedDelete() {
    const file = confirmDelete;
    if (!file) return;
    start(async () => {
      try {
        await deleteTeamDriveFile({ fileId: file.id });
        setConfirmDelete(null);
        router.refresh();
      } catch (e: any) {
        setErr(getActionError(e));
        setConfirmDelete(null);
      }
    });
  }

  return (
    <Card className={className}>
      <div>
        <h3 className="text-base font-semibold text-ink">{title}</h3>
        {subtitle && <p className="text-xs text-ink-faint">{subtitle}</p>}
      </div>

      {canUpload && (
        <div
          onClick={() => !uploading && inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            if (!uploading) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            if (!uploading) handleFiles(Array.from(e.dataTransfer.files));
          }}
          className={`press mt-4 flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 text-center transition ${
            dragging
              ? "border-phosphor bg-phosphor/10"
              : "border-line bg-wash hover:border-ink/30"
          } ${uploading ? "cursor-not-allowed opacity-60" : ""}`}
        >
          {uploading ? (
            <Loader2 className="h-5 w-5 animate-spin text-ink-soft" />
          ) : (
            <Upload className="h-5 w-5 text-ink-soft" />
          )}
          <div className="text-sm text-ink">
            {uploading ? (
              `Uploading ${progress}…`
            ) : (
              <>
                <span className="font-medium text-phosphor-ink">
                  Browse your computer
                </span>{" "}
                or drop files here
              </>
            )}
          </div>
          <div className="text-xs text-ink-faint">
            Any file type, up to 250 MB each. Everyone on the team can add and
            remove files.
          </div>
          <input
            ref={inputRef}
            type="file"
            multiple
            disabled={uploading}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => {
              const list = Array.from(e.target.files ?? []);
              e.target.value = "";
              handleFiles(list);
            }}
            className="hidden"
          />
        </div>
      )}

      <FieldError>{err}</FieldError>

      {files.length === 0 ? (
        <p className="py-10 text-center text-sm text-ink-faint">
          {canUpload
            ? "Drive is empty. Add decks, prototypes, or anything your team shares."
            : "Nothing here yet."}
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-line">
          {files.map((f) => {
            const Icon = iconFor(f);
            const who = uploaderName(f);
            const busy = opening === f.id;
            return (
              <li key={f.id} className="flex items-center gap-3 py-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-wash text-ink-soft">
                  {busy ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Icon className="h-4 w-4" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-ink">{f.name}</div>
                  <div className="truncate text-xs text-ink-faint">
                    {fmtBytes(f.size_bytes)} ·{" "}
                    <LocalTime value={f.created_at} mode="date" />
                    {who ? ` · ${who}` : ""}
                  </div>
                </div>
                {canPreview(f) && (
                  <button
                    type="button"
                    onClick={() => openPreview(f)}
                    disabled={busy}
                    className="p-1.5 text-ink-faint hover:text-ink disabled:opacity-50"
                    aria-label={`Preview ${f.name}`}
                    title="Preview"
                  >
                    <Eye className="h-4 w-4" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => download(f)}
                  disabled={busy}
                  className="p-1.5 text-ink-faint hover:text-ink disabled:opacity-50"
                  aria-label={`Download ${f.name}`}
                  title="Download"
                >
                  <Download className="h-4 w-4" />
                </button>
                {canUpload && (
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(f)}
                    disabled={pending}
                    className="p-1.5 text-ink-faint hover:text-red-600 disabled:opacity-50 dark:hover:text-red-400"
                    aria-label={`Delete ${f.name}`}
                    title="Delete"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {preview && (
        <DrivePreview
          file={preview.file}
          url={preview.url}
          onDownload={() => download(preview.file)}
          onClose={() => setPreview(null)}
        />
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        title="Delete this file?"
        description={
          confirmDelete ? (
            <>
              <strong className="text-ink">{confirmDelete.name}</strong> will be
              removed from the drive for everyone — teammates, mentors, and
              investors. This can&apos;t be undone.
            </>
          ) : undefined
        }
        confirmLabel="Delete"
        destructive
        pending={pending}
        onConfirm={confirmedDelete}
        onCancel={() => !pending && setConfirmDelete(null)}
      />
    </Card>
  );
}
