import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED = new Set(["👏", "🔥", "🚀", "💡", "❤️", "😂", "🤔", "👀"]);

export async function POST(req: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const teamId: string = body?.teamId ?? "";
  const emoji: string = body?.emoji ?? "";
  if (!teamId || !emoji) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }
  if (!ALLOWED.has(emoji)) {
    return NextResponse.json(
      { error: "Pick a supported reaction." },
      { status: 400 },
    );
  }

  // Rate-limit so an excited audience member can't melt the table.
  const rl = await checkRateLimit({
    kind: "demo-day-react",
    identifier: user.id,
    limit: 30,
    windowSeconds: 60,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Slow down a bit." },
      { status: 429 },
    );
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("demo_day_reactions")
    .insert({ team_id: teamId, user_id: user.id, emoji });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const teamId = url.searchParams.get("team_id");
  if (!teamId) {
    return NextResponse.json({ error: "Missing team_id" }, { status: 400 });
  }
  const admin = createAdminClient();
  // Head-only counts, one per allowed emoji, so the response stays a
  // handful of integers no matter how many reactions a team racks up —
  // fetching rows to recount in JS would silently undercount past
  // PostgREST's 1000-row page cap during a busy Demo Day. Only emoji
  // with at least one reaction appear in the payload.
  const emojis = [...ALLOWED];
  const results = await Promise.all(
    emojis.map((emoji) =>
      admin
        .from("demo_day_reactions")
        .select("id", { count: "exact", head: true })
        .eq("team_id", teamId)
        .eq("emoji", emoji),
    ),
  );
  const counts: Record<string, number> = {};
  emojis.forEach((emoji, i) => {
    const count = results[i].count ?? 0;
    if (count > 0) counts[emoji] = count;
  });
  return NextResponse.json(
    { counts },
    {
      headers: {
        // A live audience polls this every ~4s per viewer; a short CDN
        // TTL lets Vercel collapse those into ~1 origin hit per few
        // seconds while counts still track live taps.
        "Cache-Control": "public, s-maxage=3, stale-while-revalidate=5",
      },
    },
  );
}
