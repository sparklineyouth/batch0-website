import {
  Home,
  FileText,
  Percent,
  PlayCircle,
  CalendarDays,
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
  ClipboardList,
  FolderArchive,
  Rocket,
  Mail,
  Send,
  Trophy,
  Newspaper,
  Ticket,
  Flag,
  KeyRound,
  Video,
  Workflow,
  LineChart,
  GraduationCap,
  LifeBuoy,
  Hash,
  Smartphone,
  UserPlus,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  STUDENT_NAV_LAYOUT,
  isStudentHrefVisible,
  type StudentNavContext,
  type StudentNavHref,
} from "@/lib/student-nav";
import {
  canMeet,
  EMAIL_PERMISSIONS,
  EMAIL_TAB_ROUTES,
  SMS_PERMISSIONS,
  SMS_TAB_ROUTES,
  TEAMS_PAGE_PERMISSIONS,
  type Capabilities,
  type Permission,
  type Requirement,
} from "@/lib/permissions";

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  exact?: boolean;
  /**
   * Permission required to see this link. Admin items carry one so the
   * sidebar shows exactly the pages the viewer can actually open — the same
   * string the route guard checks (see ADMIN_ROUTE_PERMISSIONS). Items with
   * no `perm` are visible to anyone who can reach the panel. A list means
   * any one of them (a section landing such as Email).
   */
  perm?: Requirement;
  /** Extra words the nav search matches, e.g. the tabs a row opens. */
  keywords?: readonly string[];
};

/** The nav search: label or keyword contains the (lowercased) query. */
export function navItemMatches(item: NavItem, q: string): boolean {
  if (!q) return true;
  return [item.label, ...(item.keywords ?? [])].some((w) =>
    w.toLowerCase().includes(q),
  );
}

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
// Student — the links and who sees them live in lib/student-nav.ts; this adds
// the icons.
// ---------------------------------------------------------------------------

const STUDENT_ICONS: Record<StudentNavHref, LucideIcon> = {
  "/dashboard": Home,
  "/dashboard/application": FileText,
  "/dashboard/kickoff": Flag,
  "/dashboard/course": PlayCircle,
  "/dashboard/assignments": ClipboardList,
  "/dashboard/team": Rocket,
  "/dashboard/events": CalendarDays,
  "/dashboard/calls": Video,
  "/dashboard/resources": FolderArchive,
  "/dashboard/announcements": Megaphone,
  "/chat": MessagesSquare,
  "/dashboard/billing": CreditCard,
  "/dashboard/scholarships": GraduationCap,
  "/dashboard/referrals": Star,
  "/dashboard/support": LifeBuoy,
  "/dashboard/settings": Settings,
};

/** Words the nav search also matches: pages reached from inside another one. */
const STUDENT_KEYWORDS: Partial<Record<StudentNavHref, readonly string[]>> = {
  "/dashboard/team": ["investor intros", "ai co-founder", "pitch", "drive"],
  "/dashboard/billing": ["receipts", "scholarships", "fees", "refer friends", "referrals"],
};

export const STUDENT_NAV_GROUPS: NavGroup[] = STUDENT_NAV_LAYOUT.map((g) => ({
  label: g.label,
  items: g.items.map((it) => ({
    href: it.href,
    label: it.label,
    icon: STUDENT_ICONS[it.href],
    ...(it.href === "/dashboard" ? { exact: true } : {}),
    ...(STUDENT_KEYWORDS[it.href] ? { keywords: STUDENT_KEYWORDS[it.href] } : {}),
  })),
}));

/** Desktop sidebar and mobile drawer: one predicate, so they can't drift. */
export function filterStudentNavItem(
  item: NavItem,
  ctx: StudentNavContext,
): boolean {
  return isStudentHrefVisible(item.href, ctx);
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export const ADMIN_NAV_GROUPS: NavGroup[] = [
  {
    label: "",
    items: [
      { href: "/admin", label: "Overview", icon: LayoutDashboard, exact: true },
      // The chat app itself, outside /admin: every admin-area role has chat.
      { href: "/chat", label: "Chat", icon: MessagesSquare, keywords: ["messages", "dms", "channels"] },
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
      { href: "/admin/recovery", label: "Enrollment recovery", icon: MessagesSquare, perm: "applications.review" },
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
        keywords: ["add a person", "students"],
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
        href: "/admin/assignments",
        label: "Assignments",
        icon: ClipboardList,
        perm: "assignments.manage",
      },
      {
        href: "/admin/challenges",
        label: "Challenges",
        icon: Trophy,
        perm: "challenges.manage",
      },
      // Pending team logos are reviewed at the top of this page.
      {
        href: "/admin/teams",
        label: "Teams",
        icon: Briefcase,
        perm: TEAMS_PAGE_PERMISSIONS,
        keywords: ["logos", "moderation"],
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
        href: "/admin/pricing",
        label: "Pricing",
        icon: Percent,
        perm: "settings.manage",
      },
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
      {
        href: "/admin/scholarships",
        label: "Scholarships",
        icon: GraduationCap,
        perm: "scholarships.view",
        keywords: ["scholarship queue"],
      },
    ],
  },
  {
    label: "Operations",
    items: [
      {
        href: "/admin/progress",
        label: "Student progress",
        icon: LineChart,
        perm: "people.view",
      },
      // One row for the whole section; its tabs (EMAIL_TABS) do the rest.
      {
        href: "/admin/email",
        label: "Email",
        icon: Mail,
        perm: EMAIL_PERMISSIONS,
        keywords: ["templates", "automations", "blast", "compose", "outbox"],
      },
      // Same shape: one row, and SMS_TABS do the rest.
      {
        href: "/admin/sms",
        label: "Texting",
        icon: Smartphone,
        perm: SMS_PERMISSIONS,
        keywords: ["sms", "text messages", "campaign", "opt-in", "consent", "twilio"],
      },
      // One row, not two. The queue is the only page in the section anyone
      // navigates to directly — a request's detail page is always reached by
      // clicking the row, never by typing the URL.
      {
        href: "/admin/support",
        label: "Support",
        icon: LifeBuoy,
        perm: "support.view",
      },
      {
        href: "/admin/referrals",
        label: "Referrals",
        icon: Star,
        perm: "referrals.view",
      },
      // Redeemed feedback credits are worked at the top of this page.
      {
        href: "/admin/passes",
        label: "Founder passes",
        icon: Ticket,
        perm: "passes.manage",
        keywords: ["pass requests", "feedback requests"],
      },
      {
        href: "/admin/chat",
        label: "Chat channels",
        icon: Hash,
        perm: "chat.manage",
        keywords: ["chat reports", "moderation", "channels"],
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
 * The Email section's tab bar: EMAIL_TAB_ROUTES (lib/permissions.ts, which
 * the /admin/email landing also reads) dressed with labels and icons.
 */
const EMAIL_TAB_LOOK: Record<(typeof EMAIL_TAB_ROUTES)[number][0], Pick<NavItem, "label" | "icon">> = {
  "/admin/email/templates": { label: "Templates", icon: FileText },
  "/admin/email/automations": { label: "Automations", icon: Workflow },
  "/admin/email/blast": { label: "Blast", icon: Send },
  "/admin/email/compose": { label: "Compose", icon: Mail },
  "/admin/email/outbox": { label: "Outbox", icon: Inbox },
  "/admin/email/settings": { label: "Settings", icon: Settings },
};
export const EMAIL_TABS: (NavItem & { perm: Permission })[] = EMAIL_TAB_ROUTES.map(
  ([href, perm]) => ({ href, perm, ...EMAIL_TAB_LOOK[href] }),
);

/** The Texting section's tab bar, from SMS_TAB_ROUTES the same way. */
const SMS_TAB_LOOK: Record<(typeof SMS_TAB_ROUTES)[number][0], Pick<NavItem, "label" | "icon">> = {
  "/admin/sms/outbox": { label: "Outbox", icon: Inbox },
  "/admin/sms/blast": { label: "Campaign", icon: Send },
  "/admin/sms/consent": { label: "Consent", icon: ShieldCheck },
  "/admin/sms/collect": { label: "Collect numbers", icon: UserPlus },
  "/admin/sms/settings": { label: "Settings", icon: Settings },
};
export const SMS_TABS: (NavItem & { perm: Permission })[] = SMS_TAB_ROUTES.map(
  ([href, perm]) => ({ href, perm, ...SMS_TAB_LOOK[href] }),
);

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
  return canMeet(caps, item.perm);
}

// ---------------------------------------------------------------------------
// Mentor
// ---------------------------------------------------------------------------

export const MENTOR_NAV_GROUPS: NavGroup[] = [
  {
    label: "",
    items: [
      { href: "/mentor", label: "Overview", icon: LayoutDashboard, exact: true },
      { href: "/chat", label: "Chat", icon: MessagesSquare },
      // Under /dashboard but open to every role (lib/dashboard-gate.ts): a
      // mentor's own requests to the team, not the student view.
      { href: "/dashboard/support", label: "Help & support", icon: LifeBuoy },
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
      { href: "/mentor/assignments", label: "Assignments", icon: ClipboardList },
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
      { href: "/chat", label: "Chat", icon: MessagesSquare },
      // Same exemption as the mentor's — see MENTOR_NAV_GROUPS.
      { href: "/dashboard/support", label: "Help & support", icon: LifeBuoy },
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
