import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { TeamForm } from "../team-form";

export const metadata = { title: "New team · Admin" };

export default async function NewTeamPage() {
  const admin = createAdminClient();
  const { data: cohorts } = await admin
    .from("cohorts")
    .select("id, name")
    .order("starts_on");
  return (
    <div className="mx-auto max-w-3xl">
      <Link href="/admin/teams" className="text-sm text-ink-faint hover:text-ink">
        ← All teams
      </Link>
      <h1 className="mt-3 font-display text-3xl font-bold tracking-[-0.02em] text-ink">New team</h1>
      <Card className="mt-6">
        <TeamForm
          initial={{
            cohort_id: cohorts?.[0]?.id ?? "",
            name: "",
            tagline: "",
            description: "",
            logo_url: "",
            pitch_video_url: "",
            pitch_deck_url: "",
            website_url: "",
            is_public: false,
            public_blurb: null,
            demo_video_url: null,
            raised_cents: null,
            post_money_cents: null,
            lead_investor: null,
            round_kind: null,
            round_closed_on: null,
          }}
          cohorts={cohorts ?? []}
        />
      </Card>
    </div>
  );
}
