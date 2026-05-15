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
  const { data } = await admin
    .from("demo_day_reactions")
    .select("emoji")
    .eq("team_id", teamId);
  const counts: Record<string, number> = {};
  for (const r of (data ?? []) as { emoji: string }[]) {
    counts[r.emoji] = (counts[r.emoji] ?? 0) + 1;
  }
  return NextResponse.json({ counts });
}
