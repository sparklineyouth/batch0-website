/**
 * The permission catalog.
 *
 * Roles are rows in `public.app_roles` (migration 0048) and each row carries a
 * `permissions` text[]. This file is the one place that says what those strings
 * *mean* — which admin pages they unlock and which server actions they
 * authorize. The admin UI at /admin/roles renders its checkbox grid straight
 * off `PERMISSION_GROUPS`, the sidebar filters off `perm` on each nav item, and
 * the route guard resolves off `ADMIN_ROUTE_PERMISSIONS`. One list, three
 * consumers, so they can't drift.
 *
 * IMPORTANT: this module must stay Edge-safe — middleware imports it. No
 * `next/headers`, no Supabase client, no icons, no Node built-ins.
 */

/** Grants everything, present and future. Only the built-in `admin` role has it. */
export const WILDCARD = "*";

/**
 * A known permission key.
 *
 * Derived from the catalog rather than written out, so `assertPermission`,
 * `requirePermission`, and the nav's `perm` field all fail to compile on a
 * typo. That matters more than it looks: a misspelled permission isn't a loud
 * error, it's a check nobody can ever satisfy — the page silently disappears
 * for every role including admins.
 */
export const PERMISSION_KEYS = [
  // Applicants & people
  "applications.view",
  "applications.review",
  "applications.form",
  "people.view",
  "people.manage",
  "people.roles",
  "mentors.manage",
  // Cohorts & teams
  "cohorts.manage",
  "challenges.manage",
  "teams.manage",
  "demoday.manage",
  "intros.manage",
  "assignments.manage",
  // Content
  "blog.manage",
  "course.manage",
  "events.manage",
  "resources.manage",
  "flows.manage",
  "announcements.manage",
  // Finance
  "charges.manage",
  "payments.view",
  "payments.manage",
  // Operations
  "email.view",
  "email.send",
  "email.templates",
  "email.automate",
  "email.settings",
  "referrals.view",
  "passes.manage",
  "scholarships.view",
  "scholarships.manage",
  "support.view",
  "support.manage",
  "support.sensitive",
  "moderation.manage",
  "discord.manage",
  "audit.view",
  "settings.manage",
  "roles.manage",
  // Other panels
  "mentor.panel",
  "investor.panel",
  "student.dashboard",
  "calls.invite",
  "calls.join_any",
] as const;

export type Permission = (typeof PERMISSION_KEYS)[number];

export type PermissionDef = {
  key: Permission;
  label: string;
  /** Shown under the checkbox — say what the holder can actually do. */
  description: string;
  /**
   * True when granting this is a real escalation (money, other people's
   * access, the audit trail). Rendered with a warning tint at /admin/roles.
   */
  sensitive?: boolean;
};

export type PermissionGroup = {
  label: string;
  permissions: PermissionDef[];
};

/**
 * Grouped to mirror the admin sidebar's own sections, so ticking boxes here
 * reads like ticking off the nav the person will end up with.
 */
export const PERMISSION_GROUPS: PermissionGroup[] = [
  {
    label: "Applicants & people",
    permissions: [
      {
        key: "applications.view",
        label: "View applications",
        description: "Read the applicant queue and open individual applications.",
      },
      {
        key: "applications.review",
        label: "Decide applications",
        description:
          "Accept, waitlist, or reject applicants, and leave review comments.",
        sensitive: true,
      },
      {
        key: "applications.form",
        label: "Edit the application form",
        description: "Add, reorder, and remove the questions applicants answer.",
      },
      {
        key: "people.view",
        label: "View people",
        description: "Browse the people directory and open a person's profile.",
      },
      {
        key: "people.manage",
        label: "Manage people",
        description:
          "Edit profiles, enrol people into cohorts, and remove enrolments.",
        sensitive: true,
      },
      {
        key: "people.roles",
        label: "Assign roles",
        description:
          "Change what role a person holds. Cannot grant more than the assigner already has.",
        sensitive: true,
      },
      {
        key: "mentors.manage",
        label: "Manage mentors",
        description: "Invite mentors, edit mentor profiles, and pair them with students.",
      },
    ],
  },
  {
    label: "Cohorts & teams",
    permissions: [
      {
        key: "cohorts.manage",
        label: "Manage cohorts",
        description:
          "Create and edit cohorts, deadlines, landing pages, and certificates.",
      },
      {
        key: "challenges.manage",
        label: "Manage challenges",
        description: "Publish weekly challenges and score submissions.",
      },
      {
        key: "teams.manage",
        label: "Manage teams",
        description: "Create teams, move members, and edit cap tables.",
      },
      {
        key: "demoday.manage",
        label: "Manage Demo Day",
        description: "Run the Demo Day schedule, rubric, and recaps.",
      },
      {
        key: "intros.manage",
        label: "Manage intros",
        description: "Broker and track investor introductions.",
      },
      {
        key: "assignments.manage",
        label: "Manage assignments",
        description:
          "Create assignments for a cohort or specific students, see who has submitted, and review work.",
      },
    ],
  },
  {
    label: "Content",
    permissions: [
      {
        key: "blog.manage",
        label: "Manage the blog",
        description: "Write, edit, and publish blog posts.",
      },
      {
        key: "course.manage",
        label: "Manage the course",
        description: "Edit modules and lessons.",
      },
      {
        key: "events.manage",
        label: "Manage events",
        description: "Schedule and edit events on the calendar.",
      },
      {
        key: "resources.manage",
        label: "Manage resources",
        description: "Upload and organise the resource library.",
      },
      {
        key: "flows.manage",
        label: "Manage pre-cohort flows",
        description: "Build the interactive flows accepted students run before kickoff.",
      },
      {
        key: "announcements.manage",
        label: "Post announcements",
        description: "Publish announcements to students.",
      },
    ],
  },
  {
    label: "Finance",
    permissions: [
      {
        key: "charges.manage",
        label: "Manage fees & fines",
        description: "Issue, waive, and cancel fees and fines.",
        sensitive: true,
      },
      {
        key: "payments.view",
        label: "View payments",
        description: "Read the payment ledger and reconciliation state.",
      },
      {
        key: "payments.manage",
        label: "Manage payments",
        description: "Refund charges and re-run Stripe reconciliation.",
        sensitive: true,
      },
      {
        key: "scholarships.view",
        label: "View scholarships",
        description:
          "Read the scholarship catalog and every student's scholarship application.",
      },
      {
        key: "scholarships.manage",
        label: "Award scholarships",
        description:
          "Create scholarships and decide applications — including issuing a refund to a student who has already paid tuition.",
        sensitive: true,
      },
    ],
  },
  {
    label: "Operations",
    permissions: [
      {
        key: "email.view",
        label: "View the email outbox",
        description: "Read every queued and sent email.",
      },
      {
        key: "email.send",
        label: "Send email",
        description:
          "Send blasts, compose one-off email to any address, and cancel queued sends.",
        sensitive: true,
      },
      {
        key: "email.templates",
        label: "Edit email templates",
        description:
          "Rewrite the copy of every email the site sends, including the built-in transactional ones.",
        sensitive: true,
      },
      {
        key: "email.automate",
        label: "Build email automations",
        description:
          "Create the rules that send email on their own — on an event, on a schedule, or as a drip sequence.",
        sensitive: true,
      },
      {
        key: "email.settings",
        label: "Manage email delivery",
        description:
          "Change the sending account and sender address, and pause or resume all automated email.",
        sensitive: true,
      },
      {
        key: "referrals.view",
        label: "View referrals",
        description: "Read the referral leaderboard and payouts.",
      },
      {
        key: "passes.manage",
        label: "Manage founder passes",
        description: "Mint passes and work the pass-request queue.",
      },
      {
        key: "support.view",
        label: "View support requests",
        description:
          "Read the support queue and any request in full, including the requester's email address and what they say about their payments. Confidential concerns also need “See confidential concerns”.",
        sensitive: true,
      },
      {
        key: "support.manage",
        label: "Answer support requests",
        description:
          "Reply to support requests, leave internal notes, assign, reprioritise and recategorise them, link payments, resolve or close them, and log a request someone sent by email or phone. A reply emails the requester.",
        sensitive: true,
      },
      {
        key: "support.sensitive",
        label: "See confidential concerns",
        description:
          "See and handle confidential concerns — safety, harassment and wellbeing reports, which nobody else on the team can open. Only works alongside View or Answer support requests. Keep it to a small number of senior staff.",
        sensitive: true,
      },
      {
        key: "moderation.manage",
        label: "Moderate",
        description: "Approve or reject team logos.",
      },
      {
        key: "discord.manage",
        label: "Manage Discord",
        description: "Configure the Discord integration and sync roles.",
      },
      {
        key: "audit.view",
        label: "View the audit log",
        description: "Read every recorded admin action.",
        sensitive: true,
      },
      {
        key: "settings.manage",
        label: "Manage site settings",
        description: "Change pricing, feature flags, and site-wide configuration.",
        sensitive: true,
      },
      {
        key: "roles.manage",
        label: "Manage roles",
        description:
          "Create roles and change what every role can do — including this one.",
        sensitive: true,
      },
    ],
  },
  {
    label: "Other panels",
    permissions: [
      {
        key: "mentor.panel",
        label: "Mentor panel",
        description: "Access /mentor and write feedback on student work.",
      },
      {
        key: "investor.panel",
        label: "Investor panel",
        description: "Access /investor, browse teams, and register interest.",
      },
      {
        key: "student.dashboard",
        label: "Student dashboard",
        description:
          "Access /dashboard as a participant. Grant this to roles that also take part in the programme.",
      },
      {
        key: "calls.invite",
        label: "Invite students to 1:1 calls",
        description:
          "Book or start a private video call with any student. Held by mentors and investors.",
        sensitive: true,
      },
      {
        // The safeguarding counterpart to calls.invite: not "book your own
        // calls" but "step into anyone's". Granted by no migration; admins
        // hold it through the wildcard. Where it is used is the list of
        // everyone's calls at /admin/calls (and addCallCohosts, which that
        // list calls), so the description says what else it needs to work.
        key: "calls.join_any",
        label: "Join any 1:1 call",
        description:
          "Add yourself to any student's 1:1, whoever booked it, from the list of everyone's calls at /admin/calls, and bring others from the team in. You're shown to everyone on the call, the student included. Needs Invite students to 1:1 calls too, and doesn't open the admin area on its own.",
        sensitive: true,
      },
    ],
  },
];

export const ALL_PERMISSIONS: readonly Permission[] = PERMISSION_KEYS;

const PERMISSION_SET: ReadonlySet<string> = new Set<string>(ALL_PERMISSIONS);

export const PERMISSION_BY_KEY: ReadonlyMap<string, PermissionDef> = new Map(
  PERMISSION_GROUPS.flatMap((g) => g.permissions).map((p) => [p.key, p] as const),
);

// PERMISSION_KEYS is the type source; PERMISSION_GROUPS is what the UI renders.
// A key in one but not the other means an ungrantable permission or an
// unrenderable checkbox, so shout during development rather than shipping it.
if (process.env.NODE_ENV !== "production") {
  const missing = PERMISSION_KEYS.filter((k) => !PERMISSION_BY_KEY.has(k));
  if (missing.length > 0) {
    console.error(
      "[permissions] keys missing from PERMISSION_GROUPS:",
      missing.join(", "),
    );
  }
}

/** Narrows an untrusted string (a form post, a stale DB row) to a real key. */
export function isKnownPermission(key: string): key is Permission {
  return PERMISSION_SET.has(key);
}

/**
 * Keys that only work alongside another. "Add a person" (people.manage) is a
 * button on the People directory (people.view), so a role holding the first
 * alone could never navigate to it. The role editor ticks the companion and
 * refuses a save without it.
 */
export const PERMISSION_NEEDS: Partial<Record<Permission, Permission>> = {
  "people.manage": "people.view",
};

/** The first [key, needs] pair in `permissions` granted without its companion. */
export function unmetPermissionNeed(
  permissions: readonly string[],
): readonly [Permission, Permission] | null {
  for (const key of permissions) {
    const needs = isKnownPermission(key) ? PERMISSION_NEEDS[key] : undefined;
    if (needs && !permissions.includes(needs)) return [key as Permission, needs];
  }
  return null;
}

/**
 * Permissions that are about the *other* panels rather than /admin. A role
 * holding only these should land on /mentor or /dashboard, not the admin area.
 */
const NON_ADMIN_PERMISSIONS = new Set<string>([
  "mentor.panel",
  "investor.panel",
  "student.dashboard",
  // MUST stay in this list. `canAccessAdmin` is "holds any admin-area
  // permission", and admin-area is derived by subtracting this set from the
  // catalog — so a permission omitted here silently becomes a key to /admin.
  // calls.invite is granted to mentors and investors by migration 0059;
  // leaving it out would have handed both roles the entire admin panel as a
  // side effect of letting them book a call.
  "calls.invite",
  // MUST stay here too, and for more than the panel. Admin-area access is not
  // just a sidebar: canAccessAdmin is what makes /mentor/students program-wide
  // instead of cohort-scoped, and what turns /dashboard into a staff preview.
  // Ticking "Join any 1:1 call" for the mentor role must not also hand every
  // mentor every student's assignments and files. Its one surface, the list of
  // everyone's calls at /admin/calls, is reached the way it always was —
  // calls.invite plus a role that already opens the admin area — which is
  // what the checkbox's description tells whoever grants it.
  "calls.join_any",
]);

/** Every permission that implies "this person belongs in /admin". */
export const ADMIN_AREA_PERMISSIONS: readonly Permission[] =
  ALL_PERMISSIONS.filter((p) => !NON_ADMIN_PERMISSIONS.has(p));

const ADMIN_AREA_SET = new Set<string>(ADMIN_AREA_PERMISSIONS);

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * The resolved capability set for one viewer. Deliberately a plain object with
 * no Supabase types on it, so middleware, RSCs, and client components can all
 * hold the same shape.
 */
export type Capabilities = {
  role: string;
  permissions: string[];
  /** Full power — the wildcard grant. */
  superAdmin: boolean;
};

export function capabilitiesFrom(
  role: string,
  permissions: readonly string[] | null | undefined,
): Capabilities {
  const list = (permissions ?? []).filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  return {
    role,
    permissions: list,
    superAdmin: list.includes(WILDCARD),
  };
}

export function can(caps: Capabilities | null, permission: Permission): boolean {
  if (!caps) return false;
  if (caps.superAdmin) return true;
  return caps.permissions.includes(permission);
}

/** True when the viewer has at least one of the listed permissions. */
export function canAny(
  caps: Capabilities | null,
  permissions: readonly Permission[],
): boolean {
  if (!caps) return false;
  if (caps.superAdmin) return true;
  return permissions.some((p) => caps.permissions.includes(p));
}

/**
 * What a route or nav row needs: one key, or — for a section landing that
 * forwards to the first tab the viewer holds — any one of several.
 */
export type Requirement = Permission | readonly Permission[];

export function canMeet(caps: Capabilities | null, req: Requirement): boolean {
  return typeof req === "string" ? can(caps, req) : canAny(caps, req);
}

/**
 * The Email section's tabs, in order, with the key each needs. The sidebar
 * has one Email row; /admin/email forwards to the first tab the viewer holds
 * (in the middleware, so it's a real redirect, not a streamed one).
 */
export const EMAIL_TAB_ROUTES = [
  ["/admin/email/templates", "email.templates"],
  ["/admin/email/automations", "email.automate"],
  ["/admin/email/blast", "email.send"],
  ["/admin/email/compose", "email.send"],
  ["/admin/email/outbox", "email.view"],
  ["/admin/email/settings", "email.settings"],
] as const satisfies ReadonlyArray<readonly [string, Permission]>;

/** Every key that opens a tab of the Email section. */
export const EMAIL_PERMISSIONS: readonly Permission[] = Array.from(
  new Set(EMAIL_TAB_ROUTES.map(([, perm]) => perm)),
);

/** Where /admin/email sends this viewer, or null when no tab is theirs. */
export function emailLandingFor(caps: Capabilities | null): string | null {
  return EMAIL_TAB_ROUTES.find(([, perm]) => can(caps, perm))?.[0] ?? null;
}

/**
 * Which of `permissions` the viewer is missing.
 *
 * Takes plain strings because the input is a role's stored permission list,
 * straight out of the database — including the `*` wildcard, which isn't a
 * `Permission`. This is the "can you hand this out?" primitive behind every
 * escalation check: creating a role, editing one, assigning one, and choosing
 * where to move people when deleting one.
 */
export function missingPermissions(
  caps: Capabilities | null,
  permissions: readonly string[],
): string[] {
  if (caps?.superAdmin) return [];
  if (!caps) return [...permissions];
  return permissions.filter((p) => !caps.permissions.includes(p));
}

/**
 * The slugs of every role that holds `permission` — the wildcard included.
 *
 * For the few places that pick PEOPLE by what their role may do rather than
 * by its name: a custom role granted the permission from /admin/roles counts,
 * and a system role it was taken from does not. Takes the stored rows
 * (`getAllRoles`), so it stays as pure as the rest of this file.
 */
export function rolesHolding(
  roles: readonly { slug: string; permissions: readonly string[] | null | undefined }[],
  permission: Permission,
): string[] {
  return roles
    .filter((r) => can(capabilitiesFrom(r.slug, r.permissions), permission))
    .map((r) => r.slug);
}

/** True when the viewer holds everything in `permissions`. */
export function covers(
  caps: Capabilities | null,
  permissions: readonly string[],
): boolean {
  return missingPermissions(caps, permissions).length === 0;
}

/**
 * Can this viewer open /admin at all? Derived rather than a separate checkbox:
 * an admin who ticks "Manage challenges" for a role should not then also have
 * to remember to tick a hidden "can open the admin area" box.
 */
export function canAccessAdmin(caps: Capabilities | null): boolean {
  if (!caps) return false;
  if (caps.superAdmin) return true;
  return caps.permissions.some((p) => ADMIN_AREA_SET.has(p));
}

// ---------------------------------------------------------------------------
// Route → permission
// ---------------------------------------------------------------------------

/**
 * Which permission each /admin route needs. Matching is longest-prefix-first
 * (see `permissionForAdminPath`), so `/admin/email/blast` resolves to
 * `email.send` even though `/admin/email` is also a prefix of it.
 *
 * `/admin` itself is absent on purpose — the overview is reachable by anyone
 * with admin-area access, and it hides the tiles they can't see. Every other
 * page must resolve here or in ADMIN_EXACT_ROUTE_PERMISSIONS
 * (lib/admin-routes.test.ts walks app/admin to check).
 */
export const ADMIN_ROUTE_PERMISSIONS: ReadonlyArray<readonly [string, Permission]> = [
  ["/admin/applications", "applications.view"],
  ["/admin/recovery", "applications.review"],
  ["/admin/application-questions", "applications.form"],
  // More specific than /admin/students, so it wins the longest-prefix match:
  // creating accounts + enrolments needs people.manage, not just people.view.
  ["/admin/students/new", "people.manage"],
  ["/admin/students", "people.view"],
  ["/admin/progress", "people.view"],
  ["/admin/mentors", "mentors.manage"],
  ["/admin/cohorts", "cohorts.manage"],
  ["/admin/challenges", "challenges.manage"],
  ["/admin/teams", "teams.manage"],
  ["/admin/demo-day", "demoday.manage"],
  ["/admin/intros", "intros.manage"],
  ["/admin/assignments", "assignments.manage"],
  ["/admin/calls", "calls.invite"],
  ["/admin/blog", "blog.manage"],
  ["/admin/course", "course.manage"],
  // A redirect to /admin/events now; mapped so old links still resolve.
  ["/admin/webinars", "events.manage"],
  ["/admin/events", "events.manage"],
  ["/admin/resources", "resources.manage"],
  ["/admin/flows", "flows.manage"],
  ["/admin/announcements", "announcements.manage"],
  ["/admin/charges", "charges.manage"],
  ["/admin/payments", "payments.view"],
  ["/admin/pricing", "settings.manage"],
  ["/admin/email/blast", "email.send"],
  ["/admin/email/templates", "email.templates"],
  ["/admin/email/automations", "email.automate"],
  ["/admin/email/compose", "email.send"],
  ["/admin/email/outbox", "email.view"],
  ["/admin/email/settings", "email.settings"],
  // Any other page under /admin/email. The landing itself is in
  // ADMIN_EXACT_ROUTE_PERMISSIONS below.
  ["/admin/email", "email.view"],
  ["/admin/referrals", "referrals.view"],
  ["/admin/passes", "passes.manage"],
  ["/admin/pass-requests", "passes.manage"],
  // Read-gated, not write-gated: the whole scholarship area opens on
  // `scholarships.view`, and every mutation inside it re-asserts
  // `scholarships.manage`. That split is what makes a read-only reviewer role
  // possible — someone who reads the queue and discusses it without being able
  // to hand out tuition or refund a card.
  ["/admin/scholarships", "scholarships.view"],
  // Read-gated like the scholarship area above, for the same reason: the queue
  // opens on `support.view` and every mutation inside it re-asserts
  // `support.manage`, which is what makes a read-only role possible — someone
  // who can see what people are asking for without being able to answer in
  // batch0's name or resolve a refund request.
  //
  // More specific than /admin/support, so it wins the longest-prefix match
  // wherever it sits in this list: logging a request on someone's behalf is a
  // write, and it needs the write key.
  ["/admin/support/new", "support.manage"],
  ["/admin/support", "support.view"],
  ["/admin/moderation", "moderation.manage"],
  ["/admin/discord", "discord.manage"],
  ["/admin/audit", "audit.view"],
  ["/admin/settings", "settings.manage"],
  ["/admin/roles", "roles.manage"],
];

/**
 * Pages whose requirement differs from the prefix rule covering them, matched
 * on the exact path only so nothing nested under them inherits it.
 */
export const ADMIN_EXACT_ROUTE_PERMISSIONS: ReadonlyArray<readonly [string, Requirement]> = [
  // The sidebar's one Email row lands here and is forwarded to the first tab
  // the viewer holds, so it opens on any email key.
  ["/admin/email", EMAIL_PERMISSIONS],
];

const EXACT_RULES = new Map(ADMIN_EXACT_ROUTE_PERMISSIONS);

// Precomputed longest-first so the lookup is a straight scan.
const ROUTE_RULES = [...ADMIN_ROUTE_PERMISSIONS].sort(
  (a, b) => b[0].length - a[0].length,
);

/** Boundary-aware so `/admin/teams-archive` never matches `/admin/teams`. */
function underPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + "/");
}

/**
 * The permission `path` requires, or null when the path is inside /admin but
 * has no specific requirement (the overview, and anything not yet mapped).
 */
export function permissionForAdminPath(path: string): Requirement | null {
  const exact = EXACT_RULES.get(path);
  if (exact) return exact;
  for (const [prefix, perm] of ROUTE_RULES) {
    if (underPrefix(path, prefix)) return perm;
  }
  return null;
}

/** The gate the admin layout and the middleware both apply. */
export function canViewAdminPath(
  caps: Capabilities | null,
  path: string,
): boolean {
  if (!canAccessAdmin(caps)) return false;
  const required = permissionForAdminPath(path);
  return required === null ? true : canMeet(caps, required);
}

// ---------------------------------------------------------------------------
// Built-in roles
// ---------------------------------------------------------------------------

/**
 * The four roles that predate the roles table. They still exist as rows in
 * `app_roles` (so they can be re-permissioned like any other role) but their
 * slugs are load-bearing across the codebase and can't be renamed or deleted.
 * Kept in sync with the seed in migration 0048.
 */
export const SYSTEM_ROLE_SLUGS = [
  "student",
  "admin",
  "mentor",
  "investor",
] as const;

export function isSystemRole(slug: string): boolean {
  return (SYSTEM_ROLE_SLUGS as readonly string[]).includes(slug);
}

/**
 * Slugs the app itself resolves by name. Custom roles must not collide with a
 * top-level route or the router would shadow them in URLs like /admin/roles/x.
 */
const RESERVED_SLUGS = new Set<string>([
  ...SYSTEM_ROLE_SLUGS,
  "new",
  "edit",
  "delete",
  "admin",
  "api",
  "auth",
  "all",
  "none",
  "null",
  "undefined",
  "teacher",
  "professor",
]);

export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug);
}

/** Lowercase, hyphenated, letters/digits only — safe in a URL and in SQL. */
export function slugifyRole(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

export const ROLE_SLUG_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

/** The colour tokens a role can wear, and the classes each maps to. */
export const ROLE_COLORS = {
  slate: "border-line text-ink-soft",
  phosphor: "border-phosphor/50 text-phosphor-ink",
  emerald: "border-emerald-500/40 text-emerald-700 dark:text-emerald-300",
  purple: "border-purple-500/40 text-purple-700 dark:text-purple-300",
  amber: "border-amber-500/40 text-amber-700 dark:text-amber-300",
  sky: "border-sky-500/40 text-sky-700 dark:text-sky-300",
  rose: "border-rose-500/40 text-rose-700 dark:text-rose-300",
} as const;

export type RoleColor = keyof typeof ROLE_COLORS;

export const ROLE_COLOR_KEYS = Object.keys(ROLE_COLORS) as RoleColor[];

export function roleColorClasses(color: string | null | undefined): string {
  return ROLE_COLORS[(color ?? "slate") as RoleColor] ?? ROLE_COLORS.slate;
}

/** Landing pages a role can be pointed at. */
export const ROLE_HOME_OPTIONS = [
  { value: "/admin", label: "Admin panel" },
  { value: "/dashboard", label: "Student dashboard" },
  { value: "/mentor", label: "Mentor panel" },
  { value: "/investor", label: "Investor panel" },
] as const;

const HOME_VALUES = new Set(ROLE_HOME_OPTIONS.map((o) => o.value));

export function isValidRoleHome(path: string): boolean {
  return HOME_VALUES.has(path as (typeof ROLE_HOME_OPTIONS)[number]["value"]);
}

/**
 * Where a role lands when it has no explicit home, or when its stored home is
 * somewhere it can no longer reach. Pure function of the capabilities, so a
 * role that loses `mentor.panel` stops being sent to /mentor.
 */
export function fallbackHomeFor(caps: Capabilities): string {
  if (canAccessAdmin(caps)) return "/admin";
  if (can(caps, "mentor.panel")) return "/mentor";
  if (can(caps, "investor.panel")) return "/investor";
  return "/dashboard";
}

/** Can this role actually reach the home it's configured with? */
export function canReachHome(caps: Capabilities, home: string): boolean {
  if (home.startsWith("/admin")) return canAccessAdmin(caps);
  if (home.startsWith("/mentor")) return can(caps, "mentor.panel");
  if (home.startsWith("/investor")) return can(caps, "investor.panel");
  return true; // /dashboard is reachable by everyone
}

export function resolveHome(caps: Capabilities, home: string | null): string {
  const target = home && isValidRoleHome(home) ? home : null;
  if (target && canReachHome(caps, target)) return target;
  return fallbackHomeFor(caps);
}
