import { sessionTime, type PublicSession } from "@/lib/offer-format";

export function PublicTimetable({ sessions, contactEmail }: { sessions: PublicSession[]; contactEmail: string }) {
  return (
    <section id="schedule" aria-labelledby="schedule-heading" className="border-t border-line px-5 py-16 sm:px-6">
      <div className="mx-auto grid max-w-[1100px] gap-8 md:grid-cols-12">
        <div className="md:col-span-4">
          <h2 id="schedule-heading" className="font-display text-4xl leading-tight">The live calendar</h2>
          <p className="mt-4 text-sm leading-relaxed text-ink-soft">All times are U.S. Eastern. The calendar accounts for the November change from EDT to EST. Plan for 5–10 hours a week, including sessions and independent work.</p>
          <p className="mt-4 text-sm leading-relaxed text-ink-soft">Sessions run inside Batch0. Joining links are available to enrolled students in Events.</p>
        </div>
        <div className="md:col-span-8">
          {sessions.length ? <ol className="border-t border-line">{sessions.map(session => (
            <li key={session.id} className="border-b border-line py-4">
              <p className="text-sm font-semibold text-ink">{session.title}</p>
              <p className="mt-1 text-sm text-ink-soft"><time dateTime={session.starts_at}>{sessionTime(session)}</time></p>
            </li>
          ))}</ol> : <p className="border-y border-line py-6 text-sm leading-relaxed text-ink-soft">Session times for this cohort have not been published yet. <a className="link-ink" href={`mailto:${contactEmail}`}>Ask the team about the schedule</a> before making a payment.</p>}
          <p className="mt-4 text-xs leading-relaxed text-ink-soft">If a session does not fit your schedule, ask us about the catch-up options before enrolling. Course readings and workbooks are available in the student dashboard; recordings are not promised for every session.</p>
        </div>
      </div>
    </section>
  );
}
