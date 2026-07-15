import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPassForUser } from "@/lib/founder-pass";
import { Card } from "@/components/ui/card";
import { FOUNDER_TOOLKIT, type ToolkitTemplate } from "@/lib/founder-toolkit";
import { CopyButton } from "./copy-button";

export const metadata: Metadata = {
  title: "Founder Toolkit — batch0",
  description:
    "batch0's startup-building templates: problem validation, customer interviews, lean canvas, MVP planning, landing pages, go-to-market, pitch decks, and a seven-day launch plan.",
};

// Reads the user's pass to gate access — never cache at the edge.
export const dynamic = "force-dynamic";

/** Serialize a template to markdown for the copy button. */
function toMarkdown(t: ToolkitTemplate): string {
  const lines = [`# ${t.title}`, "", t.purpose, ""];
  for (const s of t.sections) {
    lines.push(`## ${s.heading}`);
    for (const item of s.items) lines.push(`- ${item}`);
    lines.push("");
  }
  return lines.join("\n").trim();
}

export default async function ToolkitPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // The toolkit is a pass perk: hand a non-holder the door, not the room.
  const pass = user ? await getPassForUser(createAdminClient(), user.id) : null;
  if (!pass) redirect("/pass");

  return (
    <main className="mx-auto max-w-2xl px-5 py-16 md:py-24">
      <div className="text-center">
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.25em] text-phosphor-ink">
          Founder Toolkit
        </p>
        <h1 className="mt-3 font-display text-4xl leading-none text-ink md:text-5xl">
          Templates you'll actually finish
        </h1>
        <p className="mx-auto mt-4 max-w-md text-sm text-ink-soft">
          The worksheets and scripts we hand our own founders. Yours to use even
          if you don't join this cohort — copy one into your doc and fill it in.
        </p>
      </div>

      <div className="mt-10 space-y-5">
        {FOUNDER_TOOLKIT.map((t) => (
          <Card key={t.slug}>
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h2 className="font-display text-xl text-ink">{t.title}</h2>
                <p className="mt-1 text-sm text-ink-soft">{t.purpose}</p>
              </div>
              <CopyButton text={toMarkdown(t)} />
            </div>
            <div className="mt-4 space-y-4">
              {t.sections.map((s) => (
                <div key={s.heading}>
                  <h3 className="text-[11px] font-medium uppercase tracking-[0.18em] text-ink-faint">
                    {s.heading}
                  </h3>
                  <ul className="mt-2 space-y-1.5">
                    {s.items.map((item, i) => (
                      <li
                        key={i}
                        className="flex gap-2.5 text-sm text-ink-soft"
                      >
                        <span
                          aria-hidden
                          className="mt-2 h-1 w-1 shrink-0 rounded-full bg-phosphor-ink/50"
                        />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </Card>
        ))}
      </div>

      <div className="mt-10 text-center">
        <Link
          href="/pass"
          className="text-sm font-semibold text-phosphor-ink underline underline-offset-4"
        >
          ← Back to your pass
        </Link>
      </div>
    </main>
  );
}
