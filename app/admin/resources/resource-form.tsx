"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Input,
  Textarea,
  Label,
  Select,
  FieldError,
} from "@/components/ui/input";
import { getActionError } from "@/lib/action-error";
import { ConfirmDialog } from "@/components/ui/dialog";
import { saveResource, deleteResource, type ResourceInput } from "./actions";
import { getUploadToken } from "@/app/admin/course/upload-actions";
import { Upload, FileText, X } from "lucide-react";

const CATEGORIES = [
  "general",
  "templates",
  "decks",
  "guides",
  "readings",
  "tools",
];

export function ResourceForm({
  initial,
  cohorts,
}: {
  initial: ResourceInput & { id?: string };
  cohorts: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [v, setV] = useState<ResourceInput & { id?: string }>(initial);
  const [uploading, setUploading] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();
  const [confirmDelete, setConfirmDelete] = useState(false);

  function set<K extends keyof typeof v>(k: K, val: (typeof v)[K]) {
    setV((p) => ({ ...p, [k]: val }));
  }

  async function uploadFile(file: File) {
    setError(undefined);
    setUploading(true);
    try {
      const { signedUrl, path } = await getUploadToken(
        "resources",
        v.category || "general",
        file.name,
      );
      const put = await fetch(signedUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      if (!put.ok) throw new Error(`Upload failed (${put.status})`);
      setV((p) => ({
        ...p,
        storage_path: path,
        size_bytes: file.size,
        mime_type: file.type || null,
      }));
    } catch (e: any) {
      setError(getActionError(e));
    } finally {
      setUploading(false);
    }
  }

  function submit() {
    setError(undefined);
    start(async () => {
      try {
        await saveResource(v);
        router.push("/admin/resources");
        router.refresh();
      } catch (e: any) {
        setError(getActionError(e));
      }
    });
  }

  function onDelete() {
    if (!v.id) return;
    setError(undefined);
    start(async () => {
      try {
        await deleteResource(v.id!);
        router.push("/admin/resources");
        router.refresh();
      } catch (e: any) {
        setError(getActionError(e));
        setConfirmDelete(false);
      }
    });
  }

  return (
    <div className="space-y-5">
      <div>
        <Label htmlFor="title">Title</Label>
        <Input
          id="title"
          value={v.title}
          onChange={(e) => set("title", e.target.value)}
          required
        />
      </div>
      <div>
        <Label htmlFor="description">Description</Label>
        <Textarea
          id="description"
          rows={3}
          value={v.description ?? ""}
          onChange={(e) => set("description", e.target.value)}
          placeholder="One or two lines on what this is and when to use it."
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label>Cohort</Label>
          <Select
            value={v.cohort_id ?? ""}
            onChange={(e) => set("cohort_id", e.target.value || null)}
          >
            <option value="">Visible to all enrolled students</option>
            {cohorts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label>Category</Label>
          <Select
            value={v.category}
            onChange={(e) => set("category", e.target.value)}
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line bg-wash p-4">
        <input
          type="checkbox"
          checked={v.pre_cohort}
          onChange={(e) => set("pre_cohort", e.target.checked)}
          className="mt-0.5 h-4 w-4 accent-[#ffbb00]"
        />
        <span>
          <span className="block text-sm font-medium text-ink">
            Pre-cohort resource
          </span>
          <span className="mt-0.5 block text-xs text-ink-faint">
            Shows in the "Pre-cohort resources" section for accepted students
            before their cohort starts — the only resources they can see until
            kickoff. Everything else unlocks when the cohort begins.
          </span>
        </span>
      </label>

      <div className="rounded-xl border border-line bg-wash p-4">
        <Label>File</Label>
        <p className="text-xs text-ink-faint">
          Upload a file (PDF, deck, image, etc.) OR paste an external link
          below. One or the other.
        </p>
        {v.storage_path ? (
          <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-line bg-paper p-2">
            <div className="flex min-w-0 items-center gap-2 text-sm text-ink-soft">
              <FileText className="h-4 w-4 shrink-0 text-phosphor-ink" />
              <span className="truncate">{v.storage_path}</span>
            </div>
            <button
              type="button"
              onClick={() => set("storage_path", null)}
              className="rounded-md p-1 text-ink-faint hover:text-ink"
              aria-label="Remove file"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ) : (
          <label className="mt-3 flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-line px-4 py-6 text-sm text-ink-soft hover:border-ink/30 hover:text-ink">
            <Upload className="h-4 w-4" />
            {uploading ? "Uploading…" : "Pick a file"}
            <input
              type="file"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) uploadFile(f);
              }}
              disabled={uploading || pending}
            />
          </label>
        )}

        <div className="mt-4">
          <Label htmlFor="external_url">External link (optional)</Label>
          <Input
            id="external_url"
            type="url"
            placeholder="https://… (Notion, Google Drive, GitHub…)"
            value={v.external_url ?? ""}
            onChange={(e) => set("external_url", e.target.value)}
          />
        </div>
      </div>

      {error && <FieldError>{error}</FieldError>}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          {v.id && (
            <Button
              type="button"
              variant="danger"
              onClick={() => setConfirmDelete(true)}
              disabled={pending}
            >
              Delete resource
            </Button>
          )}
        </div>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            onClick={() => router.back()}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending || uploading}>
            {pending ? "Saving…" : v.id ? "Save" : "Publish"}
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete this resource?"
        description={
          <p>
            <span className="text-ink">{v.title}</span> will be removed for
            everyone. The uploaded file (if any) is also deleted. This cannot
            be undone.
          </p>
        }
        confirmLabel="Delete"
        destructive
        pending={pending}
        onConfirm={onDelete}
        onCancel={() => !pending && setConfirmDelete(false)}
      />
    </div>
  );
}
