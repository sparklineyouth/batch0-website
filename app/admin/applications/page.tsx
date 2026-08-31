import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { ApplicationsBulkList } from "./bulk-list";
import {
  resolveReferrersByCode,
  tallyApplicationsByReferralCode,
} from "@/lib/referrals";
import { passGrantsByUserId } from "@/lib/founder-pass";
import {
  pendingRebuildUserIds,
  decisionTargetStatus,
} from "@/lib/founder-pass-perks";
import { Sparkles, Share2, ChevronLeft, ChevronRight } from "lucide-react";

export const metadata = { title: "Applications · Admin" };
export const dynamic = "force-dynamic";
export const revalidate = 0;

type Sort = "recent" | "score" | "referred";

const PAGE_SIZE = 100;

function parsePage(raw: string | undefined): number {
  const n = Number(raw ?? "1");
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.floor(n);
}

export default async function AdminApplicationsPage({
  searchParams,
}: {
  searchParams: {
    status?: string;
    sort?: string;
    referred?: string;
    page?: string;
  };
}) {
  const admin = createAdminClient();
  const status = searchParams.status;
  const raw = searchParams.sort;
  const sort: Sort =
    raw === "score" ? "score" : raw === "referred" ? "referred" : "recent";
  // Independent flag, composable with the status filter: "show me only the
  // applicants somebody vouched for".
  const referredOnly = searchParams.referred === "1";
  const page = parsePage(searchParams.page);
  const offset = (page - 1) * PAGE_SIZE;

  let q = admin
    .from("applications")
    .select(
      // profile.referral_code is the applicant's OWN code — the one they hand
      // out. Distinct from applications.referral_code, which is the code that
      // brought THEM in.
      // user_id is selected purely to match against founder pass holders —
      // a pass is bound to an account, not to an application.
      "id, user_id, full_name, age, status, created_at, submitted_at, ai_score, ai_reviewed_at, referral_code, profile:profiles!applications_user_id_fkey(email, referral_code)",
      // count:'exact' drives the pager; the table grows forever, so the page
      // window is what keeps this route's payload flat.
      { count: "exact" },
    );
  // NOTE: the "referred" filter is applied in JS below, not here. It used to be
  // a SQL `.not("referral_code", "is", null)`, but a founder pass is also a
  // vouch and lives in another table keyed by user_id — filtering in SQL would
  // silently drop pass holders from a list whose own counter includes them.
  if (sort === "score") {
    // Highest score first, unscored last. Supabase's PostgREST treats
    // NULLs as "less than" by default in descending order, which is what
    // we want — top scores rise to the top, unscored applications sink.
    q = q
      .order("ai_score", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false });
  } else {
    // "referred" also starts from newest-first and is re-ordered in JS below;
    // PostgREST can't express "nulls last" on a text column as a sort key
    // without an RPC, and the JS pass keeps the tiebreak identical to Newest.
    q = q.order("created_at", { ascending: false });
  }
  if (status && status !== "all") q = q.eq("status", status);
  q = q.range(offset, offset + PAGE_SIZE - 1);

  // The tally and rebuild lookups take nothing from the fetched rows, so
  // they start alongside the main query rather than after it.
  const tallyPromise = tallyApplicationsByReferralCode(admin);
  const rebuildPromise = pendingRebuildUserIds(admin);

  const { data: apps, count } = await q;

  // Two independent lookups:
  //  - referrerByCode: who brought each applicant IN (incoming).
  //  - tally: how many applications each applicant has brought in (outgoing),
  //    counted across ALL applications, not just the current filter.
  const [referrerByCode, tally, passGrants, rebuildUsers] = await Promise.all([
    resolveReferrersByCode(
      admin,
      (apps ?? []).map((a: any) => a.referral_code).filter(Boolean),
    ),
    tallyPromise,
    // One query for the whole page, not one per row — same reason the two
    // lookups above are batched. Scoped to the page's applicants: only the
    // rows on screen need the badge.
    // Grants, not just a holder set: since migration 0055 the decision target
    // is per-pass, so "is this one late?" can't be answered from a boolean.
    passGrantsByUserId(
      admin,
      (apps ?? []).map((a: any) => a.user_id).filter(Boolean),
    ),
    // Pass holders with a rebuild still awaiting a fresh review — badges the row
    // so it's re-reviewed rather than lost in the decided pile.
    rebuildPromise,
  ]);

  const allRows = (apps ?? []).map((a: any) => {
    const code: string | null = a.referral_code
      ? String(a.referral_code).toLowerCase()
      : null;
    const referrer = code ? referrerByCode.get(code) ?? null : null;
    const ownCode: string | null = a.profile?.referral_code
      ? String(a.profile.referral_code).toLowerCase()
      : null;
    const sent = ownCode ? tally.get(ownCode) ?? null : null;
    const passGrant = a.user_id ? passGrants.get(a.user_id) ?? null : null;
    const isPassHolder = passGrant !== null;
    return {
      id: a.id,
      full_name: a.full_name,
      age: a.age,
      status: a.status,
      submitted_at: a.submitted_at,
      ai_score: a.ai_score,
      ai_reviewed_at: a.ai_reviewed_at,
      profile: a.profile ?? null,
      referralCode: code,
      // A code with no matching profile is still a referral — we just can't
      // name who sent it.
      referrerName: referrer?.fullName ?? referrer?.email ?? null,
      referralsSent: sent?.applied ?? 0,
      referralsPaid: sent?.paidOrEnrolled ?? 0,
      hasFounderPass: isPassHolder,
      hasPendingRebuild: a.user_id ? rebuildUsers.has(a.user_id) : false,
      // Decision-target tracking (perk 2) — only meaningful for a pass app
      // that's still waiting on a decision.
      sla:
        passGrant && a.status === "submitted"
          ? decisionTargetStatus(a.submitted_at, new Date(), passGrant.tier)
          : null,
    };
  });

  // "Somebody vouched for this applicant" — a forwarded referral link OR a
  // founder pass. Applied here rather than in the query because the pass lives
  // in another table keyed by user_id.
  const isVouched = (r: (typeof allRows)[number]) =>
    !!r.referralCode || r.hasFounderPass;

  const rows = referredOnly ? allRows.filter(isVouched) : allRows;

  // Fast-track: vouched-for applications rise to the top of the review queue.
  // This backs both the "we'll fast-track their application" promise on the
  // student referral card AND the same promise on the founder pass (/pass).
  //
  // Three-way partition, pass holders first: someone holding a physical card we
  // handed out is a stronger signal than a link someone forwarded, and the card
  // is the scarcer object. Still a partition rather than a comparator .sort(),
  // so the Newest ordering from the query survives inside each bucket. Applies
  // within the current page window — the vouch lives in other tables keyed by
  // user_id, so SQL can't order or filter by it across pages.
  const sorted =
    sort === "referred"
      ? [
          ...rows.filter((r) => r.hasFounderPass),
          ...rows.filter((r) => !r.hasFounderPass && r.referralCode),
          ...rows.filter((r) => !r.hasFounderPass && !r.referralCode),
        ]
      : rows;

  // Counted off allRows, never the filtered `rows`: this number labels the
  // pill that turns the filter ON, so counting the already-filtered list would
  // make it read "12" until you click it and "12 of 12" forever after.
  // Like the partition above, it's scoped to the current page window.
  const referredCount = allRows.filter(isVouched).length;

  const totalCount = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  const filters = [
    "all",
    "submitted",
    "waitlisted",
    "accepted",
    "rejected",
    "paid",
    "draft",
  ];

  // One builder for every pill, so status / sort / referred always survive each
  // other. Three separate builders drifted apart the moment a third param
  // existed — toggling one silently dropped the others.
  const hrefWith = (over: {
    status?: string;
    sort?: Sort;
    referred?: boolean;
    page?: number;
  }) => {
    const nextStatus = over.status ?? status;
    const nextSort = over.sort ?? sort;
    const nextReferred = over.referred ?? referredOnly;
    const params = new URLSearchParams();
    if (nextStatus && nextStatus !== "all") params.set("status", nextStatus);
    if (nextSort !== "recent") params.set("sort", nextSort);
    if (nextReferred) params.set("referred", "1");
    // Filter and sort pills never pass `page`, so changing any of them lands
    // back on page 1; only the pager itself carries it.
    if (over.page && over.page > 1) params.set("page", String(over.page));
    const qs = params.toString();
    return qs ? `/admin/applications?${qs}` : "/admin/applications";
  };

  const pill = (active: boolean) =>
    `inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs uppercase tracking-wider transition ${
      active
        ? "border-phosphor/30 bg-phosphor/10 text-phosphor-ink"
        : "border-line text-ink-soft hover:border-ink/30 hover:text-ink"
    }`;

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">Applications</h1>
          <p className="mt-1 text-sm text-ink-faint">
            Review and decide on applications.
          </p>
        </div>
        <a
          href="/api/admin/export/applications"
          className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-wash px-3 py-1.5 text-xs font-medium text-ink hover:border-ink/30 hover:bg-ink/[0.04]"
        >
          Export CSV
        </a>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-2">
        {filters.map((f) => (
          <Link
            key={f}
            href={hrefWith({ status: f })}
            className={pill((status ?? "all") === f)}
          >
            {f}
          </Link>
        ))}

        {/* The referred flag. Composes with the status pills rather than
            replacing them, so "submitted + referred" is reachable. */}
        <Link
          href={hrefWith({ referred: !referredOnly })}
          title={
            referredOnly
              ? "Showing only applicants who arrived through a referral link — click to clear"
              : "Show only applicants who arrived through a referral link"
          }
          aria-pressed={referredOnly}
          className={pill(referredOnly)}
        >
          <Share2 className="h-3 w-3" />
          Referred
          {referredCount > 0 && (
            <span className="tabular-nums opacity-70">{referredCount}</span>
          )}
        </Link>

        <span className="ml-2 h-4 w-px bg-line" aria-hidden />
        <span className="text-[10px] font-mono uppercase tracking-wider text-ink-faint">
          Sort
        </span>
        <Link href={hrefWith({ sort: "recent" })} className={pill(sort === "recent")}>
          Newest
        </Link>
        <Link href={hrefWith({ sort: "score" })} className={pill(sort === "score")}>
          <Sparkles className="h-3 w-3" />
          AI score
        </Link>
        <Link
          href={hrefWith({ sort: "referred" })}
          title="Referred applicants first — the fast-track promised on the student referral card"
          className={pill(sort === "referred")}
        >
          <Share2 className="h-3 w-3" />
          Referred first
        </Link>
      </div>

      <Card className="mt-6 !p-0 overflow-hidden">
        <ApplicationsBulkList apps={sorted} />
      </Card>

      {/* Pagination */}
      <div className="mt-4 flex items-center justify-between text-xs text-ink-soft">
        <span>
          Page {page} of {totalPages} · showing{" "}
          {Math.min(offset + 1, totalCount)}–
          {Math.min(offset + PAGE_SIZE, totalCount)}
        </span>
        <div className="flex gap-1">
          {page > 1 ? (
            <Link
              href={hrefWith({ page: page - 1 })}
              className="inline-flex items-center gap-1 rounded-md border border-line px-3 py-1.5 hover:bg-wash"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              Prev
            </Link>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-md border border-line px-3 py-1.5 text-ink-faint">
              <ChevronLeft className="h-3.5 w-3.5" />
              Prev
            </span>
          )}
          {page < totalPages ? (
            <Link
              href={hrefWith({ page: page + 1 })}
              className="inline-flex items-center gap-1 rounded-md border border-line px-3 py-1.5 hover:bg-wash"
            >
              Next
              <ChevronRight className="h-3.5 w-3.5" />
            </Link>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-md border border-line px-3 py-1.5 text-ink-faint">
              Next
              <ChevronRight className="h-3.5 w-3.5" />
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
