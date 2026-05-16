import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { checkRateLimit } from "@/lib/rate-limit";
import { env } from "@/lib/env";
import Anthropic from "@anthropic-ai/sdk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STOP_WORDS = new Set([
  "that", "this", "with", "from", "have", "they", "their", "would",
  "could", "about", "where", "which", "while", "into", "your", "youre",
  "build", "building", "make", "thing", "people", "want", "wants",
  "going", "really",
]);

function tokens(t: string): string[] {
  return t
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOP_WORDS.has(w))
    .slice(0, 8);
}

/**
 * Pre-submit "is anyone else building this?" check. Always-available
 * to authed users, throttled, and bounded — designed to take ~2s
 * regardless of how many old applications we have. Returns up to 3
 * accepted-or-paid past applications whose startup_idea has notable
 * token overlap with the current draft, plus a short LLM critique.
 */
export async function POST(req: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  const rl = await checkRateLimit({
    kind: "apply-idea-validate",
    identifier: user.id,
    limit: 10,
    windowSeconds: 60,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Slow down — try again in a minute." },
      { status: 429 },
    );
  }

  const body = await req.json().catch(() => ({}));
  const idea: string = (body?.idea ?? "").toString().trim();
  if (idea.length < 30) {
    return NextResponse.json({
      similars: [],
      critique:
        "Add a bit more detail (at least a couple sentences) before I can check for overlap.",
    });
  }

  const admin = createAdminClient();
  const t = tokens(idea);
  let similars: { id: string; idea: string; status: string; overlap: number }[] =
    [];
  if (t.length > 0) {
    const orFilters = t
      .map((w) => `startup_idea.ilike.%${w}%`)
      .join(",");
    const { data } = await admin
      .from("applications")
      .select("id, startup_idea, status")
      .in("status", ["accepted", "paid", "enrolled"])
      .or(orFilters)
      .limit(30);
    const tokenSet = new Set(t);
    similars = (data ?? [])
      .map((row: any) => {
        const rowLc = (row.startup_idea ?? "").toLowerCase();
        let hits = 0;
        for (const tk of tokenSet) if (rowLc.includes(tk)) hits += 1;
        return { id: row.id, idea: row.startup_idea ?? "", status: row.status, overlap: hits };
      })
      .filter((r) => r.overlap >= 2)
      .sort((a, b) => b.overlap - a.overlap)
      .slice(0, 3);
  }

  let critique =
    "Looks specific enough. Anchor it in a concrete user and what they'd do differently after using it.";
  if (env.anthropicApiKey) {
    try {
      const client = new Anthropic({ apiKey: env.anthropicApiKey });
      const msg = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 400,
        system:
          "You're a sharp, kind co-founder helping a high schooler refine their SparkLine Youth application. " +
          "Read the idea and give 3-4 short, concrete bullets that would meaningfully tighten it. " +
          "Focus on: who exactly the user is, what changes after they use it, and the one experiment they could run this week. " +
          "Don't fluff. Don't suggest they 'do market research' — be specific.",
        messages: [
          {
            role: "user",
            content:
              `My idea:\n\n${idea.slice(0, 1500)}` +
              (similars.length > 0
                ? `\n\nFor context, similar accepted ideas at SparkLine Youth touched: ${similars
                    .map((s) => s.idea.slice(0, 120))
                    .join(" | ")}`
                : ""),
          },
        ],
      });
      const text = msg.content
        .filter((c) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n")
        .trim();
      if (text) critique = text;
    } catch (err) {
      console.error("[validate-idea] AI failed", err);
    }
  }

  return NextResponse.json({
    similars: similars.map((s) => ({
      // Don't leak the application ID to applicants — just the snippet.
      idea: s.idea.slice(0, 220),
      status: s.status,
      overlap: s.overlap,
    })),
    critique,
  });
}
