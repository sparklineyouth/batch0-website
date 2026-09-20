import "server-only";
import { unstable_cache } from "next/cache";
import { createPublicReadClient } from "@/lib/supabase/admin";
import { visibleSchedule, type PublicSession } from "@/lib/offer-format";
import type { ActiveCohort } from "@/lib/site-config";

const load = unstable_cache(async (cohortId: string) => {
  // The timetable is public; room URLs, descriptions, student data and staff
  // events are deliberately neither selected nor serialized to the browser.
  const { data, error } = await createPublicReadClient().from("events")
    .select("id,title,type,starts_at,ends_at")
    .eq("cohort_id", cohortId).in("visibility", ["enrolled", "public"])
    .order("starts_at", { ascending: true });
  if (error) throw new Error("Public timetable unavailable");
  return data as PublicSession[];
}, ["public-cohort-timetable"], { revalidate: 300, tags: ["public-cohort-timetable", "site-config"] });

export async function getPublicCohortSchedule(cohort: ActiveCohort | null): Promise<PublicSession[]> {
  if (!cohort?.id) return [];
  try { return visibleSchedule(await load(cohort.id), cohort.startsOn, cohort.endsOn); }
  catch { return []; }
}
