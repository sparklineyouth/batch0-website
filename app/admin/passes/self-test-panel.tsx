"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import {
  Loader2,
  Check,
  X,
  Minus,
  Stethoscope,
  Eye,
  Send,
  Trash2,
  ExternalLink,
  AlertTriangle,
} from "lucide-react";
import {
  runVirtualPassSelfCheckAction,
  previewInviteEmailAction,
  cleanupSelfTestPassesAction,
  type CheckStep,
  type SelfCheckResult,
  type InvitePreview,
} from "./self-test";
import { issueVirtualPassesAction, type IssuedPass } from "./actions";
import {
  PASS_TIERS,
  DEFAULT_TIER,
  grantOf,
  grantPerkLines,
  parseDollarsToCents,
  passTier,
  type PassTierKey,
} from "@/lib/founder-pass-tiers";

/**
 * The virtual-pass test bench.
 *
 * Three things an admin needs before trusting a send, in the order they need
 * them, and none of which was possible before:
 *
 *   1. DOES THE CHAIN WORK — the self-check, which runs the real hasher, the
 *      real redeemPass() and the real template against throwaway rows and
 *      reports every link by name. No email, no serial, nothing left behind.
 *      See self-test.ts for what it costs (nothing) and why.
 *
 *   2. WHAT WILL THEY GET — the invite rendered exactly as it will be sent,
 *      for the tier and discount picked here. The message carries the promises;
 *      previously the only way to read one was to email it to somebody.
 *
 *   3. THE LAST HOP — one real pass to one address, which is the only part
 *      that cannot be simulated, plus the redeem link so the holder flow can be
 *      walked immediately rather than after waiting on a mail server.
 *
 * Step 3 is a REAL send: a real serial, a real code, a real email. It is
 * separated from the other two and labelled as such for that reason.
 */
export function SelfTestPanel({
  canEmail,
  emailDetail,
  defaultEmail,
}: {
  canEmail: boolean;
  /** What the mail transport says about itself, verbatim. */
  emailDetail: string;
  /** The signed-in admin's own address — the right default for a live drill. */
  defaultEmail: string;
}) {
  const router = useRouter();
  const [tierKey, setTierKey] = useState<PassTierKey>(DEFAULT_TIER.key);
  const [discountDollars, setDiscountDollars] = useState("");
  const [busy, setBusy] = useState<null | "check" | "preview" | "send" | "clean">(
    null,
  );
  const [result, setResult] = useState<SelfCheckResult | null>(null);
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [testEmail, setTestEmail] = useState(defaultEmail);
  const [sent, setSent] = useState<IssuedPass[] | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();

  const grant = grantOf(passTier(tierKey), parseDollarsToCents(discountDollars), "virtual");

  async function run<T>(
    kind: "check" | "preview" | "send" | "clean",
    fn: () => Promise<T>,
    onOk: (value: T) => void,
  ) {
    setBusy(kind);
    setError(undefined);
    setNotice(undefined);
    try {
      onOk(await fn());
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't run.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <div>
        <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <Stethoscope className="h-4 w-4 text-phosphor-ink" />
          Test the virtual pass
        </h2>
        <p className="mt-1 text-sm text-ink-soft">
          Issuing a pass depends on a secret, a mail transport, three
          migrations, a check constraint and a one-shot database claim — all of
          which fail separately and most of which fail quietly. This runs the
          real code against throwaway rows and tells you which link is broken,
          without sending anything or spending a serial.
        </p>
      </div>

      {/* Terms under test — the same two inputs the send form takes, so what
          you verify here is the grant you are about to hand out. */}
      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <div>
          <Label>Terms to test</Label>
          <div className="flex flex-wrap gap-2">
            {PASS_TIERS.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTierKey(t.key)}
                disabled={!!busy}
                aria-pressed={tierKey === t.key}
                className={`h-9 rounded-md border px-3 text-xs font-semibold ${
                  tierKey === t.key
                    ? "border-phosphor/60 bg-phosphor/[0.08] text-phosphor-ink"
                    : "border-line text-ink-soft hover:border-ink/30 hover:text-ink"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
        <div>
          <Label htmlFor="selftest-discount">Discount override</Label>
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-ink-faint">
              $
            </span>
            <Input
              id="selftest-discount"
              inputMode="decimal"
              placeholder="blank = use the tier"
              value={discountDollars}
              disabled={!!busy}
              onChange={(e) => setDiscountDollars(e.target.value)}
              className="pl-6"
            />
          </div>
        </div>
      </div>

      <p className="mt-2 text-xs text-ink-faint">
        Testing: {grantPerkLines(grant)[0]}
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button
          onClick={() =>
            run(
              "check",
              () =>
                runVirtualPassSelfCheckAction({
                  tier: tierKey,
                  discountDollars,
                }),
              (r) => {
                setResult(r);
                if (r.strays > 0) {
                  setNotice(
                    `Cleared ${r.strays} probe row(s) left by an earlier run before starting.`,
                  );
                }
                router.refresh();
              },
            )
          }
          disabled={!!busy}
        >
          {busy === "check" ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Checking…
            </>
          ) : (
            <>
              <Stethoscope className="h-4 w-4" />
              Run the self-check
            </>
          )}
        </Button>

        <Button
          variant="secondary"
          onClick={() =>
            run(
              "preview",
              () =>
                previewInviteEmailAction({
                  tier: tierKey,
                  discountDollars,
                  recipientName: "Ada Okonkwo",
                  note: "",
                }),
              setPreview,
            )
          }
          disabled={!!busy}
        >
          {busy === "preview" ? (
            <>
              <Loader2 className="h-4 w-4" />
              Rendering…
            </>
          ) : (
            <>
              <Eye className="h-4 w-4" />
              Preview the email
            </>
          )}
        </Button>

        <button
          type="button"
          disabled={!!busy}
          onClick={() =>
            run("clean", cleanupSelfTestPassesAction, (r) => {
              setNotice(r.message);
              router.refresh();
            })
          }
          className="inline-flex items-center gap-1.5 text-xs font-medium text-ink-faint hover:text-ink disabled:opacity-40"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Clean up leftovers
        </button>
      </div>

      <p className="mt-2 text-xs text-ink-faint">
        Writes only negative-serial rows in a{" "}
        <span className="font-mono">selftest</span> batch and deletes them again,
        so no real serial moves and nothing appears in the ledger below. The
        redemption step binds a throwaway pass to your own account for a moment
        and unbinds it — and hands back the rate-limit attempts it used, so it
        can&apos;t lock you out of redeeming a real one.
      </p>

      {error && (
        <p className="mt-4 flex items-start gap-2 rounded-lg border border-red-400/40 bg-red-400/[0.06] px-3 py-2 text-xs text-red-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </p>
      )}

      {notice && (
        <p className="mt-4 rounded-lg border border-line bg-wash/40 px-3 py-2 text-xs text-ink-soft">
          {notice}
        </p>
      )}

      {/* ---------------------------------------------------------------- */}
      {result && (
        <div className="mt-5">
          <div
            className={`rounded-lg border px-3 py-2 text-xs font-semibold ${
              result.ok
                ? "border-phosphor/40 bg-phosphor/[0.06] text-phosphor-ink"
                : "border-red-400/40 bg-red-400/[0.06] text-red-300"
            }`}
          >
            {result.ok
              ? "Every link in the chain works. A virtual pass sent from this environment will redeem."
              : `${result.steps.filter((s) => s.status === "fail").length} step(s) failed — a pass sent now may not work. Details below.`}
          </div>
          <ul className="mt-2 space-y-1.5">
            {result.steps.map((s) => (
              <StepRow key={s.key} step={s} />
            ))}
          </ul>
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      {preview && (
        <div className="mt-5 rounded-lg border border-line">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
            <div className="min-w-0">
              <p className="truncate text-xs font-semibold text-ink">
                {preview.subject}
              </p>
              <p className="truncate text-[11px] text-ink-faint">
                Code <span className="font-mono">{preview.code}</span> — minted
                for this preview and stored nowhere, so it will never redeem.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setPreview(null)}
              className="text-xs text-ink-faint hover:text-ink"
            >
              Close
            </button>
          </div>
          {/* Sandboxed with no allow-* flags: this is our own template, but it
              is HTML being injected into the admin panel and there is no
              reason for it to run anything or navigate anywhere. */}
          <iframe
            title="Founder pass invite preview"
            sandbox=""
            srcDoc={preview.html}
            className="h-[32rem] w-full rounded-b-lg bg-white"
          />
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      <div className="mt-6 border-t border-line pt-5">
        <h3 className="text-sm font-semibold text-ink">
          Send one real pass to yourself
        </h3>
        <p className="mt-1 text-sm text-ink-soft">
          The last hop is the one thing that can&apos;t be simulated. This
          issues a genuine pass on the terms above — a real serial, a real code,
          a real email — and shows you the redeem link so you can walk the
          holder&apos;s flow without waiting for the message to land.
        </p>

        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <Input
            aria-label="Where to send the test pass"
            value={testEmail}
            disabled={!!busy}
            onChange={(e) => setTestEmail(e.target.value)}
            className="flex-1 font-mono text-xs"
          />
          <Button
            variant="secondary"
            disabled={!!busy || !canEmail || !testEmail.trim()}
            onClick={() => {
              if (
                !confirm(
                  `Issue a real ${passTier(tierKey).label.toLowerCase()} pass to ${testEmail.trim()}?\n\n` +
                    `${grantPerkLines(grant)[0]}\n\n` +
                    `This spends a serial permanently and the email cannot be recalled. ` +
                    `Redeeming it will use up your one-pass-per-account slot.`,
                )
              )
                return;
              void run(
                "send",
                () =>
                  issueVirtualPassesAction({
                    recipients: { mode: "emails", emails: testEmail.trim() },
                    perRecipient: 1,
                    tier: tierKey,
                    discountDollars,
                    note: "",
                    recipientName: "",
                  }),
                (r) => {
                  if (r.ok) {
                    setSent(r.passes);
                    setNotice(r.message);
                    router.refresh();
                  } else {
                    setError(r.error);
                  }
                },
              );
            }}
          >
            {busy === "send" ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Sending…
              </>
            ) : (
              <>
                <Send className="h-4 w-4" />
                Send a real one
              </>
            )}
          </Button>
        </div>

        {!canEmail && (
          <p className="mt-2 text-xs text-amber-600 dark:text-amber-300">
            {emailDetail}
          </p>
        )}

        {sent && sent.length > 0 && (
          <div className="mt-3 rounded-lg border border-amber-400/40 bg-amber-400/[0.06] p-3">
            {sent.map((p) => (
              <div key={p.serial} className="text-xs">
                <p className="text-amber-200">
                  Pass <span className="font-mono">#{p.serial}</span> — code{" "}
                  <span className="select-all font-mono uppercase tracking-[0.14em] text-ink">
                    {p.code}
                  </span>
                </p>
                <a
                  href={p.redeemUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 inline-flex items-center gap-1.5 font-medium text-phosphor-ink underline underline-offset-4"
                >
                  Open the redeem link
                  <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            ))}
            <p className="mt-2 text-xs text-amber-200/80">
              Shown once. The database keeps only a hash, so there is no resend
              — if you lose this, revoke the serial in the ledger below and send
              another. Revoking it afterwards frees your account to hold a real
              pass again.
            </p>
          </div>
        )}
      </div>
    </Card>
  );
}

function StepRow({ step }: { step: CheckStep }) {
  const icon =
    step.status === "pass" ? (
      <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-300" />
    ) : step.status === "fail" ? (
      <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500 dark:text-red-300" />
    ) : (
      <Minus className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-faint" />
    );
  return (
    <li className="flex gap-2 rounded-md px-1 py-1">
      {icon}
      <div className="min-w-0">
        <p
          className={`text-xs font-semibold ${
            step.status === "fail" ? "text-red-500 dark:text-red-300" : "text-ink"
          }`}
        >
          {step.label}
        </p>
        <p className="mt-0.5 text-xs leading-snug text-ink-soft">{step.detail}</p>
      </div>
    </li>
  );
}
