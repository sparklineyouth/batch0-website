"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Download, Loader2, X } from "lucide-react";
import {
  fmtBytes,
  previewKindFor,
  TEXT_PREVIEW_MAX_CHARS,
  type DrivePreviewKind,
} from "@/lib/drive-files";

export type PreviewFile = {
  id: string;
  name: string;
  size_bytes: number | null;
  mime_type: string | null;
};

/**
 * In-page preview for a drive file. The parent mints a short-lived signed
 * URL (server action) and hands it over; this component only renders it.
 *
 * Text files are fetched and shown in a <pre> rather than an <iframe> — a
 * drive holds other people's uploads, and an .html or .svg file dropped in
 * by a teammate must never execute as a document.
 */
export function DrivePreview({
  file,
  url,
  onDownload,
  onClose,
}: {
  file: PreviewFile;
  url: string;
  onDownload: () => void;
  onClose: () => void;
}) {
  const kind: DrivePreviewKind = previewKindFor(file);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    // Mirrors components/ui/dialog.tsx: remember the opener, trap Tab inside
    // the panel, lock body scroll, and hand focus back on the way out.
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const root = panelRef.current;
      if (!root) return;
      const focusables = root.querySelectorAll<HTMLElement>(
        'a, button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    closeRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      previouslyFocused?.focus?.();
    };
  }, []);

  if (typeof window === "undefined") return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="drive-preview-title"
      className="fixed inset-0 z-[100] flex items-center justify-center p-3 sm:p-6"
    >
      <button
        type="button"
        aria-label="Close preview"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 bg-ink/50 backdrop-blur-sm"
      />
      <div
        ref={panelRef}
        className="relative flex max-h-full w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-line bg-paper shadow-[0_30px_80px_-20px_rgba(20,20,20,0.35)]"
      >
        <div className="flex items-center gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2
              id="drive-preview-title"
              className="truncate font-display text-sm font-semibold tracking-[-0.02em] text-ink"
            >
              {file.name}
            </h2>
            <p className="text-xs text-ink-faint">
              {fmtBytes(file.size_bytes)}
              {file.mime_type ? ` · ${file.mime_type}` : ""}
            </p>
          </div>
          <button
            type="button"
            onClick={onDownload}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line px-3 text-xs font-semibold text-ink hover:bg-wash"
          >
            <Download className="h-3.5 w-3.5" /> Download
          </button>
          <button
            ref={closeRef}
            type="button"
            aria-label="Close preview"
            onClick={onClose}
            className="text-ink-faint hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto bg-wash">
          <PreviewBody file={file} kind={kind} url={url} />
        </div>
      </div>
    </div>,
    document.body,
  );
}

function PreviewBody({
  file,
  kind,
  url,
}: {
  file: PreviewFile;
  kind: DrivePreviewKind;
  url: string;
}) {
  if (kind === "image") {
    return (
      <div className="flex items-center justify-center p-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt={file.name}
          className="max-h-[70vh] w-auto max-w-full rounded-lg object-contain"
        />
      </div>
    );
  }
  if (kind === "video") {
    return (
      <div className="p-4">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video
          src={url}
          controls
          playsInline
          className="max-h-[70vh] w-full rounded-lg bg-black"
        />
      </div>
    );
  }
  if (kind === "audio") {
    return (
      <div className="p-6">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <audio src={url} controls className="w-full" />
      </div>
    );
  }
  if (kind === "pdf") {
    return (
      <iframe
        src={url}
        title={file.name}
        // Firefox renders PDFs with pdf.js, which needs scripting, so the
        // sandbox grants that and nothing else: no allow-same-origin (the
        // frame gets an opaque origin and can't touch storage-origin data),
        // no top-level navigation, no forms, no popups.
        sandbox="allow-scripts"
        className="h-[72vh] w-full bg-paper"
      />
    );
  }
  if (kind === "text") return <TextPreview url={url} />;
  return (
    <p className="px-6 py-16 text-center text-sm text-ink-faint">
      No in-page preview for this file type. Download it to open.
    </p>
  );
}

function TextPreview({ url }: { url: string }) {
  const [state, setState] = useState<{
    text?: string;
    truncated?: boolean;
    error?: string;
  }>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Storage returned ${res.status}`);
        const body = await res.text();
        if (cancelled) return;
        setState({
          text: body.slice(0, TEXT_PREVIEW_MAX_CHARS),
          truncated: body.length > TEXT_PREVIEW_MAX_CHARS,
        });
      } catch (e: any) {
        if (!cancelled) {
          setState({ error: e?.message ?? "Could not read the file." });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (state.error) {
    return (
      <p className="px-6 py-16 text-center text-sm text-ink-faint">
        Couldn&apos;t load a text preview ({state.error}). Download it to open.
      </p>
    );
  }
  if (state.text === undefined) {
    return (
      <p className="flex items-center justify-center gap-2 px-6 py-16 text-sm text-ink-faint">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading preview…
      </p>
    );
  }
  return (
    <div className="p-4">
      <pre className="max-h-[70vh] overflow-auto rounded-lg border border-line bg-paper p-4 text-xs leading-relaxed text-ink">
        {state.text}
      </pre>
      {state.truncated && (
        <p className="mt-2 text-xs text-ink-faint">
          Preview truncated — download the file for the rest.
        </p>
      )}
    </div>
  );
}
