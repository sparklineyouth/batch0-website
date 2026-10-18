import { createAdminClient } from "@/lib/supabase/admin";
import { viewerCan } from "@/lib/auth";
import { toCsv, csvResponse } from "@/lib/csv";
import { loadCohortBoard } from "@/lib/assignments-server";
import { statusLabel } from "@/lib/assignments";

export const dynamic = "force-dynamic";

/** The completion matrix for one cohort: a row per student, a column per released assignment. */
export async function GET(req: Request) {
  if (!(await viewerCan("assignments.manage"))) {
    return new Response("Forbidden", { status: 403 });
  }
  const cohortId = new URL(req.url).searchParams.get("cohort") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(cohortId)) return new Response("Pick a cohort", { status: 400 });
  const admin = createAdminClient();
  const [{ data: cohort }, board] = await Promise.all([
    admin.from("cohorts").select("name").eq("id", cohortId).maybeSingle(),
    loadCohortBoard(admin, cohortId),
  ]);
  if (!cohort) return new Response("Cohort not found", { status: 404 });
  if (!board.ready) {
    return new Response(board.failed ? "Couldn't load the assignments just now. Try again." : "Assignments aren't set up yet", {
      status: 503,
    });
  }

  const byUser = new Map(board.rows.map((r) => [r.userId, r]));
  const rows = board.students.map((s) => {
    const r = byUser.get(s.userId);
    return [
      s.name ?? "",
      s.email ?? "",
      r?.missing ?? 0,
      ...board.columns.map((a) => {
        const cell = r?.cells[a.id];
        return cell ? statusLabel(cell, "staff") : "";
      }),
    ];
  });
  const headers = [
    "name",
    "email",
    "missing",
    ...board.columns.map((a) => (a.week ? `${a.title} (week ${a.week})` : a.title)),
  ];
  const slug = (cohort.name || "cohort").toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return csvResponse(`batch0-assignments-${slug}-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(headers, rows));
}
