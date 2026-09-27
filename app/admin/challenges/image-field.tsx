"use client";
import { useRef, useState } from "react";
import { ImagePlus, Loader2, X } from "lucide-react";
import { getChallengeMediaUploadToken } from "./actions";

/**
 * Upload (or paste a link to) one image — the cover, or a prize photo.
 * Uploads go straight from the browser to the public challenge-media bucket
 * via a signed URL; the field's value is the resulting public URL.
 */
export function ImageField({
  value,
  onChange,
  label = "Image",
  square = true,
  compact = false,
}: {
  value: string | null;
  onChange: (url: string | null) => void;
  label?: string;
  square?: boolean;
  compact?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);

  async function upload(file: File) {
    setError(null);
    setBusy(true);
    try {
      const res = await getChallengeMediaUploadToken({
        filename: file.name,
        size: file.size,
      });
      if (!res.ok || !res.data) throw new Error(res.ok ? "Upload failed" : res.error);
      const { createClient } = await import("@/lib/supabase/client");
      const up = await createClient()
        .storage.from(res.data.bucket)
        .uploadToSignedUrl(res.data.path, res.data.token, file, {
          contentType: file.type || undefined,
        });
      if (up.error) throw up.error;
      onChange(res.data.publicUrl);
    } catch (e: any) {
      setError(e?.message ?? "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  const size = compact ? "h-20 w-20" : square ? "aspect-square w-full max-w-[220px]" : "h-32 w-full";

  return (
    <div>
      <div className="flex items-start gap-3">
        <div
          role="button"
          tabIndex={0}
          aria-label={value ? `Replace ${label.toLowerCase()}` : `Upload ${label.toLowerCase()}`}
          onClick={() => !busy && ref.current?.click()}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              ref.current?.click();
            }
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            const f = e.dataTransfer.files?.[0];
            if (f) upload(f);
          }}
          className={`group relative ${size} shrink-0 cursor-pointer overflow-hidden rounded-lg border ${
            over ? "border-phosphor bg-phosphor/10" : value ? "border-line" : "border-dashed border-line hover:border-ink/30"
          } bg-wash`}
        >
          {value ? (
            // eslint-disable-next-line @next/next/no-img-element -- public bucket URL
            <img src={value} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center gap-1 p-2 text-center text-[11px] text-ink-faint">
              {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <ImagePlus className="h-5 w-5" />}
              {!compact && <span>{busy ? "Uploading…" : "Drop or click"}</span>}
            </div>
          )}
          {value && busy && (
            <div className="absolute inset-0 flex items-center justify-center bg-paper/70">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          )}
          <input
            ref={ref}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) upload(f);
              e.target.value = "";
            }}
          />
        </div>
        {value && (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[12px] text-ink-soft hover:text-ink"
          >
            <X className="h-3 w-3" /> Remove
          </button>
        )}
      </div>
      {error && <p className="mt-1.5 text-[12px] text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
