"use client";
import { useState, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { FieldError } from "@/components/ui/input";
import { LocalTime } from "@/components/ui/local-time";
import { createClient } from "@/lib/supabase/client";
import {
  Upload,
  Download,
  Trash2,
  FileText,
  FileImage,
  FileVideo,
  FileType2,
  Loader2,
} from "lucide-react";
import { getActionError } from "@/lib/action-error";
import {
  getTeamDriveUploadToken,
  registerTeamDriveFile,
  deleteTeamDriveFile,
  getTeamDriveDownloadUrl,
} from "./actions";

function fmtBytes(n: number | null) {
  if (!n) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

function iconFor(mime: string | null) {
  if (!mime) return FileText;
  if (mime.startsWith("image/")) return FileImage;
  if (mime.startsWith("video/")) return FileVideo;
  if (mime === "application/pdf") return FileType2;
  return FileText;
}

type File = {
  id: string;
  name: string;
  size_bytes: number | null;
  mime_type: string | null;
  created_at: string;
};

export function TeamDriveTab({
  teamId,
  files,
}: {
  teamId: string;
  files: File[];
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const [err, setErr] = useState<string | undefined>();
  const [pending, start] = useTransition();

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const list = Array.from(e.target.files ?? []);
    if (list.length === 0) return;
    setErr(undefined);
    const MAX = 250 * 1024 * 1024;
    const big = list.find((f) => f.size > MAX);
    if (big) {
      setErr(`"${big.name}" exceeds the 250 MB cap.`);
      e.target.value = "";
      return;
    }
    try {
      for (const file of list) {
        setUploading(file.name);
        const { path, token } = await getTeamDriveUploadToken({
          teamId,
          filename: file.name,
        });
        const supabase = createClient();
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
      setErr(e.message ?? String(e));
    } finally {
      setUploading(null);
      e.target.value = "";
    }
  }

  async function download(id: string) {
    setErr(undefined);
    try {
      const url = await getTeamDriveDownloadUrl({ fileId: id });
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (e: any) {
      setErr(getActionError(e));
    }
  }

  function del(id: string) {
    start(async () => {
      try {
        await deleteTeamDriveFile({ fileId: id });
        router.refresh();
      } catch (e: any) {
        setErr(getActionError(e));
      }
    });
  }

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">Team drive</h3>
          <p className="text-xs text-ink-faint">
            Shared with all members, mentors, and (during demo day) investors.
          </p>
        </div>
        <label className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-lg bg-spark px-3 text-sm font-semibold text-on-spark hover:bg-spark-200">
          {uploading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Upload className="h-4 w-4" />
          )}
          {uploading ? `Uploading ${uploading}…` : "Upload files"}
          <input
            ref={inputRef}
            type="file"
            multiple
            onChange={onPick}
            disabled={uploading !== null}
            className="hidden"
          />
        </label>
      </div>
      <FieldError>{err}</FieldError>

      {files.length === 0 ? (
        <p className="py-10 text-center text-sm text-ink-faint">
          Drive is empty. Upload decks, prototypes, or anything your team
          shares.
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-line">
          {files.map((f) => {
            const Icon = iconFor(f.mime_type);
            return (
              <li key={f.id} className="flex items-center gap-3 py-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-wash text-ink-soft">
                  <Icon className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-ink">{f.name}</div>
                  <div className="text-xs text-ink-faint">
                    {fmtBytes(f.size_bytes)} ·{" "}
                    <LocalTime value={f.created_at} mode="date" />
                  </div>
                </div>
                <button
                  onClick={() => download(f.id)}
                  className="p-1.5 text-ink-faint hover:text-ink"
                  aria-label="Download"
                >
                  <Download className="h-4 w-4" />
                </button>
                <button
                  onClick={() => del(f.id)}
                  disabled={pending}
                  className="p-1.5 text-ink-faint hover:text-red-600 dark:hover:text-red-400"
                  aria-label="Delete"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
