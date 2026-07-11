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
  Calendar as CalendarIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  exact?: boolean;
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
// both the desktop sidebar and the mobile drawer to hide dead-end links
// before enrollment — keep this list as the single source of truth.
export const ENROLLED_ONLY_HREFS = new Set<string>([
  "/dashboard/course",
  "/dashboard/team",
  "/dashboard/checkin",
  "/dashboard/office-hours",
  "/dashboard/events",
  "/dashboard/resources",
  "/dashboard/files",
  "/dashboard/intros",
]);

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
      { href: "/admin/applications", label: "Applications", icon: Inbox },
      {
        href: "/admin/application-questions",
        label: "Application form",
        icon: FileText,
      },
      { href: "/admin/students", label: "People", icon: Users },
      { href: "/admin/mentors", label: "Mentors", icon: Handshake },
    ],
  },
  {
    label: "Cohorts & teams",
    items: [
      { href: "/admin/cohorts", label: "Cohorts", icon: Calendar },
      { href: "/admin/teams", label: "Teams", icon: Briefcase },
      { href: "/admin/demo-day", label: "Demo Day", icon: Rocket },
      { href: "/admin/intros", label: "Intros", icon: Handshake },
    ],
  },
  {
    label: "Content",
    items: [
      { href: "/admin/course", label: "Course", icon: BookOpen },
      { href: "/admin/events", label: "Events", icon: CalendarDays },
      { href: "/admin/resources", label: "Resources", icon: FolderArchive },
      { href: "/admin/announcements", label: "Announcements", icon: Megaphone },
    ],
  },
  {
    label: "Finance",
    items: [
      { href: "/admin/charges", label: "Fees & fines", icon: CreditCard },
      { href: "/admin/payments", label: "Payments", icon: CreditCard },
    ],
  },
  {
    label: "Operations",
    items: [
      { href: "/admin/pulse", label: "Pulse", icon: Activity },
      { href: "/admin/interventions", label: "At-risk", icon: ShieldCheck },
      { href: "/admin/mentors/match", label: "Mentor match", icon: Sparkles },
      { href: "/admin/ai-usage", label: "AI usage", icon: Sparkles },
      { href: "/admin/email", label: "Email metrics", icon: Mail },
      { href: "/admin/email/blast", label: "Email blast", icon: Send },
      { href: "/admin/referrals", label: "Referrals", icon: Star },
      { href: "/admin/moderation", label: "Moderation", icon: ShieldCheck },
      { href: "/admin/discord", label: "Discord", icon: MessagesSquare },
      { href: "/admin/audit", label: "Audit log", icon: ScrollText },
      { href: "/admin/settings", label: "Settings", icon: Settings },
    ],
  },
];

export const ADMIN_NAV: NavItem[] = ADMIN_NAV_GROUPS.flatMap((g) => g.items);

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
