/**
 * Role impact previews: what a role change does to people's access, worked
 * out before anyone presses Save.
 *
 * Two questions, one answer shape (AccessDiff):
 *   - editing a role at /admin/roles/<slug>: what does everyone who holds it
 *     gain or lose if these boxes are saved? (`diffRoleAccess` on the stored
 *     list and the ticked one)
 *   - giving people a role (the email form at /admin/roles, the picker on a
 *     person's row and profile, the bulk change on People, moving everyone
 *     off a role being deleted): what does each of them gain or lose next to
 *     the role they hold now, and who would the guard skip, and why?
 *     (`previewRoleAssignment`)
 *
 * Everything is derived from the permission catalog (lib/permissions.ts),
 * through the same predicates the middleware and layouts apply —
 * canViewAdminPath, canAccessAdmin, the panel keys — and never by
 * impersonating real users. Pure, so the forms run it in the browser as the
 * admin ticks boxes and `node --test` runs it as-is.
 *
 * A preview, not a gate: updateRole and changeRoles (lib/role-change-server.ts)
 * decide again on the server, from fresh reads, and their answer is the one
 * that counts.
 */
import {
  ADMIN_AREA_PERMISSIONS,
  ADMIN_EXACT_ROUTE_PERMISSIONS,
  ADMIN_ROUTE_PERMISSIONS,
  ALL_PERMISSIONS,
  PERMISSION_BY_KEY,
  PERMISSION_GROUPS,
  PERMISSION_NEEDS,
  WILDCARD,
  can,
  canAccessAdmin,
  canViewAdminPath,
  capabilitiesFrom,
  opensNoSection,
  resolveHome,
  unmetPermissionNeed,
  type Capabilities,
  type Permission,
} from "./permissions.ts";
import {
  planRoleChange,
  type RoleChangeActor,
  type RoleChangeTarget,
  type RoleDef,
} from "./role-change.ts";

/** An admin page as a preview names it. */
export type AdminPage = { href: string; label: string };

/**
 * Every path the route guard has a rule for, labelled with itself. The
 * default page list: the pages read their labelled list from the sidebar
 * (ADMIN_PAGES in lib/nav-config.ts, which imports icons and so can't load
 * under `node --test`), and the "Pages this role can open" card on a role's
 * page lists these paths.
 */
export const ROUTE_TABLE_PAGES: readonly AdminPage[] = Array.from(
  new Set([
    ...ADMIN_ROUTE_PERMISSIONS.map(([prefix]) => prefix),
    ...ADMIN_EXACT_ROUTE_PERMISSIONS.map(([path]) => path),
  ]),
)
  .sort()
  .map((href) => ({ href, label: href }));

/** A permission list as the guard would see it on someone's role. */
function capsOf(permissions: readonly string[]): Capabilities {
  return capabilitiesFrom("", permissions);
}

/**
 * Which of `pages` a role holding `permissions` can open, by the guard's own
 * predicate. So 1:1 calls (calls.invite) counts only alongside a key that
 * opens the admin panel, as it does in the middleware: the mentor role holds
 * calls.invite and cannot open /admin/calls.
 */
export function adminPagesOpenedBy(
  permissions: readonly string[],
  pages: readonly AdminPage[] = ROUTE_TABLE_PAGES,
): AdminPage[] {
  const caps = capsOf(permissions);
  return pages.filter((p) => canViewAdminPath(caps, p.href));
}

/**
 * The catalog keys a stored list grants, in catalog order. '*' is every key;
 * a retired string (pulse.view, say) grants nothing, so it never shows as
 * gained or lost.
 */
export function grantedKeys(permissions: readonly string[]): Permission[] {
  if (permissions.includes(WILDCARD)) return [...ALL_PERMISSIONS];
  const held = new Set(permissions);
  return ALL_PERMISSIONS.filter((k) => held.has(k));
}

/** The sections outside /admin, each opened by one key. */
export const PANELS: readonly { key: Permission; href: string; label: string }[] = (
  [
    ["student.dashboard", "/dashboard"],
    ["mentor.panel", "/mentor"],
    ["investor.panel", "/investor"],
  ] as const
).map(([key, href]) => ({ key, href, label: PERMISSION_BY_KEY.get(key)?.label ?? key }));

export type Panel = (typeof PANELS)[number];

/**
 * A few words on why each sensitive permission is sensitive, for the preview
 * ("Manage payments is sensitive: moves money (refunds charges)."). The
 * catalog's descriptions say it in full; these have to fit on one line next
 * to the label. A sensitive key without a note here falls back to its catalog
 * group ("Finance", "Operations").
 */
const SENSITIVE_WHY: Partial<Record<Permission, string>> = {
  "applications.review": "decides who is accepted, waitlisted or rejected",
  "people.manage": "edits anyone's profile and enrolments",
  "people.roles": "changes other people's roles, up to what this role holds",
  "charges.manage": "moves money (issues and waives fees and fines)",
  "payments.manage": "moves money (refunds charges)",
  "scholarships.manage": "moves money (awards scholarships, including refunds of paid tuition)",
  "email.send": "emails anyone in batch0's name",
  "email.templates": "rewrites every email the site sends",
  "email.automate": "sets up email that sends on its own",
  "email.settings": "changes the sending account and can pause all email",
  "sms.send": "sends texts that cost money per message",
  "sms.settings": "changes the Twilio credentials and can pause all texts",
  "support.view": "reads requesters' email addresses and what they say about payments",
  "support.manage": "replies to requesters in batch0's name",
  "support.sensitive": "opens safety, harassment and wellbeing reports",
  "chat.manage": "reads every channel, #staff included, and opens reported direct messages",
  "audit.view": "reads every recorded admin action",
  "settings.manage": "changes pricing, feature flags and site settings",
  "roles.manage": "changes what every role can do, this one included",
  "calls.invite": "starts private video calls with any student",
  "calls.join_any": "joins any student's 1:1 call",
};

const GROUP_OF: ReadonlyMap<string, string> = new Map(
  PERMISSION_GROUPS.flatMap((g) => g.permissions.map((p) => [p.key, g.label] as const)),
);

export type SensitiveGrant = { key: Permission; label: string; why: string };

export function isSensitive(key: string): boolean {
  return !!PERMISSION_BY_KEY.get(key)?.sensitive;
}

function sensitiveGrant(key: Permission): SensitiveGrant {
  return {
    key,
    label: PERMISSION_BY_KEY.get(key)?.label ?? key,
    why: SENSITIVE_WHY[key] ?? GROUP_OF.get(key) ?? "sensitive",
  };
}

/** Exposed for the test that keeps the notes pointed at sensitive keys. */
export const SENSITIVE_NOTE_KEYS = Object.keys(SENSITIVE_WHY);

function label(key: Permission): string {
  return PERMISSION_BY_KEY.get(key)?.label ?? key;
}

/**
 * Every [key, needs] pair (PERMISSION_NEEDS) granted without its companion —
 * all of them, where unmetPermissionNeed stops at the first. The wildcard
 * holds every companion.
 */
export function unmetPermissionNeeds(
  permissions: readonly string[],
): { key: Permission; needs: Permission }[] {
  if (permissions.includes(WILDCARD)) return [];
  const out: { key: Permission; needs: Permission }[] = [];
  for (const key of grantedKeys(permissions)) {
    const needs = PERMISSION_NEEDS[key];
    if (needs && !permissions.includes(needs)) out.push({ key, needs });
  }
  return out;
}

/**
 * Keys that do nothing in this list as it stands. Not refused on save (the
 * catalog only enforces PERMISSION_NEEDS), but worth saying, because the box
 * looks ticked and the holder gets nothing from it. Each one is what the
 * checkbox's own description warns about:
 *   - support.sensitive only widens read access (lib/support-access.ts
 *     supportScopeFor: canSeeSensitive needs canView);
 *   - calls.join_any is used from the list of everyone's calls at
 *     /admin/calls, which needs calls.invite and the admin panel.
 */
function inertKeys(caps: Capabilities): { key: Permission; reason: string }[] {
  if (caps.superAdmin) return [];
  const out: { key: Permission; reason: string }[] = [];
  if (can(caps, "support.sensitive") && !can(caps, "support.view") && !can(caps, "support.manage")) {
    out.push({
      key: "support.sensitive",
      reason: `“${label("support.sensitive")}” opens nothing without “${label("support.view")}” or “${label("support.manage")}”.`,
    });
  }
  if (can(caps, "calls.join_any") && !(can(caps, "calls.invite") && canAccessAdmin(caps))) {
    out.push({
      key: "calls.join_any",
      reason: `“${label("calls.join_any")}” works from /admin/calls, which needs “${label("calls.invite")}” and a permission that opens the admin panel.`,
    });
  }
  return out;
}

/** How one yes/no about access moves. */
export type Change = "gains" | "loses" | "keeps" | "none";

function change(before: boolean, after: boolean): Change {
  if (before) return after ? "keeps" : "loses";
  return after ? "gains" : "none";
}

const ADMIN_AREA_SET: ReadonlySet<string> = new Set(ADMIN_AREA_PERMISSIONS);

export type AccessDiff = {
  /** Catalog keys gained and lost, in catalog order ('*' expanded). */
  gained: Permission[];
  lost: Permission[];
  /** The '*' wildcard: every permission, now and later. */
  fullAccess: Change;
  /** The admin panel at all (canAccessAdmin). */
  adminArea: Change;
  /**
   * When the admin panel is gained without full access: the gained keys that
   * open it, any one of which would on its own (ADMIN_AREA_PERMISSIONS).
   */
  adminAreaVia: Permission[];
  pagesGained: AdminPage[];
  pagesLost: AdminPage[];
  panelsGained: Panel[];
  panelsLost: Panel[];
  sensitiveGained: SensitiveGrant[];
  sensitiveLost: SensitiveGrant[];
  /** Knock-on effects of the change, in plain words. */
  notes: string[];
  /** PERMISSION_NEEDS pairs broken in the new list: a role save is refused. */
  unmet: { key: Permission; needs: Permission }[];
  /** Keys in the new list that do nothing as it stands. */
  inert: { key: Permission; reason: string }[];
  /** The new list opens no section at all (opensNoSection). */
  opensNothing: boolean;
  /** Where holders land before and after, when homes were given. */
  home: { before: string; after: string } | null;
  /** Nothing about access or landing changes. */
  same: boolean;
};

/**
 * What moving from `before` to `after` does to someone's access. Lists are
 * stored permission strings; `home` is each side's configured landing page
 * (app_roles.home_path), resolved the way sign-in resolves it.
 */
export function diffRoleAccess(
  before: readonly string[],
  after: readonly string[],
  opts: {
    pages?: readonly AdminPage[];
    home?: { before: string | null; after: string | null };
  } = {},
): AccessDiff {
  const pages = opts.pages ?? ROUTE_TABLE_PAGES;
  const b = capsOf(before);
  const a = capsOf(after);

  const beforeKeys = grantedKeys(before);
  const afterKeys = grantedKeys(after);
  const beforeSet = new Set(beforeKeys);
  const afterSet = new Set(afterKeys);
  const gained = afterKeys.filter((k) => !beforeSet.has(k));
  const lost = beforeKeys.filter((k) => !afterSet.has(k));

  const pagesBefore = new Set(adminPagesOpenedBy(before, pages).map((p) => p.href));
  const pagesAfter = new Set(adminPagesOpenedBy(after, pages).map((p) => p.href));

  const fullAccess = change(b.superAdmin, a.superAdmin);
  const adminArea = change(canAccessAdmin(b), canAccessAdmin(a));

  const notes: string[] = [];
  // app/mentor/students/page.tsx: an admin-area viewer gets the
  // program-wide list instead of their own cohorts.
  if (can(a, "mentor.panel") && can(b, "mentor.panel")) {
    if (adminArea === "gains") {
      notes.push("Their Mentor panel's student list widens from their own cohorts to every enrolled student.");
    } else if (adminArea === "loses") {
      notes.push("Their Mentor panel's student list narrows to their own cohorts.");
    }
  }

  const home = opts.home
    ? { before: resolveHome(b, opts.home.before), after: resolveHome(a, opts.home.after) }
    : null;

  return {
    gained,
    lost,
    fullAccess,
    adminArea,
    adminAreaVia:
      adminArea === "gains" && !a.superAdmin ? gained.filter((k) => ADMIN_AREA_SET.has(k)) : [],
    pagesGained: pages.filter((p) => pagesAfter.has(p.href) && !pagesBefore.has(p.href)),
    pagesLost: pages.filter((p) => pagesBefore.has(p.href) && !pagesAfter.has(p.href)),
    panelsGained: PANELS.filter((p) => !can(b, p.key) && can(a, p.key)),
    panelsLost: PANELS.filter((p) => can(b, p.key) && !can(a, p.key)),
    sensitiveGained: gained.filter(isSensitive).map(sensitiveGrant),
    sensitiveLost: lost.filter(isSensitive).map(sensitiveGrant),
    notes,
    unmet: unmetPermissionNeeds(after),
    inert: inertKeys(a),
    opensNothing: opensNoSection(a),
    home,
    same: gained.length === 0 && lost.length === 0 && (!home || home.before === home.after),
  };
}

/** Where a role holding `permissions` and configured with `home` lands. */
export function landingFor(permissions: readonly string[], home: string | null): string {
  return resolveHome(capsOf(permissions), home);
}

/**
 * What Save, Delete, Change role and Apply say on the /dev/roles fixture
 * page instead of calling the server. The components there (RoleForm,
 * DeleteRole, RoleSelect, StudentsBulkList) take a `fixture` flag that stops
 * them before any server action: that page renders on localhost and on
 * branch previews, either of which can be talking to the production
 * database, and its made-up roles carry real slugs, so a signed-in admin
 * pressing Save there would have rewritten the real Mentor role.
 */
export const FIXTURE_NOT_SENT = "Not sent: this is the /dev/roles preview, which never calls the server.";

// ---------------------------------------------------------------------------
// Saving a role
// ---------------------------------------------------------------------------

export const EMPTY_ROLE = "A role with no permissions can't reach anything. Tick at least one.";
export const OWN_ROLES_MANAGE =
  "That would remove your own ability to manage roles. Ask a full admin to do it.";

/**
 * Why createRole or updateRole (app/admin/roles/actions.ts) would refuse this
 * permission list, or null. The parts of the save rule that depend only on
 * the list and on who is saving, so the editor says it before Save and the
 * action says the same words after. `permissions` is the list as the action
 * stores it: known keys only, no wildcard.
 */
export function roleSaveRefusal(input: {
  permissions: readonly string[];
  /** The role as stored, when editing. */
  existing?: { slug: string; permissions: readonly string[] } | null;
  /** The saver's own role slug. */
  actorRole?: string | null;
}): string | null {
  const { permissions, existing } = input;
  if (permissions.length === 0) return EMPTY_ROLE;
  const unmet = unmetPermissionNeed(permissions);
  if (unmet) {
    const [key, needs] = unmet.map((k) => label(k));
    return `"${key}" needs "${needs}" too.`;
  }
  // A role that can manage roles can otherwise quietly remove that ability
  // from the role it's standing on and lock everyone out of /admin/roles.
  if (
    existing &&
    existing.permissions.includes("roles.manage") &&
    !permissions.includes("roles.manage") &&
    input.actorRole === existing.slug
  ) {
    return OWN_ROLES_MANAGE;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Giving people a role
// ---------------------------------------------------------------------------

/** A role as the assignment preview needs it. */
export type ImpactRole = RoleDef & { home_path?: string | null };

export type AssignmentPreview = {
  /** Set when nobody would change: the destination is one the actor can't hand out. */
  error: string | null;
  next: ImpactRole | null;
  /** Who would move, grouped by the role they hold now, with what it does to them. */
  moves: { from: string; fromLabel: string; ids: string[]; diff: AccessDiff }[];
  /** Who the guard would leave as they are, grouped by its reason. */
  skipped: { reason: string; ids: string[] }[];
};

/**
 * The role-change guard's answer (planRoleChange, lib/role-change.ts) for a
 * batch, before anything is sent, with each group's access diff.
 *
 * planRoleChange asks who holds full access only when a full admin would lose
 * it, and by rules 1 and 3 that only happens with a full admin acting on
 * someone other than themselves — so the actor is one of the full admins
 * and stays one. Passing the actor alone is therefore exact, unless the
 * actor's own standing changed since the page loaded, which changeRoles
 * reads for real before it writes.
 */
export function previewRoleAssignment(input: {
  actor: RoleChangeActor;
  roles: readonly ImpactRole[];
  targets: readonly RoleChangeTarget[];
  nextRole: string;
  pages?: readonly AdminPage[];
}): AssignmentPreview {
  const { actor, roles, targets, nextRole } = input;
  const plan = planRoleChange({
    actor,
    roles,
    targets,
    nextRole,
    fullAdminIds: actor.caps.superAdmin ? [actor.userId] : [],
  });
  const next = roles.find((r) => r.slug === nextRole) ?? null;
  if (plan.error !== null || !next) {
    return { error: plan.error ?? `"${nextRole}" isn't a role.`, next, moves: [], skipped: [] };
  }

  const moves = new Map<string, string[]>();
  for (const t of plan.change) moves.set(t.role, [...(moves.get(t.role) ?? []), t.id]);
  const skipped = new Map<string, string[]>();
  for (const s of plan.skipped) skipped.set(s.reason, [...(skipped.get(s.reason) ?? []), s.id]);

  return {
    error: null,
    next,
    moves: [...moves].map(([from, ids]) => {
      // A profile can point at a role that was deleted: it holds nothing.
      const current = roles.find((r) => r.slug === from);
      return {
        from,
        fromLabel: current?.label ?? from,
        ids,
        diff: diffRoleAccess(current?.permissions ?? [], next.permissions, {
          pages: input.pages,
          home: { before: current?.home_path ?? null, after: next.home_path ?? null },
        }),
      };
    }),
    skipped: [...skipped].map(([reason, ids]) => ({ reason, ids })),
  };
}
