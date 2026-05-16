"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { assertSelf } from "@/lib/server-guards";
import { notify } from "@/lib/notifications";
import { checkRateLimit } from "@/lib/rate-limit";
import { reserveTeamSlug, slugify } from "@/lib/team";

function safeSegment(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

async function getEnrollment(userId: string) {
  const admin = createAdminClient();
  const { data } = await admin
    .from("enrollments")
    .select("cohort_id")
    .eq("user_id", userId)
    .order("enrolled_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.cohort_id ?? null;
}

async function assertTeamMember(userId: string, teamId: string) {
  const admin = createAdminClient();
  const { data } = await admin
    .from("team_members")
    .select("id, role")
    .eq("team_id", teamId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) throw new Error("You aren't a member of that team.");
  return data;
}

async function getTeamCohortId(teamId: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("teams")
    .select("cohort_id")
    .eq("id", teamId)
    .maybeSingle();
  return data?.cohort_id ?? null;
}

async function isEnrolledInCohort(
  userId: string,
  cohortId: string,
): Promise<boolean> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("enrollments")
    .select("id")
    .eq("user_id", userId)
    .eq("cohort_id", cohortId)
    .limit(1)
    .maybeSingle();
  return !!data;
}

// ---------------------------------------------------------------------------
// Team lifecycle
// ---------------------------------------------------------------------------

export async function createTeam(input: { name: string }) {
  const { userId } = await assertSelf();
  const name = input.name.trim();
  if (name.length < 2) throw new Error("Team name is too short.");
  if (name.length > 60) throw new Error("Keep the team name under 60 chars.");

  const admin = createAdminClient();
  // Block creating if already on a team for this cohort.
  const existing = await admin
    .from("team_members")
    .select("id")
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();
  if (existing.data) {
    throw new Error("You're already on a team. Leave it before creating a new one.");
  }

  const cohortId = await getEnrollment(userId);
  if (!cohortId) {
    throw new Error("You need to be enrolled in a cohort to start a team.");
  }

  const slug = await reserveTeamSlug(cohortId, name);
  const { data: team, error } = await admin
    .from("teams")
    .insert({
      cohort_id: cohortId,
      slug,
      name,
      creator_id: userId,
      is_public: false,
      logo_status: "approved",
    })
    .select("id, slug")
    .single();
  if (error) throw new Error(error.message);

  await admin.from("team_members").insert({
    team_id: team!.id,
    user_id: userId,
    role: "founder",
  });

  revalidatePath("/dashboard/team");
  return team!.id as string;
}

export async function leaveTeam() {
  const { userId } = await assertSelf();
  const admin = createAdminClient();
  const { data: membership } = await admin
    .from("team_members")
    .select("id, team_id, role")
    .eq("user_id", userId)
    .maybeSingle();
  if (!membership) return;

  // If they're the last member, soft-delete the team — clearing the
  // membership leaves an orphan team otherwise.
  const { count } = await admin
    .from("team_members")
    .select("id", { count: "exact", head: true })
    .eq("team_id", membership.team_id);

  await admin.from("team_members").delete().eq("id", membership.id);

  if ((count ?? 0) <= 1) {
    // Last one out — flush the team's storage prefixes before deleting
    // the row so we don't leave orphan bytes paying rent in the bucket.
    // DB rows under team_drive_files cascade-delete via FK; this clears
    // the actual storage objects + the logo.
    await purgeTeamStorage(admin, membership.team_id);
    await admin.from("teams").delete().eq("id", membership.team_id);
  }

  revalidatePath("/dashboard/team");
}

async function purgeTeamStorage(
  admin: ReturnType<typeof createAdminClient>,
  teamId: string,
) {
  for (const bucket of ["team-drive", "team-logos"] as const) {
    try {
      const { data } = await admin.storage.from(bucket).list(teamId, {
        limit: 1000,
      });
      const paths = (data ?? []).map((o: any) => `${teamId}/${o.name}`);
      if (paths.length > 0) {
        await admin.storage.from(bucket).remove(paths);
      }
      // The team-drive bucket has nested `<teamId>/drive/*` files. List
      // and remove those too.
      const { data: nested } = await admin.storage
        .from(bucket)
        .list(`${teamId}/drive`, { limit: 1000 });
      const nestedPaths = (nested ?? []).map(
        (o: any) => `${teamId}/drive/${o.name}`,
      );
      if (nestedPaths.length > 0) {
        await admin.storage.from(bucket).remove(nestedPaths);
      }
    } catch (err) {
      console.error("[purgeTeamStorage] bucket failed:", bucket, err);
    }
  }
}

// ---------------------------------------------------------------------------
// Profile edits (name, tagline, description, website, public toggle)
// ---------------------------------------------------------------------------

export async function updateTeamInfo(input: {
  teamId: string;
  name?: string;
  tagline?: string | null;
  description?: string | null;
  website_url?: string | null;
}) {
  const { userId } = await assertSelf();
  await assertTeamMember(userId, input.teamId);

  const patch: Record<string, any> = {};
  if (input.name != null) {
    const name = input.name.trim();
    if (name.length < 2 || name.length > 60) {
      throw new Error("Team name must be 2–60 chars.");
    }
    patch.name = name;
  }
  if (input.tagline !== undefined) {
    patch.tagline = (input.tagline ?? "").trim().slice(0, 120) || null;
  }
  if (input.description !== undefined) {
    patch.description =
      (input.description ?? "").trim().slice(0, 4000) || null;
  }
  if (input.website_url !== undefined) {
    const u = (input.website_url ?? "").trim();
    if (u && !/^https?:\/\//i.test(u)) {
      throw new Error("Website must start with http(s)://");
    }
    patch.website_url = u || null;
  }
  if (Object.keys(patch).length === 0) return;

  const admin = createAdminClient();
  const { error } = await admin
    .from("teams")
    .update(patch)
    .eq("id", input.teamId);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard/team");
  revalidatePath(`/cohort/${input.teamId}`);
}

// ---------------------------------------------------------------------------
// Logo: upload via signed URL, then submit a logo_url for admin moderation
// ---------------------------------------------------------------------------

export async function getTeamLogoUploadToken(input: {
  teamId: string;
  filename: string;
}) {
  const { userId } = await assertSelf();
  await assertTeamMember(userId, input.teamId);

  const dot = input.filename.lastIndexOf(".");
  const base = dot > 0 ? input.filename.slice(0, dot) : input.filename;
  const ext = dot > 0 ? input.filename.slice(dot + 1).toLowerCase() : "png";
  // SVGs deliberately excluded — they can carry <script> + tracking pixels.
  // Rasterized images only.
  if (!["png", "jpg", "jpeg", "webp", "gif"].includes(ext)) {
    throw new Error("Logo must be a PNG, JPG, WEBP, or GIF.");
  }
  const stamp = Date.now();
  const path = `${input.teamId}/logo-${safeSegment(base)}-${stamp}.${ext}`;

  const admin = createAdminClient();
  const { data, error } = await admin.storage
    .from("team-logos")
    .createSignedUploadUrl(path);
  if (error) throw new Error(error.message);
  return { path: data.path, token: data.token };
}

export async function setTeamLogo(input: {
  teamId: string;
  path: string;
}) {
  const { userId } = await assertSelf();
  await assertTeamMember(userId, input.teamId);
  if (!input.path.startsWith(`${input.teamId}/`)) {
    throw new Error("Path doesn't belong to your team.");
  }
  const admin = createAdminClient();
  const { data: pub } = admin.storage.from("team-logos").getPublicUrl(input.path);
  const publicUrl = pub.publicUrl;

  // Mark pending. A safety check + admin moderation gates the public display.
  const { error } = await admin
    .from("teams")
    .update({
      logo_url: publicUrl,
      logo_status: "pending",
      logo_rejected_reason: null,
    })
    .eq("id", input.teamId);
  if (error) throw new Error(error.message);

  // Best-effort AI safety pre-check. Auto-rejects clear policy violations
  // but defers any final call to admin moderation.
  try {
    await runLogoSafetyCheck(input.teamId, publicUrl);
  } catch (err) {
    console.error("[team-logo] safety check failed:", err);
  }

  // Ping admins so the moderation queue gets attention.
  try {
    const { data: admins } = await admin
      .from("profiles")
      .select("id")
      .eq("role", "admin");
    for (const a of admins ?? []) {
      await notify({
        userId: a.id,
        type: "team_logo_pending",
        title: "Team logo pending review",
        body: "A team uploaded a new logo for moderation.",
        link: "/admin/moderation",
      });
    }
  } catch {}

  revalidatePath("/dashboard/team");
  revalidatePath("/admin/moderation");
}

async function runLogoSafetyCheck(teamId: string, publicUrl: string) {
  if (!process.env.ANTHROPIC_API_KEY) return;
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const res = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 200,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "url", url: publicUrl },
          } as any,
          {
            type: "text",
            text:
              "You are screening a logo for an accelerator program that serves high schoolers (minors). " +
              "Reply with a single JSON object: " +
              '{"safe": boolean, "reason": string|null}. ' +
              "Flag (safe=false) if the image contains nudity, sexual content, " +
              "graphic violence, hate symbols, illegal activity, identifiable minors as the subject, " +
              "or other content unfit for a school context. " +
              "Plain logos / typography / abstract art = safe. Only return the JSON.",
          },
        ],
      },
    ],
  });
  const text =
    res.content
      .map((b: any) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim() || "{}";
  let parsed: { safe?: boolean; reason?: string | null } = {};
  try {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    parsed = JSON.parse(start >= 0 ? text.slice(start, end + 1) : text);
  } catch {}
  if (parsed.safe === false) {
    const admin = createAdminClient();
    await admin
      .from("teams")
      .update({
        logo_status: "rejected",
        logo_rejected_reason:
          (parsed.reason ?? "Failed automated safety check.").slice(0, 240),
      })
      .eq("id", teamId);
  }
}

export async function clearTeamLogo(input: { teamId: string }) {
  const { userId } = await assertSelf();
  await assertTeamMember(userId, input.teamId);
  const admin = createAdminClient();
  await admin
    .from("teams")
    .update({
      logo_url: null,
      logo_status: "approved",
      logo_rejected_reason: null,
    })
    .eq("id", input.teamId);
  revalidatePath("/dashboard/team");
}

// ---------------------------------------------------------------------------
// Invites — search for a user by email/username (full_name), send, accept,
// decline, cancel.
// ---------------------------------------------------------------------------

export async function searchStudentsForInvite(input: {
  teamId: string;
  query: string;
}): Promise<{ id: string; full_name: string | null; email: string }[]> {
  const { userId } = await assertSelf();
  await assertTeamMember(userId, input.teamId);
  // Strip everything that could break PostgREST's .or() filter syntax
  // (commas, parens, asterisks). Only safe identifier-ish characters
  // survive — emails and names will pass through unchanged.
  const q = input.query.trim().replace(/[^a-zA-Z0-9@._\- ]+/g, "");
  if (q.length < 2) return [];
  const admin = createAdminClient();

  // Restrict the search to students enrolled in the same cohort as the
  // team — inviting unenrolled students used to send them a notification
  // they couldn't act on.
  const cohortId = await getTeamCohortId(input.teamId);
  if (!cohortId) return [];

  // Search by email OR full_name, students only, excluding anyone already
  // on a team.
  const { data } = await admin
    .from("profiles")
    .select("id, full_name, email, role")
    .or(`email.ilike.%${q}%,full_name.ilike.%${q}%`)
    .eq("role", "student")
    .limit(40);

  const ids = (data ?? []).map((p) => p.id);
  if (ids.length === 0) return [];
  const { data: enrolled } = await admin
    .from("enrollments")
    .select("user_id")
    .eq("cohort_id", cohortId)
    .in("user_id", ids);
  const enrolledIds = new Set((enrolled ?? []).map((r) => r.user_id));
  const { data: onTeam } = await admin
    .from("team_members")
    .select("user_id")
    .in("user_id", ids);
  const taken = new Set((onTeam ?? []).map((r) => r.user_id));
  const { data: invited } = await admin
    .from("team_invites")
    .select("invitee_id")
    .eq("team_id", input.teamId)
    .eq("status", "pending");
  const alreadyInvited = new Set(
    (invited ?? []).map((r) => r.invitee_id),
  );

  return (data ?? [])
    .filter(
      (p) =>
        p.id !== userId &&
        enrolledIds.has(p.id) &&
        !taken.has(p.id) &&
        !alreadyInvited.has(p.id),
    )
    .slice(0, 8)
    .map((p) => ({ id: p.id, full_name: p.full_name, email: p.email }));
}

export async function inviteStudent(input: {
  teamId: string;
  inviteeId: string;
  message?: string;
}) {
  const { userId } = await assertSelf();
  await assertTeamMember(userId, input.teamId);
  const admin = createAdminClient();

  // Cap team size at 5 to keep cohort dynamics sane. Adjust later if needed.
  const { count } = await admin
    .from("team_members")
    .select("id", { count: "exact", head: true })
    .eq("team_id", input.teamId);
  if ((count ?? 0) >= 5) {
    throw new Error("Teams are capped at 5 members.");
  }

  const { data: invitee } = await admin
    .from("profiles")
    .select("id, role, full_name, email")
    .eq("id", input.inviteeId)
    .maybeSingle();
  if (!invitee || invitee.role !== "student") {
    throw new Error("You can only invite students.");
  }

  // Invitee must be enrolled in the team's cohort. Without this the
  // student gets a notification they can't meaningfully accept.
  const cohortId = await getTeamCohortId(input.teamId);
  if (!cohortId || !(await isEnrolledInCohort(input.inviteeId, cohortId))) {
    throw new Error("That student isn't enrolled in this cohort.");
  }

  // Block if invitee already on another team.
  const { data: onTeam } = await admin
    .from("team_members")
    .select("id")
    .eq("user_id", input.inviteeId)
    .maybeSingle();
  if (onTeam) throw new Error("That student is already on a team.");

  const { data: team } = await admin
    .from("teams")
    .select("name")
    .eq("id", input.teamId)
    .single();

  const { error } = await admin
    .from("team_invites")
    .upsert(
      {
        team_id: input.teamId,
        invitee_id: input.inviteeId,
        invited_by: userId,
        status: "pending",
        message: (input.message ?? "").trim().slice(0, 400) || null,
      },
      { onConflict: "team_id,invitee_id" },
    );
  if (error) throw new Error(error.message);

  await notify({
    userId: input.inviteeId,
    type: "team_invite",
    title: `Team invite: ${team?.name ?? "a team"}`,
    body:
      (input.message?.trim().slice(0, 200) ||
        "You've been invited to join a team."),
    link: "/dashboard/team",
  });

  revalidatePath("/dashboard/team");
}

/**
 * Direct-by-email variant of {@link inviteStudent}. Resolves an email to a
 * student profile and sends them a pending invite — no search step needed.
 * The recipient still has to accept on their dashboard before they're on
 * the team, so this is just a convenience wrapper, not a way to add
 * someone silently.
 */
export async function inviteStudentByEmail(input: {
  teamId: string;
  email: string;
  message?: string;
}) {
  const { userId } = await assertSelf();
  await assertTeamMember(userId, input.teamId);

  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("That doesn't look like a valid email.");
  }

  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("id, role, email")
    .ilike("email", email)
    .maybeSingle();

  if (!profile) {
    throw new Error(
      "No SparkLine Youth account found for that email. Ask them to sign up first, then send the invite.",
    );
  }
  if (profile.id === userId) {
    throw new Error("You can't invite yourself.");
  }
  if (profile.role !== "student") {
    throw new Error("You can only invite students.");
  }

  // Delegate to the shared invite logic so capacity caps, dedupe, and
  // notifications stay consistent with the search-based flow.
  return inviteStudent({
    teamId: input.teamId,
    inviteeId: profile.id,
    message: input.message,
  });
}

export async function respondToInvite(input: {
  inviteId: string;
  accept: boolean;
}) {
  const { userId } = await assertSelf();
  const admin = createAdminClient();
  const { data: invite, error: fetchErr } = await admin
    .from("team_invites")
    .select("id, team_id, invitee_id, status, invited_by")
    .eq("id", input.inviteId)
    .single();
  if (fetchErr) throw new Error(fetchErr.message);
  if (invite.invitee_id !== userId) throw new Error("Forbidden");
  if (invite.status !== "pending") throw new Error("Invite no longer pending.");

  if (input.accept) {
    // Verify the invitee isn't on a team already and team has space.
    const { data: existing } = await admin
      .from("team_members")
      .select("id")
      .eq("user_id", userId)
      .maybeSingle();
    if (existing) throw new Error("You're already on a team.");
    // Block accepting if the invitee is no longer (or never was)
    // enrolled in the team's cohort.
    const cohortId = await getTeamCohortId(invite.team_id);
    if (!cohortId || !(await isEnrolledInCohort(userId, cohortId))) {
      throw new Error("You need to be enrolled in this cohort to join the team.");
    }
    const { count } = await admin
      .from("team_members")
      .select("id", { count: "exact", head: true })
      .eq("team_id", invite.team_id);
    if ((count ?? 0) >= 5) throw new Error("That team is full.");
    await admin
      .from("team_members")
      .insert({ team_id: invite.team_id, user_id: userId, role: "member" });
  }

  await admin
    .from("team_invites")
    .update({
      status: input.accept ? "accepted" : "declined",
      responded_at: new Date().toISOString(),
    })
    .eq("id", input.inviteId);

  // Auto-cancel any other pending invites for this user.
  if (input.accept) {
    await admin
      .from("team_invites")
      .update({
        status: "cancelled",
        responded_at: new Date().toISOString(),
      })
      .eq("invitee_id", userId)
      .eq("status", "pending");
  }

  // Notify the inviter that they got a response.
  try {
    const { data: profile } = await admin
      .from("profiles")
      .select("full_name, email")
      .eq("id", userId)
      .maybeSingle();
    const who = profile?.full_name ?? profile?.email ?? "Someone";
    await notify({
      userId: invite.invited_by,
      type: "team_invite_response",
      title: input.accept
        ? `${who} joined your team`
        : `${who} declined your invite`,
      body: null,
      link: "/dashboard/team",
    });
  } catch {}

  revalidatePath("/dashboard/team");
}

export async function cancelInvite(input: { inviteId: string }) {
  const { userId } = await assertSelf();
  const admin = createAdminClient();
  const { data: invite } = await admin
    .from("team_invites")
    .select("team_id, status, invited_by")
    .eq("id", input.inviteId)
    .single();
  if (!invite) throw new Error("Not found.");
  if (invite.invited_by !== userId) {
    // Allow any team member to cancel an invite to their team.
    await assertTeamMember(userId, invite.team_id);
  }
  if (invite.status !== "pending") throw new Error("Already responded.");
  await admin
    .from("team_invites")
    .update({
      status: "cancelled",
      responded_at: new Date().toISOString(),
    })
    .eq("id", input.inviteId);
  revalidatePath("/dashboard/team");
}

export async function removeTeamMember(input: {
  teamId: string;
  memberId: string;
}) {
  const { userId } = await assertSelf();
  await assertTeamMember(userId, input.teamId);
  if (input.memberId === userId) {
    // Members should use leaveTeam instead to trigger the orphan cleanup.
    throw new Error("Use 'Leave team' to remove yourself.");
  }
  const admin = createAdminClient();
  const { error } = await admin
    .from("team_members")
    .delete()
    .eq("team_id", input.teamId)
    .eq("user_id", input.memberId);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard/team");
}

// ---------------------------------------------------------------------------
// Drive — register a file after a client-side upload to team-drive.
// ---------------------------------------------------------------------------

export async function getTeamDriveUploadToken(input: {
  teamId: string;
  filename: string;
}) {
  const { userId } = await assertSelf();
  await assertTeamMember(userId, input.teamId);
  const dot = input.filename.lastIndexOf(".");
  const base = dot > 0 ? input.filename.slice(0, dot) : input.filename;
  const ext = dot > 0 ? input.filename.slice(dot + 1) : "";
  const stamp = Date.now();
  const path = `${input.teamId}/drive/${safeSegment(base)}-${stamp}${ext ? "." + safeSegment(ext) : ""}`;
  const admin = createAdminClient();
  const { data, error } = await admin.storage
    .from("team-drive")
    .createSignedUploadUrl(path);
  if (error) throw new Error(error.message);
  return { path: data.path, token: data.token };
}

export async function registerTeamDriveFile(input: {
  teamId: string;
  name: string;
  path: string;
  size_bytes: number | null;
  mime_type: string | null;
}) {
  const { userId } = await assertSelf();
  await assertTeamMember(userId, input.teamId);
  if (!input.path.startsWith(`${input.teamId}/`)) {
    throw new Error("Path doesn't belong to your team.");
  }
  if (input.size_bytes != null && input.size_bytes > 250 * 1024 * 1024) {
    throw new Error("Files are capped at 250 MB.");
  }
  const admin = createAdminClient();

  // Verify the storage object actually exists. Without this a tampered
  // client could register paths it never uploaded; those entries would
  // 404 on download but still litter team_drive_files.
  const segments = input.path.split("/");
  const filename = segments.pop() ?? "";
  const folder = segments.join("/");
  const { data: listed } = await admin.storage
    .from("team-drive")
    .list(folder, { limit: 1, search: filename });
  if (!listed?.some((o: any) => o.name === filename)) {
    throw new Error("Upload didn't complete — try again.");
  }

  const { error } = await admin.from("team_drive_files").insert({
    team_id: input.teamId,
    uploader_id: userId,
    name: input.name.slice(0, 200),
    path: input.path,
    size_bytes: input.size_bytes,
    mime_type: input.mime_type,
  });
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard/team");
}

export async function deleteTeamDriveFile(input: { fileId: string }) {
  const { userId } = await assertSelf();
  const admin = createAdminClient();
  const { data: file } = await admin
    .from("team_drive_files")
    .select("id, team_id, path")
    .eq("id", input.fileId)
    .single();
  if (!file) throw new Error("Not found.");
  await assertTeamMember(userId, file.team_id);
  await admin.storage.from("team-drive").remove([file.path]);
  await admin.from("team_drive_files").delete().eq("id", file.id);
  revalidatePath("/dashboard/team");
}

export async function getTeamDriveDownloadUrl(input: {
  fileId: string;
}): Promise<string> {
  const { userId } = await assertSelf();
  const admin = createAdminClient();
  const { data: file } = await admin
    .from("team_drive_files")
    .select("id, team_id, path")
    .eq("id", input.fileId)
    .single();
  if (!file) throw new Error("Not found.");

  // Allow members + staff + investors to download (read RLS allows them).
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in");
  const { data: profile } = await admin
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  const role = profile?.role;
  const staff = role === "admin" || role === "mentor" || role === "investor";
  if (!staff) {
    await assertTeamMember(userId, file.team_id);
  }

  const { data, error } = await admin.storage
    .from("team-drive")
    .createSignedUrl(file.path, 60 * 60);
  if (error || !data?.signedUrl) {
    throw new Error(error?.message ?? "Could not generate URL");
  }
  return data.signedUrl;
}

// ---------------------------------------------------------------------------
// Messages — members + mentors + investors + admins can post
// ---------------------------------------------------------------------------

export async function postTeamMessage(input: {
  teamId: string;
  body: string;
}) {
  const { userId } = await assertSelf();
  const body = input.body.trim();
  if (!body) throw new Error("Empty message.");
  if (body.length > 4000) throw new Error("Message too long.");

  // Throttle: a spammy poster shouldn't be able to flood a team thread.
  // 10 messages / minute / user across all teams; enough for normal
  // back-and-forth, way below abuse territory.
  const rl = await checkRateLimit({
    kind: "team-message",
    identifier: userId,
    limit: 10,
    windowSeconds: 60,
  });
  if (!rl.ok) {
    throw new Error("Slow down — too many messages in a row.");
  }

  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("role, full_name")
    .eq("id", userId)
    .maybeSingle();

  let kind: "member" | "mentor" | "investor" | "admin" = "member";
  if (profile?.role === "admin") kind = "admin";
  else if (profile?.role === "mentor") kind = "mentor";
  else if (profile?.role === "investor") kind = "investor";
  else {
    await assertTeamMember(userId, input.teamId);
  }

  const { error } = await admin.from("team_messages").insert({
    team_id: input.teamId,
    author_id: userId,
    body,
    kind,
  });
  if (error) throw new Error(error.message);

  // Notify team members when a non-member (mentor/investor/admin) posts.
  if (kind !== "member") {
    const { data: members } = await admin
      .from("team_members")
      .select("user_id")
      .eq("team_id", input.teamId);
    const who = profile?.full_name ?? `Your ${kind}`;
    for (const m of members ?? []) {
      await notify({
        userId: m.user_id,
        type: "team_message",
        title: `${who} posted to your team`,
        body: body.slice(0, 200),
        link: "/dashboard/team",
      });
    }
  }

  revalidatePath("/dashboard/team");
  revalidatePath(`/mentor/teams/${input.teamId}`);
  revalidatePath(`/investor/teams/${input.teamId}`);
}
