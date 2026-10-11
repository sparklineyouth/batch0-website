"use client";
import { useEffect, useMemo, useState } from "react";
import { TeamDrive, type TeamDriveFile } from "@/components/team/team-drive";
import { DrivePreview } from "@/components/team/drive-preview";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

const DAY = 86_400_000;
const now = Date.now();

function file(
  i: number,
  name: string,
  mime: string | null,
  size: number,
  who: string,
): TeamDriveFile {
  return {
    id: `mock-${i}`,
    name,
    mime_type: mime,
    size_bytes: size,
    created_at: new Date(now - i * DAY).toISOString(),
    uploader: { full_name: who, email: null },
  };
}

const MOCK: TeamDriveFile[] = [
  file(1, "seed-deck-v4.pdf", "application/pdf", 4_410_000, "Priya Raman"),
  file(2, "demo-walkthrough.mp4", "video/mp4", 88_200_000, "Alex Chen"),
  file(3, "hero-screenshot.png", "image/png", 612_000, "Alex Chen"),
  file(4, "metrics.csv", "text/csv", 18_400, "Jordan Diaz"),
  file(5, "customer-interviews.md", "text/markdown", 9_100, "Priya Raman"),
  file(6, "prototype-v2.step", null, 31_000_000, "Sam Okafor"),
  file(7, "brand-kit.zip", "application/zip", 12_800_000, "Sam Okafor"),
];

/** Blob URLs so the preview bodies render real content with no network. */
function useSamples() {
  const [urls, setUrls] = useState<Record<string, string>>({});
  useEffect(() => {
    const made: string[] = [];
    const make = (content: BlobPart, type: string) => {
      const u = URL.createObjectURL(new Blob([content], { type }));
      made.push(u);
      return u;
    };
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 360;
    const ctx = canvas.getContext("2d")!;
    const grad = ctx.createLinearGradient(0, 0, 640, 360);
    grad.addColorStop(0, "#0f172a");
    grad.addColorStop(1, "#14b86a");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 640, 360);
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 34px sans-serif";
    ctx.fillText("hero-screenshot.png", 60, 190);
    setUrls({
      image: canvas.toDataURL("image/png"),
      text: make(
        "date,signups,activated\n2026-09-01,18,7\n2026-09-08,44,21\n2026-09-15,91,52\n",
        "text/csv",
      ),
    });
    return () => made.forEach((u) => URL.revokeObjectURL(u));
  }, []);
  return urls;
}

export function DrivePreviewHarness() {
  const samples = useSamples();
  const [open, setOpen] = useState<{
    file: TeamDriveFile;
    url: string;
  } | null>(null);
  const byName = useMemo(
    () => Object.fromEntries(MOCK.map((f) => [f.name, f])),
    [],
  );

  return (
    <div className="mx-auto max-w-4xl px-4 py-10">
      <h1 className="font-display text-2xl font-bold tracking-[-0.02em] text-ink">
        Team drive preview
      </h1>
      <p className="mt-1 text-sm text-ink-soft">
        Mock rows, no auth and no storage — the upload, preview and download
        buttons below hit real server actions and will report “Not signed in”.
        Use the dialog buttons at the bottom to inspect the preview pane
        itself.
      </p>

      <h2 className="mt-8 text-xs font-semibold uppercase tracking-wider text-ink-faint">
        Member view (can upload and delete)
      </h2>
      <div className="mt-3">
        <TeamDrive teamId="mock-team" files={MOCK} canUpload />
      </div>

      <h2 className="mt-8 text-xs font-semibold uppercase tracking-wider text-ink-faint">
        Mentor / investor / admin view (read-only)
      </h2>
      <div className="mt-3">
        <TeamDrive
          teamId="mock-team"
          files={MOCK}
          title={`Drive (${MOCK.length})`}
          subtitle="Everything this team has shared. Preview in place, or download."
        />
      </div>

      <h2 className="mt-8 text-xs font-semibold uppercase tracking-wider text-ink-faint">
        Empty state
      </h2>
      <div className="mt-3">
        <TeamDrive teamId="mock-team" files={[]} canUpload />
      </div>

      <h2 className="mt-8 text-xs font-semibold uppercase tracking-wider text-ink-faint">
        Preview dialog
      </h2>
      <Card className="mt-3">
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            onClick={() =>
              samples.image &&
              setOpen({
                file: byName["hero-screenshot.png"],
                url: samples.image,
              })
            }
          >
            Image
          </Button>
          <Button
            variant="secondary"
            onClick={() =>
              samples.text &&
              setOpen({ file: byName["metrics.csv"], url: samples.text })
            }
          >
            Text / CSV
          </Button>
          <Button
            variant="secondary"
            onClick={() =>
              setOpen({ file: byName["brand-kit.zip"], url: "about:blank" })
            }
          >
            Not previewable
          </Button>
        </div>
        <p className="mt-3 text-xs text-ink-faint">
          PDF and video bodies need a real storage URL (a sandboxed iframe
          can&apos;t read a blob URL this page made), so they are checked
          against the signed URLs on a deployment, not here.
        </p>
      </Card>

      {open && (
        <DrivePreview
          file={open.file}
          url={open.url}
          onDownload={() => {}}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}
