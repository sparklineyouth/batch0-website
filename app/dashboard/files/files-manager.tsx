"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, FieldError } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/dialog";
import {
  registerStudentFile,
  deleteStudentFile,
  renameStudentFile,
  getDownloadUrl,
} from "./actions";
import { getUploadToken } from "@/app/admin/course/upload-actions";
import { createClient } from "@/lib/supabase/client";
import {
  Upload,
  Loader2,
  Pencil,
  Check,
  X,
  Trash2,
  Download,
  FileText,
  FileImage,
  FileVideo,
  FileAudio,
  FileArchive,
  FileType2,
} from "lucide-react";
import type { StudentFile } from "@/lib/types";

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
  if (mime.startsWith("audio/")) return FileAudio;
  if (mime === "application/zip" || mime.includes("compressed"))
    return FileArchive;
  if (mime === "application/pdf") return FileType2;
  return FileText;
}

export function FilesManager({
  initialFiles,
}: {
  initialFiles: StudentFile[];
}) {
  const router = useRouter();
  const [uploading, setUploading] = useState<string | null>(null); // file name being uploaded
  const [uploadErr, setUploadErr] = useState<string | undefined>();
  const [pending, start] = useTransition();
  const [actionErr, setActionErr] = useState<string | undefined>();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const fileToDelete =
    initialFiles.find((f) => f.id === confirmDeleteId) ?? null;

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const list = Array.from(e.target.files ?? []);
    if (list.length === 0) return;
    setUploadErr(undefined);
    try {
      for (const file of list) {
        setUploading(file.name);
        const { path, token } = await getUploadToken(
          "student-files",
          "drive",
          file.name,
        );
        const supabase = createClient();
        const { error } = await supabase.storage
          .from("student-files")
          .uploadToSignedUrl(path, token, file);
        if (error) throw error;
        await registerStudentFile({
          name: file.name,
          path,
          size_bytes: file.size,
          mime_type: file.type || null,
        });
      }
      router.refresh();
    } catch (err: any) {
      setUploadErr(err.message ?? String(err));
    } finally {
      setUploading(null);
      e.target.value = "";
    }
  }

  async function download(id: string) {
    setActionErr(undefined);
    try {
      const url = await getDownloadUrl(id);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (e: any) {
      setActionErr(e.message);
    }
  }

  function commitRename(id: string) {
    if (!renameValue.trim()) {
      setRenaming(null);
      return;
    }
    setActionErr(undefined);
    start(async () => {
      try {
        await renameStudentFile(id, renameValue);
        setRenaming(null);
        router.refresh();
      } catch (e: any) {
        setActionErr(e.message);
      }
    });
  }

  function executeDelete() {
    if (!confirmDeleteId) return;
    setActionErr(undefined);
    const id = confirmDeleteId;
    start(async () => {
      try {
        await deleteStudentFile(id);
        setConfirmDeleteId(null);
        router.refresh();
      } catch (e: any) {
        setActionErr(e.message);
      }
    });
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-white/40">
          {initialFiles.length === 0
            ? "Empty. Drop a file in to start."
            : `${initialFiles.length} file${initialFiles.length === 1 ? "" : "s"}`}
        </p>
        <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-spark px-3 py-2 text-xs font-semibold text-black hover:bg-spark-200">
          {uploading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Upload className="h-3.5 w-3.5" />
          )}
          {uploading ? `Uploading ${uploading}…` : "Upload files"}
          <input
            type="file"
            multiple
            onChange={onPick}
            disabled={uploading !== null}
            className="hidden"
          />
        </label>
      </div>
      <FieldError>{uploadErr}</FieldError>
      <FieldError>{actionErr}</FieldError>

      <div className="mt-5 divide-y divide-white/5">
        {initialFiles.length === 0 && (
          <p className="py-12 text-center text-sm text-white/40">
            No files yet.
          </p>
        )}
        {initialFiles.map((f) => {
          const Icon = iconFor(f.mime_type);
          const isRenaming = renaming === f.id;
          return (
            <div
              key={f.id}
              className="flex items-center gap-3 py-3"
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/5 text-white/60">
                <Icon className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                {isRenaming ? (
                  <div className="flex items-center gap-1.5">
                    <Input
                      autoFocus
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename(f.id);
                        if (e.key === "Escape") setRenaming(null);
                      }}
                      className="h-8 max-w-sm"
                    />
                    <button
                      onClick={() => commitRename(f.id)}
                      disabled={pending}
                      className="text-emerald-400 hover:text-emerald-300"
                      aria-label="Save rename"
                    >
                      <Check className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => setRenaming(null)}
                      className="text-white/50 hover:text-white"
                      aria-label="Cancel rename"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ) : (
                  <div className="truncate text-sm text-white">{f.name}</div>
                )}
                <div className="text-xs text-white/40">
                  {fmtBytes(f.size_bytes)} ·{" "}
                  {new Date(f.created_at).toLocaleDateString()}
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => download(f.id)}
                  className="p-1.5 text-white/50 hover:text-white"
                  aria-label="Download"
                >
                  <Download className="h-4 w-4" />
                </button>
                <button
                  onClick={() => {
                    setRenaming(f.id);
                    setRenameValue(f.name);
                  }}
                  className="p-1.5 text-white/50 hover:text-white"
                  aria-label="Rename"
                >
                  <Pencil className="h-4 w-4" />
                </button>
                <button
                  onClick={() => setConfirmDeleteId(f.id)}
                  className="p-1.5 text-white/50 hover:text-red-400"
                  aria-label="Delete"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <ConfirmDialog
        open={confirmDeleteId !== null}
        title="Delete file?"
        description={
          fileToDelete && (
            <>
              <p>
                <span className="text-white">{fileToDelete.name}</span> will be
                permanently removed from your drive.
              </p>
              <p className="mt-2 text-amber-300/80">This cannot be undone.</p>
            </>
          )
        }
        confirmLabel="Delete"
        destructive
        pending={pending}
        onConfirm={executeDelete}
        onCancel={() => !pending && setConfirmDeleteId(null)}
      />
    </div>
  );
}
