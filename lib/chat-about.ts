import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { ChatMessage } from "@/lib/chat";
import { loadThreadRows } from "@/lib/chat-thread-rows";
import { aboutHref, aboutTitle, type AboutChip, type AboutKind } from "@/lib/chat-threads-rules";

/**
 * "Ask about this": the lesson or assignment a #help question links to
 * (chat_threads.about_kind/about_id, migration 0110).
 *
 * A question in #help is read by everyone let in; a lesson or an assignment
 * by the cohort it belongs to (and the team). So the link stores an id and
 * nothing else, and its title is looked up for each viewer through THEIR OWN
 * database client: the item's read policy ("lessons read enrolled",
 * "course_assignments read") decides, exactly as on its own page. Someone
 * who can read the channel but not the item sees no chip — not its title,
 * not that there is one — and nothing a student wrote for the item (a draft,
 * a submission) is ever read here.
 */

type Ref = { kind: AboutKind; id: string };
type Db = Awaited<ReturnType<typeof createClient>>;

const key = (r: Ref) => `${r.kind}:${r.id}`;

/**
 * These items' chips, for whoever is signed in on `db` (their RLS client;
 * the default is the request's own). An item they can't read is simply
 * missing from the map; so is everything on a failed read.
 */
export async function resolveAbout(refs: readonly Ref[], db?: Db): Promise<Map<string, AboutChip>> {
  const out = new Map<string, AboutChip>();
  const lessons = Array.from(new Set(refs.filter((r) => r.kind === "lesson").map((r) => r.id)));
  const assignments = Array.from(new Set(refs.filter((r) => r.kind === "assignment").map((r) => r.id)));
  if (lessons.length === 0 && assignments.length === 0) return out;
  try {
    const client = db ?? (await createClient());
    const [l, a] = await Promise.all([
      lessons.length ? client.from("lessons").select("id, title").in("id", lessons) : Promise.resolve({ data: [], error: null }),
      assignments.length
        ? client.from("course_assignments").select("id, title").in("id", assignments)
        : Promise.resolve({ data: [], error: null }),
    ]);
    for (const [kind, res] of [["lesson", l], ["assignment", a]] as const) {
      if (res.error) continue;
      for (const row of (res.data ?? []) as { id: string; title: string | null }[]) {
        out.set(key({ kind, id: row.id }), { kind, id: row.id, title: aboutTitle(row.title), href: aboutHref(kind, row.id) });
      }
    }
  } catch (err) {
    console.error("[chat] resolving linked course items", (err as Error)?.message ?? err);
  }
  return out;
}

/** One item's chip for the signed-in viewer, or null when they can't read it. */
export async function aboutFor(ref: Ref, db?: Db): Promise<AboutChip | null> {
  return (await resolveAbout([ref], db)).get(key(ref)) ?? null;
}

/**
 * Put each question's course-item chip on it — for this viewer only, and
 * only where they can read the item. Messages without a thread row are
 * left alone; a failure leaves every chip off, never the wrong one on.
 */
export async function withAbout<M extends ChatMessage>(messages: M[], db?: Db): Promise<M[]> {
  const roots = messages.filter((m) => m.thread && !m.threadRootId).map((m) => m.id);
  if (roots.length === 0) return messages;
  const rows = await loadThreadRows(roots);
  const refs = new Map<string, Ref>();
  for (const [id, row] of rows) if (row.about) refs.set(id, row.about);
  if (refs.size === 0) return messages;
  const chips = await resolveAbout(Array.from(refs.values()), db);
  return messages.map((m) => {
    const ref = refs.get(m.id);
    const chip = ref ? chips.get(key(ref)) : undefined;
    return chip && m.thread ? { ...m, thread: { ...m.thread, about: chip } } : m;
  });
}
