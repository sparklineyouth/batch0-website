import {
  Home,
  FileText,
  PlayCircle,
  CalendarDays,
  Sparkles,
  FolderOpen,
  CreditCard,
  Settings,
  ShieldCheck,
  LayoutDashboard,
  Inbox,
  Users,
  Calendar,
  Briefcase,
  BookOpen,
  ScrollText,
  Handshake,
  MessagesSquare,
  Star,
  Megaphone,
  CheckCircle,
  FolderArchive,
  Rocket,
  Activity,
  Mail,
  Send,
  Trophy,
  Newspaper,
  Ticket,
  Flag,
  KeyRound,
  Calendar as CalendarIcon,
  Radio,
  Video,
  Workflow,
  LineChart,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { PRE_COHORT_ALLOWED_HREFS } from "@/lib/pre-cohort";
import { can, type Capabilities, type Permission } from "@/lib/permissions";

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  exact?: boolean;
  /**
   * Permission required to see this link. Admin items carry one so the
   * sidebar shows exactly the pages the viewer can actually open — the same
   * string the route guard checks (see ADMIN_ROUTE_PERMISSIONS). Items with
   * no `perm` are visible to anyone who can reach the panel.
   */
  perm?: Permission;
};

// A NavGroup is a labeled subset of nav items rendered as a collapsible
// section in the sidebar. The first group is always expanded; the rest
// remember their open state in localStorage so the user's choice sticks
// across page loads.
export type NavGroup = {
  /** Display name. Use "" for an unlabeled top group (renders flat). */
  label: string;
  items: NavItem[];
};

// ---------------------------------------------------------------------------
// Student
// ---------------------------------------------------------------------------

export const STUDENT_NAV_GROUPS: NavGroup[] = [
  {
    label: "",
    items: [
      { href: "/dashboard", label: "Home", icon: Home, exact: true },
      { href: "/dashboard/application", label: "Application", icon: FileText },
      { href: "/dashboard/kickoff", label: "Kickoff", icon: Flag },
    ],
  },
  {
    label: "Program",
    items: [
      { href: "/dashboard/course", label: "Course", icon: PlayCircle },
      { href: "/dashboard/team", label: "Team", icon: Rocket },
      { href: "/dashboard/checkin", label: "Check-in", icon: CheckCircle },
      {
        href: "/dashboard/office-hours",
        label: "Office hours",
        icon: CalendarIcon,
      },
      { href: "/dashboard/calls", label: "1:1 calls", icon: Video },
      { href: "/dashboard/events", label: "Events", icon: CalendarDays },
      { href: "/dashboard/resources", label: "Resources", icon: FolderArchive },
    ],
  },
  {
    label: "Workspace",
    items: [
      { href: "/dashboard/community", label: "Community", icon: MessagesSquare },
      { href: "/dashboard/announcements", label: "Announcements", icon: Megaphone },
      { href: "/dashboard/ai", label: "AI co-founder", icon: Sparkles },
      { href: "/dashboard/files", label: "Files", icon: FolderOpen },
      { href: "/dashboard/intros", label: "Investor intros", icon: Handshake },
    ],
  },
  {
    label: "Account",
    items: [
      { href: "/dashboard/billing", label: "Billing", icon: CreditCard },
      { href: "/dashboard/referrals", label: "Refer friends", icon: Star },
      { href: "/dashboard/settings", label: "Settings", icon: Settings },
    ],
  },
];

// Legacy flat list — kept so older importers still resolve. New code should
// use STUDENT_NAV_GROUPS.
export const STUDENT_NAV: NavItem[] = STUDENT_NAV_GROUPS.flatMap(
  (g) => g.items,
);

// Routes that only resolve once a student is enrolled in a cohort. Used by
// the desktop sidebar, the mobile drawer, and the dashboard quick links to
// hide dead-end links before enrollment — keep this list as the single
// source of truth. (Community is deliberately absent: Discord is open to
// every signed-in student.)
export const ENROLLED_ONLY_HREFS = new Set<string>([
  "/dashboard/course",
  "/dashboard/team",
  // Matches the RLS policy exactly (migration 0027): every read path on
  // `announcements` requires a row in `enrollments`, so an applicant who
  // isn't enrolled can only ever be shown an empty page. The tab was
  // visible to them anyway, which read as "the team has said nothing"
  // rather than "this unlocks when you enroll".
  "/dashboard/announcements",
  "/dashboard/checkin",
  "/dashboard/office-hours",
  "/dashboard/events",
  "/dashboard/resources",
  "/dashboard/files",
  "/dashboard/intros",
]);

export type StudentNavContext = {
  aiAccess: boolean;
  discordEnabled: boolean;
  referralsEnabled: boolean;
  enrolled: boolean;
  preCohort: boolean;
};

/**
 * The one visibility predicate for student nav items — desktop sidebar and
 * mobile drawer both call this so the two can never drift. Pre-cohort
 * lockdown wins first (only the personal pages + Community and Team
 * survive); then per-feature flags; then the hiding of enrolled-only
 * routes — which applies inside the pre-cohort window too, so an
 * accepted-but-unpaid student sees no Kickoff, Resources, or Team.
 */
export function filterStudentNavItem(
  item: NavItem,
  ctx: StudentNavContext,
): boolean {
  if (ctx.preCohort && !PRE_COHORT_ALLOWED_HREFS.has(item.href)) return false;
  // Kickoff belongs to an enrolled student for the whole life of the cohort:
  // a countdown before day one, the record of day one afterwards. It used to
  // vanish the moment the cohort started, which turned every bookmark and
  // every link in a welcome email into a silent redirect home. Staff resolve
  // as enrolled (lib/access.ts) so they can preview the page they edit.
  if (item.href === "/dashboard/kickoff") {
    return ctx.enrolled;
  }
  if (item.href === "/dashboard/ai") return ctx.aiAccess;
  if (item.href === "/dashboard/community") return ctx.discordEnabled;
  if (item.href === "/dashboard/referrals") return ctx.referralsEnabled;
  if (!ctx.enrolled && ENROLLED_ONLY_HREFS.has(item.href)) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export const ADMIN_NAV_GROUPS: NavGroup[] = [
  {
    label: "",
    items: [
      { href: "/admin", label: "Overview", icon: LayoutDashboard, exact: true },
    ],
  },
  {
    label: "Applicants & people",
    items: [
      {
        href: "/admin/applications",
        label: "Applications",
        icon: Inbox,
        perm: "applications.view",
      },
      {
        href: "/admin/application-questions",
        label: "Application form",
        icon: FileText,
        perm: "applications.form",
      },
      {
        href: "/admin/students",
        label: "People",
        icon: Users,
        perm: "people.view",
      },
      {
        href: "/admin/mentors",
        label: "Mentors",
        icon: Handshake,
        perm: "mentors.manage",
      },
    ],
  },
  {
    label: "Cohorts & teams",
    items: [
      {
        href: "/admin/cohorts",
        label: "Cohorts",
        icon: Calendar,
        perm: "cohorts.manage",
      },
      {
        href: "/admin/challenges",
        label: "Challenges",
        icon: Trophy,
        perm: "challenges.manage",
      },
      {
        href: "/admin/teams",
        label: "Teams",
        icon: Briefcase,
        perm: "teams.manage",
      },
      {
        href: "/admin/demo-day",
        label: "Demo Day",
        icon: Rocket,
        perm: "demoday.manage",
      },
      {
        href: "/admin/intros",
        label: "Intros",
        icon: Handshake,
        perm: "intros.manage",
      },
    ],
  },
  {
    label: "Content",
    items: [
      { href: "/admin/blog", label: "Blog", icon: Newspaper, perm: "blog.manage" },
      {
        href: "/admin/course",
        label: "Course",
        icon: BookOpen,
        perm: "course.manage",
      },
      {
        href: "/admin/events",
        label: "Events",
        icon: CalendarDays,
        perm: "events.manage",
      },
      {
        href: "/admin/webinars",
        label: "Webinars",
        icon: Radio,
        perm: "events.manage",
      },
      {
        href: "/admin/calls",
        label: "1:1 calls",
        icon: Video,
        perm: "calls.invite",
      },
      {
        href: "/admin/resources",
        label: "Resources",
        icon: FolderArchive,
        perm: "resources.manage",
      },
      {
        href: "/admin/flows",
        label: "Pre-cohort flows",
        icon: Flag,
        perm: "flows.manage",
      },
      {
        href: "/admin/announcements",
        label: "Announcements",
        icon: Megaphone,
        perm: "announcements.manage",
      },
    ],
  },
  {
    label: "Finance",
    items: [
      {
        href: "/admin/charges",
        label: "Fees & fines",
        icon: CreditCard,
        perm: "charges.manage",
      },
      {
        href: "/admin/payments",
        label: "Payments",
        icon: CreditCard,
        perm: "payments.view",
      },
    ],
  },
  {
    label: "Operations",
    items: [
      { href: "/admin/pulse", label: "Pulse", icon: Activity, perm: "pulse.view" },
      {
        href: "/admin/progress",
        label: "Student progress",
        icon: LineChart,
        perm: "people.view",
      },
      {
        href: "/admin/interventions",
        label: "At-risk",
        icon: ShieldCheck,
        perm: "interventions.manage",
      },
      {
        href: "/admin/mentors/match",
        label: "Mentor match",
        icon: Sparkles,
        perm: "mentors.manage",
      },
      {
        href: "/admin/ai-usage",
        label: "AI usage",
        icon: Sparkles,
        perm: "ai_usage.view",
      },
      {
        href: "/admin/email",
        label: "Email metrics",
        icon: Mail,
        perm: "email.view",
      },
      {
        href: "/admin/email/blast",
        label: "Email blast",
        icon: Send,
        perm: "email.send",
      },
      {
        href: "/admin/email/templates",
        label: "Email templates",
        icon: FileText,
        perm: "email.templates",
      },
      {
        href: "/admin/email/automations",
        label: "Email automations",
        icon: Workflow,
        perm: "email.automate",
      },
      {
        href: "/admin/email/outbox",
        label: "Email outbox",
        icon: Inbox,
        perm: "email.view",
      },
      {
        href: "/admin/referrals",
        label: "Referrals",
        icon: Star,
        perm: "referrals.view",
      },
      {
        href: "/admin/passes",
        label: "Founder passes",
        icon: Ticket,
        perm: "passes.manage",
      },
      {
        href: "/admin/pass-requests",
        label: "Pass requests",
        icon: Inbox,
        perm: "passes.manage",
      },
      {
        href: "/admin/moderation",
        label: "Moderation",
        icon: ShieldCheck,
        perm: "moderation.manage",
      },
      {
        href: "/admin/discord",
        label: "Discord",
        icon: MessagesSquare,
        perm: "discord.manage",
      },
      {
        href: "/admin/roles",
        label: "Roles & permissions",
        icon: KeyRound,
        perm: "roles.manage",
      },
      {
        href: "/admin/audit",
        label: "Audit log",
        icon: ScrollText,
        perm: "audit.view",
      },
      {
        href: "/admin/settings",
        label: "Settings",
        icon: Settings,
        perm: "settings.manage",
      },
    ],
  },
];

export const ADMIN_NAV: NavItem[] = ADMIN_NAV_GROUPS.flatMap((g) => g.items);

/**
 * The one visibility predicate for admin nav items. Both the desktop sidebar
 * and the mobile drawer call it with the viewer's permission list, so the two
 * can't drift — and neither can drift from the route guard, since both read
 * the same `perm` the guard checks.
 */
export function filterAdminNavItem(
  item: NavItem,
  caps: Capabilities | null,
): boolean {
  if (!item.perm) return true;
  return can(caps, item.perm);
}

// ---------------------------------------------------------------------------
// Mentor
// ---------------------------------------------------------------------------

export const MENTOR_NAV_GROUPS: NavGroup[] = [
  {
    label: "",
    items: [
      { href: "/mentor", label: "Overview", icon: LayoutDashboard, exact: true },
    ],
  },
  {
    label: "Students & teams",
    items: [
      { href: "/mentor/students", label: "Students", icon: Users },
      { href: "/mentor/teams", label: "Teams", icon: Briefcase },
    ],
  },
  {
    label: "Sessions",
    items: [
      { href: "/mentor/checkins", label: "Check-ins", icon: CheckCircle },
      {
        href: "/mentor/office-hours",
        label: "Office hours",
        icon: CalendarIcon,
      },
      { href: "/mentor/calls", label: "1:1 calls", icon: Video },
      { href: "/mentor/course", label: "Course", icon: BookOpen },
    ],
  },
  {
    label: "Library",
    items: [
      { href: "/mentor/resources", label: "Resources", icon: FolderArchive },
    ],
  },
];

export const MENTOR_NAV: NavItem[] = MENTOR_NAV_GROUPS.flatMap((g) => g.items);

// ---------------------------------------------------------------------------
// Investor
// ---------------------------------------------------------------------------

export const INVESTOR_NAV_GROUPS: NavGroup[] = [
  {
    label: "",
    items: [
      { href: "/investor", label: "Overview", icon: LayoutDashboard, exact: true },
    ],
  },
  {
    label: "Teams",
    items: [
      { href: "/investor/teams", label: "Teams", icon: Briefcase },
      { href: "/investor/demo-day", label: "Demo Day", icon: Rocket },
    ],
  },
  {
    label: "Pipeline",
    items: [
      { href: "/investor/interests", label: "My interests", icon: Star },
      { href: "/investor/intros", label: "Intros", icon: Handshake },
      { href: "/investor/calls", label: "1:1 calls", icon: Video },
    ],
  },
];

export const INVESTOR_NAV: NavItem[] = INVESTOR_NAV_GROUPS.flatMap(
  (g) => g.items,
);

export const STAFF_LINKS = {
  admin: { href: "/admin", label: "Admin panel", icon: ShieldCheck },
  mentor: { href: "/mentor", label: "Mentor panel", icon: Handshake },
  investor: { href: "/investor", label: "Investor panel", icon: Briefcase },
};
