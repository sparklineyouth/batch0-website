import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAllRoles } from "@/lib/roles";
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
  userA: string;
  userB: string;
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
  const { data } = await admin
    .from("profiles")
    .select("id, full_name, role")
    .in("id", ids as string[]);
  const people = await toPeople(data ?? []);
  return new Map(people.map((p) => [p.id, p]));
}

export async function getPerson(id: string): Promise<DmPerson | null> {
  return (await getPeople([id])).get(id) ?? null;
}

/**
 * The directory: anyone with an account, searchable by name.
 *
 * Deliberately site-wide rather than cohort-scoped — reaching the person you
 * need is the feature. Three exclusions, all of them about not leaking:
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

  let req = admin.from("profiles").select("id, full_name, role");
  if (q) {
    const escaped = q.replace(/[%,()]/g, " ").trim();
    if (!escaped) return [];
    req = viewer.moderates
      ? req.or(`full_name.ilike.%${escaped}%,email.ilike.%${escaped}%`)
      : req.ilike("full_name", `%${escaped}%`);
  }
  // Over-fetch so the block/self filtering below can't empty a full page.
  const { data } = await req
    .order("full_name", { ascending: true })
    .limit(limit + hidden.size + 10);

  const rows = (data ?? []).filter((r: any) => !hidden.has(r.id)).slice(0, limit);
  return toPeople(rows);
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/** Ids this user has blocked. */
export async function listBlockedIds(userId: string): Promise<string[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("dm_blocks")
    .select("blocked_id")
    .eq("blocker_id", userId);
  return (data ?? []).map((r: any) => r.blocked_id as string);
}

/**
 * Everyone on either side of a block with this user. Never surfaced as two
 * lists: which direction a block runs is not something the other party gets
 * to learn.
 */
export async function listBlockRelatedIds(userId: string): Promise<string[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("dm_blocks")
    .select("blocker_id, blocked_id")
    .or(`blocker_id.eq.${userId},blocked_id.eq.${userId}`);
  const ids = new Set<string>();
  for (const r of (data ?? []) as any[]) {
    ids.add(r.blocker_id === userId ? r.blocked_id : r.blocker_id);
  }
  return Array.from(ids);
}

/** Symmetric: is sending between these two frozen, whoever pressed block. */
export async function isBlockedBetween(x: string, y: string): Promise<boolean> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("dm_blocks")
    .select("blocker_id")
    .or(
      `and(blocker_id.eq.${x},blocked_id.eq.${y}),and(blocker_id.eq.${y},blocked_id.eq.${x})`,
    )
    .limit(1);
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
  const { data } = await admin.from("dm_conversations").select(CONVO_COLS).eq("id", id).maybeSingle();
  return data ? toConversation(data) : null;
}

/** The existing DM between two people, if there is one. */
export async function findConversation(
  x: string,
  y: string,
): Promise<DmConversation | null> {
  const { userA, userB } = orderPair(x, y);
  const admin = createAdminClient();
  const { data } = await admin
    .from("dm_conversations")
    .select(CONVO_COLS)
    .eq("user_a", userA)
    .eq("user_b", userB)
    .maybeSingle();
  return data ? toConversation(data) : null;
}

/** Has anyone reported this conversation? The staff read gate. */
export async function isReported(conversationId: string): Promise<boolean> {
  const admin = createAdminClient();
  const { count } = await admin
    .from("dm_reports")
    .select("id", { count: "exact", head: true })
    .eq("conversation_id", conversationId);
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
  const { data } = await admin
    .from("dm_conversations")
    .select(CONVO_COLS)
    .or(`user_a.eq.${userId},user_b.eq.${userId}`)
    // A conversation opened but never used sorts last rather than vanishing.
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(limit);

  const convos = (data ?? []).map(toConversation);
  const others = convos.map((c) => otherParticipant(c, userId));
  const people = await getPeople(others);

  return convos.map((c) => {
    const otherId = otherParticipant(c, userId);
    return {
      id: c.id,
      other:
        people.get(otherId) ??
        // The other account was deleted mid-flight. Keep the row rather than
        // drop the history it points at.
        { id: otherId, name: "Deleted account", roleLabel: null, isStaff: false },
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
  const { data } = await admin
    .from("dm_conversations")
    .select("user_a, user_b, a_last_read_at, b_last_read_at, last_message_at, last_sender_id, id")
    .or(`user_a.eq.${userId},user_b.eq.${userId}`)
    .not("last_message_at", "is", null)
    .neq("last_sender_id", userId)
    .limit(500);
  return (data ?? []).map(toConversation).filter((c) => hasUnread(c, userId)).length;
}

/**
 * Messages in posting order. Only call once the viewer has been cleared by
 * getConversationForViewer().
 */
export async function listMessages(
  conversationId: string,
  limit = 300,
): Promise<DmMessage[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("dm_messages")
    .select("id, conversation_id, sender_id, body, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(limit);

  const rows = data ?? [];
  const people = await getPeople(
    Array.from(new Set(rows.map((r: any) => r.sender_id as string))),
  );
  return rows.map((r: any) => ({
    id: r.id,
    conversationId: r.conversation_id,
    senderId: r.sender_id,
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
  const { data } = await req.order("created_at", { ascending: false }).limit(limit);

  const rows = data ?? [];
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

export async function listReportsForConversation(
  conversationId: string,
): Promise<DmReport[]> {
  return (await listReports("all", 500)).filter(
    (r) => r.conversationId === conversationId,
  );
}

/** The admin overview tile. */
export async function countOpenReports(): Promise<number> {
  const admin = createAdminClient();
  const { count } = await admin
    .from("dm_reports")
    .select("id", { count: "exact", head: true })
    .eq("status", "open");
  return count ?? 0;
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
