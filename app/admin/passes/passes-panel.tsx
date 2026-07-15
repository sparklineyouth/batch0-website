"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Ticket, Download, Loader2, AlertTriangle } from "lucide-react";
import { revokePassAction, revokeBatchAction } from "./actions";

export type PassRow = {
  serial: number;
  batch: string;
  holder: string | null;
  redeemedAt: string | null;
  revoked: boolean;
};

export type BatchSummary = {
  batch: string;
  total: number;
  redeemed: number;
  revoked: number;
};

const MINT_OPTIONS = [10, 25, 50];

export function PassesPanel({
  rows,
  batches,
  nextSerial,
  nextBatch,
  canMint,
}: {
  rows: PassRow[];
  batches: BatchSummary[];
  nextSerial: number;
  nextBatch: string;
  canMint: boolean;
}) {
  const router = useRouter();
  const [count, setCount] = useState(50);
  const [minting, setMinting] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [pending, start] = useTransition();

  async function mint() {
    setMinting(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const res = await fetch(`/api/admin/passes/mint?count=${count}`, {
        method: "POST",
      });

      if (!res.ok) {
        // Errors come back as JSON; success comes back as a zip stream.
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        setError(body.error ?? "Mint failed.");
        return;
      }

      // Pull the whole archive before triggering the save dialog. It holds the
      // only copy of the plaintext codes, so a half-download that looks like a
      // success is the worst outcome available — better to fail loudly here.
      const blob = await res.blob();
      const batch = res.headers.get("X-Pass-Batch") ?? "cards";
      const serials = res.headers.get("X-Pass-Serials") ?? "";

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${batch}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      setNotice(
        `Minted ${count} pass(es), serials ${serials}, batch "${batch}". ` +
          `The download holds your STLs and manifest.csv — that manifest is the ONLY ` +
          `copy of the codes. Save it somewhere offline before you close this tab.`,
      );
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Mint failed.");
    } finally {
      setMinting(false);
    }
  }

  function revokeOne(serial: number) {
    if (!confirm(`Revoke pass #${serial}? The physical card stops working, permanently.`)) return;
    start(async () => {
      const r = await revokePassAction(serial);
      if (r.ok) { setNotice(r.message); setError(undefined); }
      else { setError(r.error); }
      router.refresh();
    });
  }

  function revokeBatch(batch: string, summary: BatchSummary) {
    const held = summary.redeemed > 0 ? `\n\n${summary.redeemed} of these are already redeemed — those people lose their perks immediately.` : "";
    if (!confirm(`Revoke ALL ${summary.total - summary.revoked} live pass(es) in "${batch}"?${held}\n\nThis cannot be undone.`)) return;
    start(async () => {
      const r = await revokeBatchAction(batch);
      if (r.ok) { setNotice(r.message); setError(undefined); }
      else { setError(r.error); }
      router.refresh();
    });
  }

  const busy = minting || pending;

  return (
    <div className="space-y-6">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-ink">Mint a batch</h2>
            <p className="mt-1 text-sm text-ink-soft">
              Next: serials{" "}
              <span className="font-mono text-ink">
                {nextSerial}–{nextSerial + count - 1}
              </span>{" "}
              as batch <span className="font-mono text-ink">{nextBatch}</span>.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {MINT_OPTIONS.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setCount(n)}
                disabled={busy}
                className={`h-8 rounded-md px-3 text-xs font-semibold ${
                  count === n
                    ? "bg-phosphor text-on-phosphor"
                    : "border border-line text-ink-soft hover:text-ink"
                }`}
              >
                {n}
              </button>
            ))}
            <Button onClick={mint} disabled={busy || !canMint}>
              {minting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Minting {count}…
                </>
              ) : (
                <>
                  <Ticket className="h-4 w-4" />
                  Mint {count}
                </>
              )}
            </Button>
          </div>
        </div>

        {!canMint && (
          <p className="mt-4 rounded-lg border border-amber-400/40 bg-amber-400/[0.06] px-3 py-2 text-xs text-amber-200">
            This environment can&apos;t mint — Onshape keys or FOUNDER_PASS_PEPPER
            aren&apos;t set here. Mint locally instead:{" "}
            <code className="font-mono">npm run mint-cards -- --count {count}</code>
          </p>
        )}

        {minting && (
          <p className="mt-4 text-xs text-ink-faint">
            Exporting {count} STLs from Onshape (~{Math.ceil(count * 1.5)}s). Nothing is
            written to the database until every export succeeds, so a failure here
            leaves no trace — don&apos;t close this tab.
          </p>
        )}

        {error && (
          <p className="mt-4 flex items-start gap-2 rounded-lg border border-red-400/40 bg-red-400/[0.06] px-3 py-2 text-xs text-red-300">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{error}</span>
          </p>
        )}

        {notice && (
          <p className="mt-4 flex items-start gap-2 rounded-lg border border-phosphor/40 bg-phosphor/[0.06] px-3 py-2 text-xs text-phosphor-ink">
            <Download className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{notice}</span>
          </p>
        )}
      </Card>

      {batches.length > 0 && (
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-ink">Batches</h2>
          <div className="space-y-2">
            {batches.map((b) => {
              const live = b.total - b.revoked;
              return (
                <div
                  key={b.batch}
                  className="flex items-center justify-between gap-4 rounded-lg border border-line px-3 py-2"
                >
                  <div className="min-w-0">
                    <span className="font-mono text-sm text-ink">{b.batch}</span>
                    <span className="ml-3 text-xs text-ink-faint">
                      {b.total} card{b.total === 1 ? "" : "s"} · {b.redeemed} redeemed
                      {b.revoked > 0 && ` · ${b.revoked} revoked`}
                    </span>
                  </div>
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={busy || live === 0}
                    onClick={() => revokeBatch(b.batch, b)}
                  >
                    {live === 0 ? "All revoked" : `Revoke batch`}
                  </Button>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-ink">
          Passes{" "}
          <span className="font-normal text-ink-faint">({rows.length})</span>
        </h2>
        {rows.length === 0 ? (
          <p className="text-sm text-ink-faint">
            No passes yet. Mint a batch above.
          </p>
        ) : (
          <div className="space-y-1">
            {rows.map((r) => (
              <div
                key={r.serial}
                className={`flex items-center justify-between gap-4 rounded-lg px-3 py-2 ${
                  r.revoked ? "opacity-40" : ""
                }`}
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span className="font-mono text-sm tabular-nums text-ink">
                    #{String(r.serial).padStart(3, "0")}
                  </span>
                  <span className="font-mono text-[11px] text-ink-faint">{r.batch}</span>
                  <span className="truncate text-sm text-ink-soft">
                    {r.revoked
                      ? "Revoked"
                      : r.holder
                        ? `Held by ${r.holder}`
                        : "Unclaimed"}
                  </span>
                </div>
                {!r.revoked && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => revokeOne(r.serial)}
                    className="shrink-0 text-xs text-ink-faint hover:text-red-300"
                  >
                    Revoke
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
