/**
 * System prompt for the Sparkline Youth AI co-founder.
 * Designed to be cached (stable across the user's whole session).
 */
export function buildSystemPrompt(args: {
  studentName: string | null;
  startupContext: Record<string, any> | null;
  retrieval?: StudentRetrieval | null;
}): string {
  const ctx = args.startupContext ?? {};
  const ctxBlock = Object.keys(ctx).length
    ? `\n## Their startup context\n${Object.entries(ctx)
        .filter(([, v]) => v != null && v !== "")
        .map(([k, v]) => `- ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join("\n")}\n`
    : "\n## Their startup context\n(none yet — ask them about it)\n";

  const retrievalBlock = renderRetrieval(args.retrieval);

  return `You are the Sparkline Youth AI co-founder. Sparkline Youth is a live, online four-sprint program for high schoolers building real projects — startups, hardware, research, creative work, or social impact — ending in a Demo Day pitch to a sponsor-funded grant panel that awards cash prizes — students keep 100% of their equity.

Your job is to be a sharp, kind, no-bullshit thought partner for ${args.studentName ?? "the student"} — a high schooler — as they go through the program. You operate as a co-founder would: high agency, opinionated, useful.

## How you behave
- Be concrete. Always give the student something they can DO next.
- Be socratic when they need to think it through; be prescriptive when they need to ship.
- Cite frameworks (Lean Canvas, JTBD, customer interviews) by name only when useful — don't lecture.
- If their idea is weak, say so kindly and probe. Don't validate to be nice.
- High schoolers know more than people give them credit for. Don't condescend.
- Keep responses tight: usually 3–8 sentences or a short bulleted list. Long essays are usually a sign you're avoiding the point.

## What you can help with
- Idea pressure-testing
- Customer interview scripts + reading interview transcripts
- Lean Canvas + business model
- Pitch deck feedback
- Naming, positioning, and copy
- Outreach: emails to potential customers, mentors, investors
- Fundraising basics (SAFE, dilution, terms)
- Cofounder dynamics, time management, school/startup balance

## What you don't do
- Pretend to know about specific real-world events after your knowledge cutoff
- Make up statistics or studies
- Do their work for them when the value is in the struggle (e.g. talking to customers — you can prep but they have to do it)

## Format
Use markdown sparingly. Headers for >300-word responses; otherwise just plain paragraphs and tight bullets. Don't use code fences unless you're showing literal code or a structured artifact.

## Structured artifact prompts
If the student asks for a Lean Canvas, deck outline, customer-interview script, or cold-outreach email — produce it as a clearly delimited artifact (e.g. headers + bullets), grounded in what you know about their startup from the retrieval block. Don't ask for permission first; produce the artifact and then suggest what to tighten.
${ctxBlock}${retrievalBlock}`;
}

export type StudentRetrieval = {
  application?: {
    status: string;
    startup_idea: string | null;
    why_join: string | null;
    experience: string | null;
  } | null;
  team?: {
    name: string;
    tagline: string | null;
    description: string | null;
    member_count: number;
    submitted_pitch_at: string | null;
  } | null;
  latest_checkin?: {
    week_start: string;
    accomplished: string | null;
    next_up: string | null;
    blockers: string | null;
  } | null;
  // Up to N prior weekly check-ins, newest first, for trend awareness
  // — "you mentioned this blocker two weeks ago, did it get unstuck?"
  checkin_history?: Array<{
    week_start: string;
    accomplished: string | null;
    next_up: string | null;
    blockers: string | null;
  }> | null;
  // Recent peer/mentor messages on the team's thread — gives the AI
  // context for what teammates are debating without re-asking.
  team_messages?: Array<{
    author: string | null;
    body: string;
    created_at: string;
  }> | null;
};

function renderRetrieval(r: StudentRetrieval | null | undefined): string {
  if (!r) return "";
  const parts: string[] = [];
  parts.push(
    "\n## What you know about this student (live data — refer to it directly when relevant; don't dump it verbatim)",
  );
  if (r.application) {
    parts.push(
      `<application status="${r.application.status}">`,
      r.application.startup_idea
        ? `  <startup_idea>${truncate(r.application.startup_idea, 600)}</startup_idea>`
        : "",
      r.application.why_join
        ? `  <why_join>${truncate(r.application.why_join, 400)}</why_join>`
        : "",
      r.application.experience
        ? `  <experience>${truncate(r.application.experience, 400)}</experience>`
        : "",
      `</application>`,
    );
  }
  if (r.team) {
    parts.push(
      `<team name="${escapeXml(r.team.name)}" members="${r.team.member_count}">`,
      r.team.tagline
        ? `  <tagline>${escapeXml(r.team.tagline)}</tagline>`
        : "",
      r.team.description
        ? `  <description>${truncate(r.team.description, 600)}</description>`
        : "",
      r.team.submitted_pitch_at
        ? `  <demo_day_submitted_at>${r.team.submitted_pitch_at}</demo_day_submitted_at>`
        : "",
      `</team>`,
    );
  }
  if (r.latest_checkin) {
    parts.push(
      `<latest_checkin week="${r.latest_checkin.week_start}">`,
      r.latest_checkin.accomplished
        ? `  <accomplished>${truncate(r.latest_checkin.accomplished, 600)}</accomplished>`
        : "",
      r.latest_checkin.next_up
        ? `  <next_up>${truncate(r.latest_checkin.next_up, 400)}</next_up>`
        : "",
      r.latest_checkin.blockers
        ? `  <blockers>${truncate(r.latest_checkin.blockers, 400)}</blockers>`
        : "",
      `</latest_checkin>`,
    );
  }
  if (r.checkin_history && r.checkin_history.length > 0) {
    parts.push("<checkin_history>");
    for (const c of r.checkin_history) {
      parts.push(
        `  <week start="${c.week_start}">`,
        c.accomplished
          ? `    <accomplished>${truncate(c.accomplished, 300)}</accomplished>`
          : "",
        c.next_up
          ? `    <next_up>${truncate(c.next_up, 200)}</next_up>`
          : "",
        c.blockers
          ? `    <blockers>${truncate(c.blockers, 200)}</blockers>`
          : "",
        `  </week>`,
      );
    }
    parts.push("</checkin_history>");
  }
  if (r.team_messages && r.team_messages.length > 0) {
    parts.push("<recent_team_messages>");
    for (const m of r.team_messages) {
      parts.push(
        `  <msg author="${escapeXml(m.author ?? "anonymous")}">${truncate(m.body, 200)}</msg>`,
      );
    }
    parts.push("</recent_team_messages>");
  }
  return parts.filter(Boolean).join("\n") + "\n";
}

function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}
function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
