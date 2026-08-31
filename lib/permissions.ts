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
  "pulse.view",
  "interventions.manage",
  "ai_usage.view",
  "email.view",
  "email.send",
  "email.templates",
  "email.automate",
  "email.settings",
  "referrals.view",
  "passes.manage",
  "moderation.manage",
  "discord.manage",
  "audit.view",
  "settings.manage",
  "roles.manage",
  // Other panels
  "mentor.panel",
  "investor.panel",
  "student.dashboard",
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
        description: "Invite mentors, edit mentor profiles, and run mentor matching.",
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
        description: "Edit modules and lessons, and read course analytics.",
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
    ],
  },
  {
    label: "Operations",
    permissions: [
      {
        key: "pulse.view",
        label: "View Pulse",
        description: "Read the cohort health dashboard.",
      },
      {
        key: "interventions.manage",
        label: "Manage at-risk students",
        description: "Work the at-risk queue and log interventions.",
      },
      {
        key: "ai_usage.view",
        label: "View AI usage",
        description: "Read AI co-founder usage and spend.",
      },
      {
        key: "email.view",
        label: "View email metrics",
        description: "Read delivery, open, and bounce metrics.",
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
        key: "moderation.manage",
        label: "Moderate",
        description: "Review reported content and act on it.",
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
 * Permissions that are about the *other* panels rather than /admin. A role
 * holding only these should land on /mentor or /dashboard, not the admin area.
 */
const NON_ADMIN_PERMISSIONS = new Set<string>([
  "mentor.panel",
  "investor.panel",
  "student.dashboard",
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
 * with admin-area access, and it hides the tiles they can't see.
 */
export const ADMIN_ROUTE_PERMISSIONS: ReadonlyArray<readonly [string, Permission]> = [
  ["/admin/applications", "applications.view"],
  ["/admin/application-questions", "applications.form"],
  ["/admin/students", "people.view"],
  ["/admin/progress", "people.view"],
  ["/admin/mentors", "mentors.manage"],
  ["/admin/cohorts", "cohorts.manage"],
  ["/admin/challenges", "challenges.manage"],
  ["/admin/teams", "teams.manage"],
  ["/admin/demo-day", "demoday.manage"],
  ["/admin/intros", "intros.manage"],
  ["/admin/blog", "blog.manage"],
  ["/admin/course", "course.manage"],
  ["/admin/events", "events.manage"],
  ["/admin/resources", "resources.manage"],
  ["/admin/flows", "flows.manage"],
  ["/admin/announcements", "announcements.manage"],
  ["/admin/charges", "charges.manage"],
  ["/admin/payments", "payments.view"],
  ["/admin/pulse", "pulse.view"],
  ["/admin/interventions", "interventions.manage"],
  ["/admin/ai-usage", "ai_usage.view"],
  ["/admin/email/blast", "email.send"],
  ["/admin/email/templates", "email.templates"],
  ["/admin/email/automations", "email.automate"],
  ["/admin/email/compose", "email.send"],
  ["/admin/email/outbox", "email.view"],
  ["/admin/email/settings", "email.settings"],
  ["/admin/email", "email.view"],
  ["/admin/referrals", "referrals.view"],
  ["/admin/passes", "passes.manage"],
  ["/admin/pass-requests", "passes.manage"],
  ["/admin/moderation", "moderation.manage"],
  ["/admin/discord", "discord.manage"],
  ["/admin/audit", "audit.view"],
  ["/admin/settings", "settings.manage"],
  ["/admin/roles", "roles.manage"],
];

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
export function permissionForAdminPath(path: string): Permission | null {
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
  return required === null ? true : can(caps, required);
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
