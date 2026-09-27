import "server-only";
import { cache } from "react";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAllRoles } from "@/lib/roles";
import { ACCEPTED_STATUSES } from "@/lib/pre-cohort";
import { can, type Capabilities } from "@/lib/permissions";
import {
  canReadConversation,
  cursorFor,
  hasUnread,
  orderPair,
  otherParticipant,
  type DmViewer,
  type ReportStatus,
} from "@/lib/dm-access";

/**
 * Reads for direct messages (migration 0089).
 *
 * Service-role reads with explicit per-viewer filters, the same shape as
 * lib/discussions.ts. The reason it can't be plain RLS from the browser: a
 * student may only read their OWN `profiles` row, and every screen here needs
 * the other person's name — an inbox of "unknown" would be useless. So the
 * name lookup happens here, on the server, and every function narrows to the
 * viewer it was handed. RLS stays on as the backstop, not as the thing that
 * saves us.
 *
 * Emails never enter a shape that reaches a student. `authorEmail`-style
 * leakage is the one mistake that matters most in a feature whose whole point
 * is putting strangers in touch, so the person shapes below carry a name, a
 * role label, and nothing else.
 */

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** A person as anyone is allowed to see them. No email, ever. */
export type DmPerson = {
  id: string;
  name: string;
  /** Human label for their role ("Mentor", "batch0 team"), or null. */
  roleLabel: string | null;
  /** True for staff/admin-ish roles, so the UI can badge them. */
  isStaff: boolean;
};

export type DmConversation = {
  id: string;
  /** Null once that account has been deleted (0089: on delete set null). */
  userA: string | null;
  userB: string | null;
  aLastReadAt: string;
  bLastReadAt: string;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  lastSenderId: string | null;
  messageCount: number;
  createdAt: string;
};

/** A conversation resolved for one viewer: the other person, and their state. */
export type DmInboxRow = {
  id: string;
  other: DmPerson;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  /** True when the last message was the viewer's own. */
  lastFromSelf: boolean;
  unread: boolean;
  messageCount: number;
};

export type DmMessage = {
  id: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  body: string;
  createdAt: string;
};

export type DmReport = {
  id: string;
  conversationId: string;
  reporterId: string | null;
  reporterName: string;
  reason: string;
  status: ReportStatus;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
};

const CONVO_COLS = `
  id, user_a, user_b, a_last_read_at, b_last_read_at, last_message_at,
  last_message_preview, last_sender_id, message_count, created_at
`;

/**
 * A failed read throws rather than returning nothing. Every caller here used
 * to read only `data`, so a dropped connection or a missing table rendered as
 * an empty inbox, an empty thread, or — worst — "nobody has blocked anybody".
 */
function must<T>(res: { data: T | null; error: { message: string } | null }, what: string): T | null {
  if (res.error) throw new Error(`Couldn't load ${what}: ${res.error.message}`);
  return res.data;
}

function toConversation(row: any): DmConversation {
  return {
    id: row.id,
    userA: row.user_a,
    userB: row.user_b,
    aLastReadAt: row.a_last_read_at,
    bLastReadAt: row.b_last_read_at,
    lastMessageAt: row.last_message_at,
    lastMessagePreview: row.last_message_preview,
    lastSenderId: row.last_sender_id,
    messageCount: row.message_count ?? 0,
    createdAt: row.created_at,
  };
}

/**
 * The other side of a conversation whose account has been deleted. The id is
 * a per-conversation placeholder, never a profile id, so nothing downstream
 * can block, message or look up "them".
 */
export function deletedPerson(conversationId: string): DmPerson {
  return { id: `deleted:${conversationId}`, name: "Deleted account", roleLabel: null, isStaff: false };
}

/** A name to show. Never the email — that's not ours to hand out. */
function displayName(p: { full_name?: string | null } | null): string {
  return p?.full_name?.trim() || "A batch0 member";
}

// ---------------------------------------------------------------------------
// Viewer
// ---------------------------------------------------------------------------

export async function getDmViewer(
  userId: string,
  caps: Capabilities | null,
): Promise<DmViewer> {
  return { userId, moderates: can(caps, "moderation.manage") };
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

/**
 * Role slug → label, and whether it's a staff-ish role. Built from the roles
 * table so a custom role ("Coach", "TA") labels itself correctly without a
 * deploy. A role carrying the '*' wildcard or any admin-area permission reads
 * as the team.
 */
async function roleMeta(): Promise<Map<string, { label: string; isStaff: boolean }>> {
  const roles = await getAllRoles();
  const m = new Map<string, { label: string; isStaff: boolean }>();
  for (const r of roles) {
    const isStaff =
      r.permissions.includes("*") || r.permissions.includes("moderation.manage");
    m.set(r.slug, { label: r.label, isStaff });
  }
  return m;
}

/** Turn profile rows into person shapes, resolving role labels once. */
async function toPeople(rows: any[]): Promise<DmPerson[]> {
  const meta = await roleMeta();
  return rows.map((r) => {
    const info = meta.get(r.role);
    return {
      id: r.id,
      name: displayName(r),
      roleLabel: info?.label ?? null,
      isStaff: !!info?.isStaff,
    };
  });
}

export async function getPeople(ids: readonly string[]): Promise<Map<string, DmPerson>> {
  if (ids.length === 0) return new Map();
  const admin = createAdminClient();
  const data = must(
    await admin.from("profiles").select("id, full_name, role").in("id", ids as string[]),
    "people",
  );
  const people = await toPeople(data ?? []);
  return new Map(people.map((p) => [p.id, p]));
}

export async function getPerson(id: string): Promise<DmPerson | null> {
  return (await getPeople([id])).get(id) ?? null;
}

// ---------------------------------------------------------------------------
// Who can reach whom
//
// Signing up is instant and unverified, and most accounts belong to high
// schoolers. So the open graph is open to people who have been LET IN:
//
//   the team      (a '*' or moderation.manage role) reaches, and is reachable
//                 by, everyone — an applicant can always ask admissions;
//   vetted people (any other non-student role — mentors, investors, custom
//                 team roles — and students who were accepted or enrolled)
//                 reach each other;
//   everyone else (a fresh signup) reaches the team only, and is not listed
//                 in anyone else's directory.
//
// An existing conversation is never cut off by this: someone the team wrote
// to can always reply.
// ---------------------------------------------------------------------------

/** Every student who has been let in: an enrollment, or an accepted application. */
const vettedStudentIds = cache(async function vettedStudentIds(): Promise<Set<string>> {
  const admin = createAdminClient();
  const [enr, apps] = await Promise.all([
    admin.from("enrollments").select("user_id").limit(10000),
    admin
      .from("applications")
      .select("user_id")
      .in("status", ACCEPTED_STATUSES as unknown as string[])
      .limit(10000),
  ]);
  const ids = new Set<string>();
  for (const r of (must(enr, "enrollments") ?? []) as any[]) if (r.user_id) ids.add(r.user_id);
  for (const r of (must(apps, "applications") ?? []) as any[]) if (r.user_id) ids.add(r.user_id);
  return ids;
});

/** Role slugs that count as the team. */
async function staffRoleSlugs(): Promise<string[]> {
  const meta = await roleMeta();
  return Array.from(meta.entries())
    .filter(([, m]) => m.isStaff)
    .map(([slug]) => slug);
}

/** Of these people, who has been let in (see above). Staff included. */
export async function vettedIds(ids: readonly string[]): Promise<Set<string>> {
  const unique = Array.from(new Set(ids.filter(Boolean)));
  if (unique.length === 0) return new Set();
  const admin = createAdminClient();
  const rows = (must(
    await admin.from("profiles").select("id, role").in("id", unique),
    "people",
  ) ?? []) as { id: string; role: string | null }[];
  const students = await vettedStudentIds();
  const out = new Set<string>();
  for (const r of rows) {
    if ((r.role && r.role !== "student") || students.has(r.id)) out.add(r.id);
  }
  return out;
}

/**
 * May `actor` open a NEW conversation with `recipient`? The reason is for the
 * actor: it never says anything about the recipient beyond "not available".
 */
export async function canStartConversation(
  actor: DmViewer,
  recipient: DmPerson,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (actor.moderates || recipient.isStaff) return { ok: true };
  const vetted = await vettedIds([actor.userId, recipient.id]);
  if (!vetted.has(actor.userId)) {
    const me = await getPerson(actor.userId);
    if (me?.isStaff) return { ok: true };
    return {
      ok: false,
      reason:
        "For now you can message the batch0 team. Messaging other people opens once you've been accepted.",
    };
  }
  if (!vetted.has(recipient.id)) return { ok: false, reason: "That person isn't available." };
  return { ok: true };
}

/**
 * The directory: searchable by name, and scoped by who the viewer may reach
 * (see "Who can reach whom"). Three exclusions on top, all about not leaking:
 *
 *   - the viewer themselves
 *   - anyone either side of a block, in both directions. Showing someone who
 *     blocked you and then failing the send would announce the block; silence
 *     is the point of one.
 *   - email matching, unless the searcher is staff. A student typing a
 *     guessed address must not get a hit that confirms it.
 */
export async function searchDirectory(
  query: string,
  viewer: DmViewer,
  limit = 20,
): Promise<DmPerson[]> {
  const q = query.trim();
  const admin = createAdminClient();
  const hidden = new Set<string>([viewer.userId, ...(await listBlockRelatedIds(viewer.userId))]);
  const escaped = q.replace(/[%,()"\\]/g, " ").trim();
  if (q && !escaped) return [];

  const byName = (req: any) => {
    if (!escaped) return req;
    return viewer.moderates
      ? req.or(`full_name.ilike.%${escaped}%,email.ilike.%${escaped}%`)
      : req.ilike("full_name", `%${escaped}%`);
  };
  const base = () => admin.from("profiles").select("id, full_name, role");
  const pageSize = limit + hidden.size + 10;

  let rows: any[] = [];
  const me = viewer.moderates ? null : await getPerson(viewer.userId);
  if (viewer.moderates || me?.isStaff) {
    // The team sees everyone.
    rows =
      must(await byName(base()).order("full_name", { ascending: true }).limit(pageSize), "people") ?? [];
  } else {
    const staff = await staffRoleSlugs();
    const vettedMe = (await vettedIds([viewer.userId])).has(viewer.userId);
    if (!vettedMe) {
      // Not let in yet: the team, and nobody else.
      rows = staff.length
        ? must(
            await byName(base().in("role", staff)).order("full_name", { ascending: true }).limit(pageSize),
            "people",
          ) ?? []
        : [];
    } else {
      // Let in: everyone else who has been let in. Non-student roles in one
      // query; accepted and enrolled students by id, in chunks short enough
      // for a URL.
      const nonStudents: any[] =
        must(
          await byName(base().neq("role", "student")).order("full_name", { ascending: true }).limit(pageSize),
          "people",
        ) ?? [];
      const studentIds = Array.from(await vettedStudentIds());
      const chunks: string[][] = [];
      for (let i = 0; i < studentIds.length; i += 150) chunks.push(studentIds.slice(i, i + 150));
      const students: any[] = (
        await Promise.all<any[]>(
          chunks.map(async (ids) =>
            must(
              await byName(base().in("id", ids).eq("role", "student"))
                .order("full_name", { ascending: true })
                .limit(pageSize),
              "people",
            ) ?? [],
          ),
        )
      ).flat();
      rows = [...nonStudents, ...students].sort((a, b) =>
        String(a.full_name ?? "").localeCompare(String(b.full_name ?? "")),
      );
    }
  }

  const seen = new Set<string>();
  const picked = rows
    .filter((r: any) => {
      if (hidden.has(r.id) || seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    })
    .slice(0, limit);
  return toPeople(picked);
}

/** Does this user owe a fine? A fined account is locked out of everything but paying it. */
export async function hasPendingFineFor(userId: string): Promise<boolean> {
  const admin = createAdminClient();
  const data = must(
    await admin
      .from("user_charges")
      .select("id")
      .eq("user_id", userId)
      .eq("kind", "fine")
      .eq("status", "pending")
      .limit(1),
    "charges",
  );
  return (data ?? []).length > 0;
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/** Ids this user has blocked. */
export async function listBlockedIds(userId: string): Promise<string[]> {
  const admin = createAdminClient();
  const data = must(
    await admin.from("dm_blocks").select("blocked_id").eq("blocker_id", userId),
    "blocks",
  );
  return (data ?? []).map((r: any) => r.blocked_id as string);
}

/**
 * Everyone on either side of a block with this user. Never surfaced as two
 * lists: which direction a block runs is not something the other party gets
 * to learn.
 */
export async function listBlockRelatedIds(userId: string): Promise<string[]> {
  const admin = createAdminClient();
  const data = must(
    await admin
      .from("dm_blocks")
      .select("blocker_id, blocked_id")
      .or(`blocker_id.eq.${userId},blocked_id.eq.${userId}`),
    "blocks",
  );
  const ids = new Set<string>();
  for (const r of (data ?? []) as any[]) {
    ids.add(r.blocker_id === userId ? r.blocked_id : r.blocker_id);
  }
  return Array.from(ids);
}

/**
 * Symmetric: is sending between these two frozen, whoever pressed block.
 * Fails closed — an error throws (and the send is refused) rather than
 * reading as "not blocked".
 */
export async function isBlockedBetween(x: string, y: string): Promise<boolean> {
  const admin = createAdminClient();
  const data = must(
    await admin
      .from("dm_blocks")
      .select("blocker_id")
      .or(
        `and(blocker_id.eq.${x},blocked_id.eq.${y}),and(blocker_id.eq.${y},blocked_id.eq.${x})`,
      )
      .limit(1),
    "blocks",
  );
  return (data ?? []).length > 0;
}

/** The viewer's own block list, as people. Powers the "Blocked" settings list. */
export async function listBlockedPeople(userId: string): Promise<DmPerson[]> {
  const ids = await listBlockedIds(userId);
  if (ids.length === 0) return [];
  const map = await getPeople(ids);
  return ids.map((id) => map.get(id)).filter((p): p is DmPerson => !!p);
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

/** Raw conversation row, with no viewer check. Callers must do their own. */
export async function getConversationRow(id: string): Promise<DmConversation | null> {
  const admin = createAdminClient();
  const data = must(
    await admin.from("dm_conversations").select(CONVO_COLS).eq("id", id).maybeSingle(),
    "the conversation",
  );
  return data ? toConversation(data) : null;
}

/** The existing DM between two people, if there is one. */
export async function findConversation(
  x: string,
  y: string,
): Promise<DmConversation | null> {
  const { userA, userB } = orderPair(x, y);
  const admin = createAdminClient();
  const data = must(
    await admin
      .from("dm_conversations")
      .select(CONVO_COLS)
      .eq("user_a", userA)
      .eq("user_b", userB)
      .maybeSingle(),
    "the conversation",
  );
  return data ? toConversation(data) : null;
}

/** Has anyone reported this conversation? The staff read gate. */
export async function isReported(conversationId: string): Promise<boolean> {
  const admin = createAdminClient();
  const { count, error } = await admin
    .from("dm_reports")
    .select("id", { count: "exact", head: true })
    .eq("conversation_id", conversationId);
  if (error) throw new Error(`Couldn't load reports: ${error.message}`);
  return (count ?? 0) > 0;
}

/**
 * One conversation, or null when it doesn't exist OR the viewer may not read
 * it. The two cases are deliberately indistinguishable — a DM must not
 * confirm its own existence to a stranger who guessed the id.
 */
export async function getConversationForViewer(
  id: string,
  viewer: DmViewer,
): Promise<DmConversation | null> {
  const convo = await getConversationRow(id);
  if (!convo) return null;
  // Only pay for the report lookup when it could change the answer.
  const reported = viewer.moderates ? await isReported(id) : false;
  return canReadConversation(convo, viewer, reported) ? convo : null;
}

/** The viewer's inbox, most recent first. One query plus one name lookup. */
export async function listInbox(userId: string, limit = 50): Promise<DmInboxRow[]> {
  const admin = createAdminClient();
  const data = must(
    await admin
      .from("dm_conversations")
      .select(CONVO_COLS)
      .or(`user_a.eq.${userId},user_b.eq.${userId}`)
      // A conversation opened but never used sorts last rather than vanishing.
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(limit),
    "your conversations",
  );

  const convos = (data ?? []).map(toConversation);
  const others = convos
    .map((c) => otherParticipant(c, userId))
    .filter((id): id is string => !!id);
  const people = await getPeople(others);

  return convos.map((c) => {
    const otherId = otherParticipant(c, userId);
    return {
      id: c.id,
      other:
        (otherId ? people.get(otherId) : null) ??
        // The other account was deleted. Keep the row rather than drop the
        // history it points at.
        deletedPerson(c.id),
      lastMessageAt: c.lastMessageAt,
      lastMessagePreview: c.lastMessagePreview,
      lastFromSelf: c.lastSenderId === userId,
      unread: hasUnread(c, userId),
      messageCount: c.messageCount,
    };
  });
}

/** How many conversations have something unread. The badge on the launcher. */
export async function countUnreadConversations(userId: string): Promise<number> {
  const admin = createAdminClient();
  const data = must(
    await admin
      .from("dm_conversations")
      .select("user_a, user_b, a_last_read_at, b_last_read_at, last_message_at, last_sender_id, id")
      .or(`user_a.eq.${userId},user_b.eq.${userId}`)
      .not("last_message_at", "is", null)
      .neq("last_sender_id", userId)
      .limit(500),
    "unread count",
  );
  return (data ?? []).map(toConversation).filter((c) => hasUnread(c, userId)).length;
}

/**
 * The newest `limit` messages, in posting order. Only call once the viewer has
 * been cleared by getConversationForViewer().
 *
 * Newest, not oldest: this used to take the FIRST `limit` rows, so a long
 * conversation opened on its beginning with everything recent missing — and
 * then marked the missing messages read.
 */
export async function listMessages(
  conversationId: string,
  limit = 300,
): Promise<DmMessage[]> {
  const admin = createAdminClient();
  const data = must(
    await admin
      .from("dm_messages")
      .select("id, conversation_id, sender_id, body, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit),
    "messages",
  );

  const rows = (data ?? []).slice().reverse();
  const people = await getPeople(
    Array.from(new Set(rows.map((r: any) => r.sender_id as string | null).filter((id): id is string => !!id))),
  );
  return rows.map((r: any) => ({
    id: r.id,
    conversationId: r.conversation_id,
    // "" for a deleted sender: never equal to any viewer's id, so their
    // words render as the other side's, attributed to "Deleted account".
    senderId: r.sender_id ?? "",
    senderName: people.get(r.sender_id)?.name ?? "Deleted account",
    body: r.body,
    createdAt: r.created_at,
  }));
}

/** The viewer's own read cursor, for rendering "new messages" dividers. */
export function viewerCursor(c: DmConversation, userId: string): string {
  return cursorFor(c, userId);
}

// ---------------------------------------------------------------------------
// Moderation (callers hold moderation.manage)
// ---------------------------------------------------------------------------

export async function listReports(
  status: ReportStatus | "all" = "open",
  limit = 200,
): Promise<DmReport[]> {
  const admin = createAdminClient();
  let req = admin
    .from("dm_reports")
    .select("id, conversation_id, reporter_id, reason, status, reviewed_by, reviewed_at, created_at");
  if (status !== "all") req = req.eq("status", status);
  const data = must(await req.order("created_at", { ascending: false }).limit(limit), "reports");
  return hydrateReports(data ?? []);
}

async function hydrateReports(rows: any[]): Promise<DmReport[]> {
  const people = await getPeople(
    Array.from(
      new Set(rows.map((r: any) => r.reporter_id as string | null).filter(Boolean) as string[]),
    ),
  );
  return rows.map((r: any) => ({
    id: r.id,
    conversationId: r.conversation_id,
    reporterId: r.reporter_id,
    reporterName: r.reporter_id
      ? (people.get(r.reporter_id)?.name ?? "Deleted account")
      : "Deleted account",
    reason: r.reason,
    status: r.status,
    reviewedBy: r.reviewed_by,
    reviewedAt: r.reviewed_at,
    createdAt: r.created_at,
  }));
}

/** Every report on one conversation — queried by it, not filtered from a site-wide page. */
export async function listReportsForConversation(
  conversationId: string,
): Promise<DmReport[]> {
  const admin = createAdminClient();
  const data = must(
    await admin
      .from("dm_reports")
      .select("id, conversation_id, reporter_id, reason, status, reviewed_by, reviewed_at, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false }),
    "reports",
  );
  return hydrateReports(data ?? []);
}

/**
 * The admin overview tile. Leaves out reports on the viewer's own
 * conversations, like the queue does — a moderator who is the person reported
 * must not learn that a report exists.
 */
export async function countOpenReports(viewerId: string): Promise<number> {
  const admin = createAdminClient();
  const rows = must(
    await admin.from("dm_reports").select("conversation_id").eq("status", "open").limit(1000),
    "reports",
  ) as { conversation_id: string }[] | null;
  if (!rows?.length) return 0;
  const ids = Array.from(new Set(rows.map((r) => r.conversation_id)));
  const mine = must(
    await admin
      .from("dm_conversations")
      .select("id")
      .in("id", ids)
      .or(`user_a.eq.${viewerId},user_b.eq.${viewerId}`),
    "conversations",
  ) as { id: string }[] | null;
  const exclude = new Set((mine ?? []).map((c) => c.id));
  return rows.filter((r) => !exclude.has(r.conversation_id)).length;
}

/** Everyone who should hear about a new report. Mirrors listDiscussionTeamIds(). */
export async function listModeratorIds(): Promise<string[]> {
  const roles = await getAllRoles();
  const slugs = roles
    .filter(
      (r) => r.permissions.includes("*") || r.permissions.includes("moderation.manage"),
    )
    .map((r) => r.slug);
  if (slugs.length === 0) return [];
  const admin = createAdminClient();
  const { data } = await admin.from("profiles").select("id").in("role", slugs).limit(500);
  return (data ?? []).map((p: any) => p.id as string);
}
