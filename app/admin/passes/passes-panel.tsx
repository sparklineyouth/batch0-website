"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea, Select } from "@/components/ui/input";
import {
  Ticket,
  Download,
  Loader2,
  AlertTriangle,
  Mail,
  Send,
  Copy,
  Check,
  KeyRound,
  Sparkles,
  Users,
  Search,
  BadgeCheck,
} from "lucide-react";
import {
  revokePassAction,
  revokeBatchAction,
  issueVirtualPassesAction,
  getPassRecipients,
  type IssuedPass,
  type PassRecipient,
  type PassSegment,
} from "./actions";
import { parseEmailList } from "./shared";
import {
  PASS_TIERS,
  DEFAULT_TIER,
  grantOf,
  grantPerkLines,
  parseDollarsToCents,
  passTier,
  type PassTierKey,
} from "@/lib/founder-pass-tiers";

export type PassRow = {
  serial: number;
  batch: string;
  holder: string | null;
  redeemedAt: string | null;
  revoked: boolean;
  /** 'card' = 3D-printed; 'virtual' = emailed (migration 0054). */
  kind: "card" | "virtual";
  /** Where a virtual pass was sent. Null for printed cards. */
  issuedTo: string | null;
  /** Who it was addressed to, as the sender typed it. */
  recipientName: string | null;
  /** The perks baked in at issue time (migration 0055). */
  tier: PassTierKey;
};

export type BatchSummary = {
  batch: string;
  total: number;
  redeemed: number;
  revoked: number;
};

const MINT_OPTIONS = [10, 25, 50];

// Virtual sends are one-at-a-time in practice — you're emailing a person.
// The larger counts exist for handing a partner or an event organiser a small
// stack to distribute, and stop well short of the server's cap of 10.
const SEND_OPTIONS = [1, 3, 5];

/**
 * Copy a value to the clipboard, showing a tick for a beat.
 *
 * Local to this file rather than a shared component: the thing being copied
 * here is a live bearer token that exists in exactly one other place, so it is
 * worth the copy affordance sitting right next to the code and nowhere else.
 */
function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // Clipboard can be blocked (insecure context, no permission). The
          // code is rendered as selectable text either way, so stay silent
          // rather than claim a copy that didn't happen.
        }
      }}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-xs font-medium text-ink hover:border-ink/30 hover:bg-wash"
    >
      {copied ? (
        <>
          <Check className="h-3.5 w-3.5 text-emerald-700 dark:text-emerald-300" />
          Copied
        </>
      ) : (
        <>
          <Copy className="h-3.5 w-3.5" />
          Copy
        </>
      )}
    </button>
  );
}

export function PassesPanel({
  rows,
  batches,
  nextSerial,
  nextBatch,
  nextVirtualBatch,
  canMint,
  canEmail,
  contactEmail,
}: {
  rows: PassRow[];
  batches: BatchSummary[];
  nextSerial: number;
  nextBatch: string;
  nextVirtualBatch: string;
  canMint: boolean;
  canEmail: boolean;
  /** The house inbox, offered as a one-click recipient. */
  contactEmail: string;
}) {
  const router = useRouter();
  const [count, setCount] = useState(50);
  const [minting, setMinting] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [pending, start] = useTransition();

  // --- Virtual send state.
  // How the admin is addressing this send. "emails" reaches anyone, account or
  // not — the only way to hand a pass to someone who hasn't signed up. "people"
  // picks from the existing directory, and sends profile IDS rather than
  // addresses so a tampered request can't redirect a discount to a stranger.
  const [mode, setMode] = useState<"emails" | "people">("emails");
  const [email, setEmail] = useState("");
  const [segment, setSegment] = useState<PassSegment>("students");
  const [people, setPeople] = useState<PassRecipient[] | null>(null);
  const [loadingPeople, setLoadingPeople] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [sendCount, setSendCount] = useState(1);
  const [sendNote, setSendNote] = useState("");
  const [recipientName, setRecipientName] = useState("");
  const [tierKey, setTierKey] = useState<PassTierKey>(DEFAULT_TIER.key);
  // Raw dollars as typed. Kept as a string, not a number: "" has to stay
  // distinguishable from "0", because blank means "use the tier" and zero
  // means "this pass carries no discount". Parsed once, on the server.
  const [discountDollars, setDiscountDollars] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | undefined>();
  const [sendNotice, setSendNotice] = useState<string | undefined>();
  // The plaintext codes from the last send. Held in component state only —
  // never persisted, and gone on refresh, which is the honest reflection of
  // the fact that the server can't produce them again either.
  const [issued, setIssued] = useState<IssuedPass[]>([]);

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

  /** Load the directory for an audience, the first time it's needed. */
  async function loadPeople(next: PassSegment) {
    setSegment(next);
    setLoadingPeople(true);
    setSendError(undefined);
    try {
      const r = await getPassRecipients(next);
      if (r.ok) {
        setPeople(r.recipients);
        // Start with nobody ticked, even for "all students". Selecting a
        // hundred people has to be a thing you did on purpose — the button
        // right there does it in one click.
        setPicked(new Set());
      } else {
        setPeople([]);
        setSendError(r.error);
      }
    } catch (err) {
      setPeople([]);
      setSendError(err instanceof Error ? err.message : "Couldn't load people.");
    } finally {
      setLoadingPeople(false);
    }
  }

  /**
   * Issue virtual passes and email them.
   *
   * Confirmed only when the send is genuinely consequential — several passes
   * at once, or terms worth real money. A single standard pass is the routine
   * action and doesn't earn a dialog; a full ride to forty people very much
   * does, because the emails cannot be recalled and every serial is spent
   * whether or not the pass is ever claimed.
   */
  async function send() {
    const grant = grantOf(passTier(tierKey), parseDollarsToCents(discountDollars));
    const total = recipientCount * sendCount;
    const heavy =
      total >= 5 ||
      grant.tier.key === "full_ride" ||
      (grant.discountCents !== null && grant.discountCents > 10000);
    if (heavy) {
      const terms = grantPerkLines(grant)[0];
      const ok = confirm(
        `Send ${total} pass${total === 1 ? "" : "es"} to ${recipientCount} ` +
          `recipient${recipientCount === 1 ? "" : "s"}?\n\n` +
          `Each one: ${terms}\n\n` +
          `The emails can't be recalled, and each pass permanently consumes a ` +
          `serial whether or not it's ever claimed.`,
      );
      if (!ok) return;
    }

    setSending(true);
    setSendError(undefined);
    setSendNotice(undefined);
    // Clear the previous batch's codes before the new ones land, so two sends
    // can never leave a stale code sitting under a fresh success message.
    setIssued([]);
    try {
      const r = await issueVirtualPassesAction({
        recipients:
          mode === "emails"
            ? { mode: "emails", emails: email }
            : { mode: "users", userIds: Array.from(picked) },
        perRecipient: sendCount,
        note: sendNote,
        tier: tierKey,
        discountDollars,
        recipientName,
      });
      if (r.ok) {
        setIssued(r.passes);
        setSendNotice(r.message);
        // Leave the tier, the discount and the audience — running the same
        // terms through several groups is the common follow-up. The name, the
        // note and the tick-boxes belong to the people just sent to, so they
        // clear; leaving them would silently address the next send to the
        // wrong humans.
        setSendNote("");
        setRecipientName("");
        setPicked(new Set());
        if (mode === "emails") setEmail("");
        router.refresh();
      } else {
        setSendError(r.error);
      }
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Send failed.");
    } finally {
      setSending(false);
    }
  }

  function revokeOne(row: PassRow) {
    const { serial } = row;
    // The consequence differs by channel, and the confirm is the last place to
    // say so: a card keeps existing in someone's wallet with a dead code, while
    // a virtual pass just stops redeeming from whatever inbox it landed in.
    const consequence =
      row.kind === "virtual"
        ? row.issuedTo
          ? `The code sent to ${row.issuedTo} stops working, permanently.`
          : "The code stops working, permanently."
        : "The physical card stops working, permanently.";
    // Say what they lose when it isn't the standard package. Revoking a full
    // ride takes tuition back off someone, and that shouldn't be a surprise
    // discovered afterwards.
    const stakes =
      row.tier === DEFAULT_TIER.key
        ? ""
        : `\n\nThis is a ${passTier(row.tier).label.toLowerCase()} pass: ${grantPerkLines(
            grantOf(passTier(row.tier)),
          )
            .join(" ")
            .toLowerCase()}`;
    if (!confirm(`Revoke pass #${serial}? ${consequence}${stakes}`)) return;
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

  // One busy flag across both issuing paths. They are independent operations,
  // but both draw from the same serial sequence, and two in flight at once
  // would compute the same next serial and make the loser fail on the unique
  // index — after its STL export or its email had already gone out.
  const busy = minting || sending || pending;

  // How many people this send will reach, counted the SAME way the server
  // counts it — parseEmailList is the server's own parser, imported rather
  // than reimplemented, so the button can never promise a different number
  // than the action mints.
  const emailList = mode === "emails" ? parseEmailList(email) : [];
  const recipientCount = mode === "emails" ? emailList.length : picked.size;
  const totalPasses = recipientCount * sendCount;
  const sendReady = recipientCount > 0;

  const grant = grantOf(passTier(tierKey), parseDollarsToCents(discountDollars));
  // A typed value that parses to nothing is a typo, not "use the tier" — the
  // server would silently fall back, so say so before they click.
  const discountUnparsed =
    discountDollars.trim().length > 0 && grant.discountCents === null;

  const visiblePeople = (people ?? []).filter((r) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return (
      r.email.toLowerCase().includes(q) ||
      (r.name ?? "").toLowerCase().includes(q)
    );
  });
  // Never auto-select someone who already holds a pass: redeem refuses a
  // second one, so the code would be dead on arrival and the serial spent.
  const selectablePeople = visiblePeople.filter((r) => !r.hasPass && r.id);

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
            {canEmail && " — or send a virtual pass below, which needs no Onshape."}
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
      {/* ------------------------------------------------------------------
          Send virtual passes. Same pass, same serial sequence, same redeem
          flow — the code goes to an inbox instead of a printer, and the terms
          are chosen here, before any code exists.
         ------------------------------------------------------------------ */}
      <Card>
        <div>
          <h2 className="text-sm font-semibold text-ink">Send virtual passes</h2>
          <p className="mt-1 text-sm text-ink-soft">
            Starting at serial{" "}
            <span className="font-mono text-ink">#{nextSerial}</span> as batch{" "}
            <span className="font-mono text-ink">{nextVirtualBatch}</span>. No
            printer — the code is emailed and redeems itself at /pass, with
            nothing to type.
          </p>
        </div>

        {/* ---------------------------------------------------------------
            1. Who gets one.
           --------------------------------------------------------------- */}
        <div className="mt-5">
          <Label>Who gets one</Label>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setMode("emails")}
              disabled={busy}
              aria-pressed={mode === "emails"}
              className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-semibold ${
                mode === "emails"
                  ? "border-phosphor/60 bg-phosphor/[0.08] text-phosphor-ink"
                  : "border-line text-ink-soft hover:border-ink/30 hover:text-ink"
              }`}
            >
              <Mail className="h-3.5 w-3.5" />
              By email
            </button>
            <button
              type="button"
              onClick={() => {
                setMode("people");
                if (people === null) void loadPeople(segment);
              }}
              disabled={busy}
              aria-pressed={mode === "people"}
              className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-semibold ${
                mode === "people"
                  ? "border-phosphor/60 bg-phosphor/[0.08] text-phosphor-ink"
                  : "border-line text-ink-soft hover:border-ink/30 hover:text-ink"
              }`}
            >
              <Users className="h-3.5 w-3.5" />
              Pick from students
            </button>
          </div>

          {mode === "emails" ? (
            <div className="mt-3 space-y-3">
              <div>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Textarea
                    id="pass-email"
                    rows={2}
                    placeholder={"founder@example.com, another@example.com\nOne per line, or comma-separated."}
                    value={email}
                    disabled={busy}
                    onChange={(e) => setEmail(e.target.value)}
                    className="flex-1 font-mono text-xs"
                  />
                  {/* Appends rather than replaces — the house inbox is often
                      one of several, and clobbering a typed list to add it
                      would be infuriating. */}
                  <button
                    type="button"
                    onClick={() =>
                      setEmail((cur) =>
                        parseEmailList(cur).includes(contactEmail.toLowerCase())
                          ? cur
                          : cur.trim()
                            ? `${cur.trim()}\n${contactEmail}`
                            : contactEmail,
                      )
                    }
                    disabled={busy}
                    className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 self-start rounded-md border border-line px-3 text-xs font-medium text-ink-soft hover:border-ink/30 hover:text-ink"
                  >
                    <Mail className="h-3.5 w-3.5" />
                    {contactEmail}
                  </button>
                </div>
                <p className="mt-1 text-xs text-ink-faint">
                  Works for people with no batch0 account — they&apos;ll make
                  one when they claim it, and the code carries across signup.
                </p>
              </div>

              {/* A name belongs to one person, so it's only offered when
                  exactly one address is in the box. */}
              {emailList.length === 1 && (
                <div>
                  <Label htmlFor="pass-name">Their name (optional)</Label>
                  <Input
                    id="pass-name"
                    placeholder="Ada Okonkwo"
                    value={recipientName}
                    disabled={busy}
                    maxLength={120}
                    onChange={(e) => setRecipientName(e.target.value)}
                  />
                  <p className="mt-1 text-xs text-ink-faint">
                    Greets them by first name and is printed on the card in the
                    email.
                  </p>
                </div>
              )}
            </div>
          ) : (
            <div className="mt-3">
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  value={segment}
                  disabled={busy || loadingPeople}
                  onChange={(e) => void loadPeople(e.target.value as PassSegment)}
                  className="h-9 w-auto"
                >
                  <option value="students">All students</option>
                  <option value="applied">Applied</option>
                  <option value="accepted">Accepted</option>
                  <option value="waitlisted">Waitlisted</option>
                  <option value="enrolled">Enrolled</option>
                  <option value="everyone">Everyone</option>
                </Select>
                <div className="relative min-w-[10rem] flex-1">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint" />
                  <Input
                    placeholder="Filter by name or email"
                    value={search}
                    disabled={busy}
                    onChange={(e) => setSearch(e.target.value)}
                    className="h-9 pl-8"
                  />
                </div>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
                <button
                  type="button"
                  disabled={busy || selectablePeople.length === 0}
                  onClick={() =>
                    setPicked(
                      new Set([
                        ...picked,
                        ...selectablePeople.map((r) => r.id as string),
                      ]),
                    )
                  }
                  className="font-medium text-phosphor-ink hover:underline disabled:opacity-40"
                >
                  Select all {search.trim() ? "shown" : ""} ({selectablePeople.length})
                </button>
                <button
                  type="button"
                  disabled={busy || picked.size === 0}
                  onClick={() => setPicked(new Set())}
                  className="font-medium text-ink-faint hover:text-ink disabled:opacity-40"
                >
                  Clear
                </button>
                <span className="text-ink-faint">{picked.size} selected</span>
              </div>

              <div className="mt-2 max-h-64 overflow-y-auto rounded-lg border border-line">
                {loadingPeople ? (
                  <p className="flex items-center gap-2 px-3 py-4 text-xs text-ink-faint">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Loading…
                  </p>
                ) : visiblePeople.length === 0 ? (
                  <p className="px-3 py-4 text-xs text-ink-faint">
                    {people === null ? "Pick an audience." : "Nobody here."}
                  </p>
                ) : (
                  visiblePeople.map((r) => {
                    const id = r.id as string;
                    const on = picked.has(id);
                    return (
                      <label
                        key={id}
                        className={`flex items-center gap-3 border-b border-line px-3 py-2 last:border-b-0 ${
                          r.hasPass ? "opacity-45" : "cursor-pointer hover:bg-wash/50"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={on}
                          disabled={busy || r.hasPass}
                          onChange={() =>
                            setPicked((cur) => {
                              const next = new Set(cur);
                              if (next.has(id)) next.delete(id);
                              else next.add(id);
                              return next;
                            })
                          }
                          className="h-3.5 w-3.5 shrink-0 accent-[color:var(--phosphor,#ffbb00)]"
                        />
                        <span className="min-w-0 flex-1 truncate text-sm text-ink">
                          {r.name || r.email}
                          {r.name && (
                            <span className="ml-2 text-xs text-ink-faint">
                              {r.email}
                            </span>
                          )}
                        </span>
                        {r.appStatus && (
                          <span className="shrink-0 text-[10px] uppercase tracking-wide text-ink-faint">
                            {r.appStatus}
                          </span>
                        )}
                        {r.hasPass && (
                          <span
                            title="Already holds a live pass — a second one can't be redeemed"
                            className="inline-flex shrink-0 items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-ink-faint"
                          >
                            <BadgeCheck className="h-3 w-3" />
                            Has one
                          </span>
                        )}
                      </label>
                    );
                  })
                )}
              </div>
            </div>
          )}
        </div>

        {/* ---------------------------------------------------------------
            2. What it carries — tier, then the discount box that overrides it.
           --------------------------------------------------------------- */}
        <div className="mt-5">
          <Label>What this pass carries</Label>
          <div className="grid gap-2 sm:grid-cols-3">
            {PASS_TIERS.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTierKey(t.key)}
                disabled={busy}
                aria-pressed={tierKey === t.key}
                className={`rounded-lg border px-3 py-2 text-left transition ${
                  tierKey === t.key
                    ? "border-phosphor/60 bg-phosphor/[0.08]"
                    : "border-line hover:border-ink/30"
                }`}
              >
                <span
                  className={`block text-sm font-semibold ${
                    tierKey === t.key ? "text-phosphor-ink" : "text-ink"
                  }`}
                >
                  {t.label}
                </span>
                <span className="mt-0.5 block text-xs leading-snug text-ink-faint">
                  {t.blurb}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="pass-discount">Discount amount</Label>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-ink-faint">
                $
              </span>
              <Input
                id="pass-discount"
                inputMode="decimal"
                placeholder={
                  grant.tier.tuitionDiscount === "full"
                    ? "full ride"
                    : String(grant.tier.tuitionDiscount / 100)
                }
                value={discountDollars}
                disabled={busy}
                onChange={(e) => setDiscountDollars(e.target.value)}
                className="pl-6"
              />
            </div>
            <p className="mt-1 text-xs text-ink-faint">
              {discountUnparsed ? (
                <span className="text-amber-600 dark:text-amber-300">
                  Can&apos;t read that as a dollar amount — it&apos;ll fall back
                  to the tier&apos;s{" "}
                  {grant.tier.tuitionDiscount === "full"
                    ? "full ride"
                    : `$${grant.tier.tuitionDiscount / 100}`}
                  .
                </span>
              ) : (
                <>
                  Leave blank to use the tier&apos;s own amount. Type a number to
                  override it — <span className="font-mono">0</span> is a real
                  choice, meaning a pass with no discount at all. Never charges
                  more than the tuition.
                </>
              )}
            </p>
          </div>

          <div>
            <Label>Passes each</Label>
            <div className="flex items-center gap-2">
              {SEND_OPTIONS.map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setSendCount(n)}
                  disabled={busy}
                  className={`h-9 rounded-md px-3 text-xs font-semibold ${
                    sendCount === n
                      ? "bg-phosphor text-on-phosphor"
                      : "border border-line text-ink-soft hover:text-ink"
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>
            <p className="mt-1 text-xs text-ink-faint">
              More than one is for handing someone a small stack to pass on.
            </p>
          </div>
        </div>

        {/* Rendered from grantPerkLines() — the exact strings the email will
            print and the holder will read on /pass. A preview built from its
            own copy would be a way for the three to drift. */}
        <div className="mt-3 rounded-lg border border-line bg-wash/40 px-3 py-2.5">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-ink-soft">
            <Sparkles className="h-3.5 w-3.5" />
            Baked into every code in this send
          </div>
          <ul className="mt-1.5 space-y-1">
            {grantPerkLines(grant).map((line) => (
              <li
                key={line}
                className="flex gap-2 text-xs leading-snug text-ink-soft"
              >
                <span className="text-phosphor-ink">&bull;</span>
                <span>{line}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-ink-faint">
            Enforced server-side wherever it counts — checkout reads the
            discount off the pass, the applications gate reads the early
            access, the feedback form reads the credit count. Nothing here is
            copy.
          </p>
        </div>

        <div className="mt-4">
          <Label htmlFor="pass-note">Note (optional)</Label>
          <Input
            id="pass-note"
            placeholder="Met at the Newark demo night — pass for their co-founder."
            value={sendNote}
            disabled={busy}
            maxLength={500}
            onChange={(e) => setSendNote(e.target.value)}
          />
          <p className="mt-1 text-xs text-ink-faint">
            Saved on the pass and quoted in the email every recipient reads — so
            write it to them, not about them.
          </p>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
          <span className="text-xs text-ink-faint">
            {recipientCount === 0
              ? "No recipients yet."
              : `${totalPasses} pass${totalPasses === 1 ? "" : "es"} to ${recipientCount} ` +
                `recipient${recipientCount === 1 ? "" : "s"}, serials #${nextSerial}–#${nextSerial + totalPasses - 1}.`}
          </span>
          <Button onClick={send} disabled={busy || !canEmail || !sendReady}>
            {sending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Sending…
              </>
            ) : (
              <>
                <Send className="h-4 w-4" />
                Send {totalPasses || ""} {passTier(tierKey).label.toLowerCase()}{" "}
                pass{totalPasses === 1 ? "" : "es"}
              </>
            )}
          </Button>
        </div>

        {!canEmail && (
          <p className="mt-4 rounded-lg border border-amber-400/40 bg-amber-400/[0.06] px-3 py-2 text-xs text-amber-200">
            This environment can&apos;t send — RESEND_API_KEY or
            FOUNDER_PASS_PEPPER aren&apos;t set here. Nothing would leave the
            building, so the button stays off rather than issuing serials that
            get revoked a second later.
          </p>
        )}

        {sendError && (
          <p className="mt-4 flex items-start gap-2 rounded-lg border border-red-400/40 bg-red-400/[0.06] px-3 py-2 text-xs text-red-300">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{sendError}</span>
          </p>
        )}

        {sendNotice && (
          <p className="mt-4 flex items-start gap-2 rounded-lg border border-phosphor/40 bg-phosphor/[0.06] px-3 py-2 text-xs text-phosphor-ink">
            <Send className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{sendNotice}</span>
          </p>
        )}

        {/* The codes, shown once. This panel is the manifest.csv of the virtual
            path: the database holds only hashes, so once this is gone the only
            remaining copy is in each recipient's inbox. */}
        {issued.length > 0 && (
          <div className="mt-4 rounded-lg border border-amber-400/40 bg-amber-400/[0.06] p-3">
            <div className="flex items-center gap-2 text-xs font-semibold text-amber-200">
              <KeyRound className="h-3.5 w-3.5" />
              Shown once — there is no resend
            </div>
            <div className="mt-2 space-y-1.5">
              {issued.map((p) => (
                <div key={p.serial} className="flex items-center gap-3">
                  <span className="font-mono text-xs tabular-nums text-ink-faint">
                    #{String(p.serial).padStart(3, "0")}
                  </span>
                  <span className="min-w-0 select-all font-mono text-sm uppercase tracking-[0.14em] text-ink">
                    {p.code}
                  </span>
                  {/* Which inbox this code went to. With a multi-recipient
                      send, a bare list of codes is unusable for following
                      anything up. */}
                  <span className="min-w-0 flex-1 truncate text-xs text-ink-faint">
                    {p.name ? `${p.name} · ` : ""}
                    {p.email}
                  </span>
                  <CopyButton
                    value={p.code.toUpperCase()}
                    label={`Copy the code for pass #${p.serial}`}
                  />
                </div>
              ))}
            </div>
            {issued.length > 1 && (
              <div className="mt-3 flex justify-end">
                <CopyButton
                  value={
                    "serial,code,email\n" +
                    issued
                      .map((p) => `#${p.serial},${p.code.toUpperCase()},${p.email}`)
                      .join("\n")
                  }
                  label="Copy every code from this send"
                />
              </div>
            )}
            <p className="mt-3 text-xs text-amber-200/80">
              Keep a copy if you need to read one back to someone — the database
              stores a peppered hash, so nobody, including us, can recover these
              later. If a send is lost, revoke that serial and issue a new pass.
            </p>
          </div>
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
                      {b.total} pass{b.total === 1 ? "" : "es"} · {b.redeemed} redeemed
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
            No passes yet. Mint a batch or send a virtual pass above.
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
                  {/* Only virtual passes are badged. Printed cards are the
                      default and the overwhelming majority; badging both would
                      be noise on every row. */}
                  {r.kind === "virtual" && (
                    <span
                      title="Issued by email — no printed card"
                      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-line px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-faint"
                    >
                      <Mail className="h-3 w-3" />
                      Virtual
                    </span>
                  )}
                  {/* Only non-standard tiers are badged, for the same reason
                      only virtual passes are: standard is the overwhelming
                      default, and labelling it would bury the ones that
                      actually differ. */}
                  {r.tier !== DEFAULT_TIER.key && (
                    <span
                      title={passTier(r.tier).blurb}
                      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-phosphor/40 bg-phosphor/[0.08] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-phosphor-ink"
                    >
                      <Sparkles className="h-3 w-3" />
                      {passTier(r.tier).label}
                    </span>
                  )}
                  <span className="font-mono text-[11px] text-ink-faint">{r.batch}</span>
                  <span className="truncate text-sm text-ink-soft">
                    {r.revoked
                      ? "Revoked"
                      : r.holder
                        ? `Held by ${r.holder}`
                        : r.issuedTo
                          ? // Unclaimed but sent: the address is the only lead
                            // on where this pass went, so it earns the row. The
                            // name rides along when we have one, because
                            // "Sent to hello@batch0.org" alone doesn't say who
                            // it was actually for.
                            `Sent to ${r.recipientName ? `${r.recipientName} · ` : ""}${r.issuedTo}`
                          : "Unclaimed"}
                  </span>
                </div>
                {!r.revoked && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => revokeOne(r)}
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
