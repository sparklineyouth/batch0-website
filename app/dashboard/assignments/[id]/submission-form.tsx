"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Label, FieldError } from "@/components/ui/input";
import { saveSubmission } from "../actions";
import { getUploadToken } from "@/app/admin/course/upload-actions";
import { createClient } from "@/lib/supabase/client";
import { Plus, X, Upload, Loader2, FileText, Link2 } from "lucide-react";

type FileEntry = { name: string; path: string; url: string | null };
type LinkEntry = { title: string; url: string };

export function SubmissionForm({
  assignmentId,
  locked,
  initialContent,
  initialLinks,
  initialFiles,
}: {
  assignmentId: string;
  locked: boolean;
  initialContent: string;
  initialLinks: LinkEntry[];
  initialFiles: FileEntry[];
}) {
  const router = useRouter();
  const [content, setContent] = useState(initialContent);
  const [links, setLinks] = useState<LinkEntry[]>(initialLinks);
  const [files, setFiles] = useState<FileEntry[]>(initialFiles);
  const [pending, start] = useTransition();
  const [uploadErr, setUploadErr] = useState<string | undefined>();
  const [submitErr, setSubmitErr] = useState<string | undefined>();
  const [uploading, setUploading] = useState(false);
  const [okMsg, setOkMsg] = useState<string | undefined>();

  function addLink() {
    setLinks((prev) => [...prev, { title: "", url: "" }]);
  }
  function removeLink(i: number) {
    setLinks((prev) => prev.filter((_, j) => j !== i));
  }
  function updateLink(i: number, patch: Partial<LinkEntry>) {
    setLinks((prev) =>
      prev.map((l, j) => (j === i ? { ...l, ...patch } : l)),
    );
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadErr(undefined);
    setUploading(true);
    try {
      const { path, token } = await getUploadToken(
        "submissions",
        assignmentId,
        file.name,
      );
      const supabase = createClient();
      const { error } = await supabase.storage
        .from("submissions")
        .uploadToSignedUrl(path, token, file);
      if (error) throw error;
      setFiles((prev) => [
        ...prev,
        { name: file.name, path, url: null },
      ]);
    } catch (err: any) {
      setUploadErr(err.message ?? String(err));
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  }

  function removeFile(i: number) {
    setFiles((prev) => prev.filter((_, j) => j !== i));
  }

  function commit(submit: boolean) {
    setSubmitErr(undefined);
    setOkMsg(undefined);
    start(async () => {
      try {
        await saveSubmission({
          assignmentId,
          content,
          links: links
            .filter((l) => l.url.trim())
            .map((l) => ({ title: l.title.trim(), url: l.url.trim() })),
          files: files.map((f) => ({ name: f.name, path: f.path })),
          submit,
        });
        setOkMsg(submit ? "Submitted for grading." : "Draft saved.");
        router.refresh();
      } catch (e: any) {
        setSubmitErr(e.message);
      }
    });
  }

  if (locked) {
    return (
      <div className="space-y-4 text-sm">
        {content && (
          <div>
            <Label>Your response</Label>
            <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] rounded-lg border border-white/10 bg-black/30 p-3 text-white/80">
              {content}
            </p>
          </div>
        )}
        {links.length > 0 && (
          <div>
            <Label>Links</Label>
            <ul className="space-y-1">
              {links.map((l, i) => (
                <li key={i}>
                  <a
                    href={l.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-spark hover:underline"
                  >
                    <Link2 className="h-3 w-3" /> {l.title || l.url}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
        {files.length > 0 && (
          <div>
            <Label>Files</Label>
            <ul className="space-y-1">
              {files.map((f, i) => (
                <li key={i}>
                  {f.url ? (
                    <a
                      href={f.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 text-spark hover:underline"
                    >
                      <FileText className="h-3.5 w-3.5" /> {f.name}
                    </a>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-white/50">
                      <FileText className="h-3.5 w-3.5" /> {f.name}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="rounded-lg border border-spark/30 bg-spark/5 p-3 text-xs text-white/60">
          This submission has been graded and is locked. If you need to
          resubmit, ask your mentor to re-open it.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <Label htmlFor="content">Your response</Label>
        <Textarea
          id="content"
          rows={6}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Write your answer here…"
        />
      </div>

      <div>
        <Label>Links</Label>
        <div className="space-y-2">
          {links.map((l, i) => (
            <div
              key={i}
              className="flex items-center gap-2 rounded-lg border border-white/10 bg-black/30 p-2"
            >
              <Input
                placeholder="Title (optional)"
                value={l.title}
                onChange={(e) => updateLink(i, { title: e.target.value })}
                className="md:max-w-[14rem]"
              />
              <Input
                type="url"
                placeholder="https://…"
                value={l.url}
                onChange={(e) => updateLink(i, { url: e.target.value })}
                className="flex-1"
              />
              <button
                type="button"
                aria-label="Remove link"
                onClick={() => removeLink(i)}
                className="text-white/50 hover:text-red-400"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ))}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={addLink}
          >
            <Plus className="h-3 w-3" /> Add link
          </Button>
        </div>
      </div>

      <div>
        <Label>Files</Label>
        {files.length > 0 && (
          <ul className="mb-3 space-y-2">
            {files.map((f, i) => (
              <li
                key={i}
                className="flex items-center gap-2 rounded-lg border border-white/10 bg-black/30 px-3 py-2"
              >
                <FileText className="h-4 w-4 text-white/40" />
                {f.url ? (
                  <a
                    href={f.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 truncate text-sm text-spark hover:underline"
                  >
                    {f.name}
                  </a>
                ) : (
                  <span className="flex-1 truncate text-sm text-white/80">
                    {f.name}
                  </span>
                )}
                <button
                  type="button"
                  aria-label="Remove file"
                  onClick={() => removeFile(i)}
                  className="text-white/50 hover:text-red-400"
                >
                  <X className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-xs text-white/80 hover:bg-white/10">
          {uploading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Upload className="h-3.5 w-3.5" />
          )}
          {uploading ? "Uploading…" : "Attach file"}
          <input
            type="file"
            onChange={onFile}
            disabled={uploading}
            className="hidden"
          />
        </label>
        <FieldError>{uploadErr}</FieldError>
      </div>

      <FieldError>{submitErr}</FieldError>
      {okMsg && (
        <p className="text-xs text-emerald-300">{okMsg}</p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="secondary"
          onClick={() => commit(false)}
          disabled={pending}
        >
          {pending ? "Saving…" : "Save draft"}
        </Button>
        <Button
          type="button"
          onClick={() => commit(true)}
          disabled={pending}
        >
          {pending ? "Submitting…" : "Submit for grading"}
        </Button>
      </div>
    </div>
  );
}
