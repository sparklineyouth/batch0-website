import {
  Home,
  FileText,
  PlayCircle,
  ClipboardList,
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
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  exact?: boolean;
};

export const STUDENT_NAV: NavItem[] = [
  { href: "/dashboard", label: "Home", icon: Home, exact: true },
  { href: "/dashboard/application", label: "Application", icon: FileText },
  { href: "/dashboard/course", label: "Course", icon: PlayCircle },
  { href: "/dashboard/assignments", label: "Assignments", icon: ClipboardList },
  { href: "/dashboard/events", label: "Events", icon: CalendarDays },
  { href: "/dashboard/community", label: "Community", icon: MessagesSquare },
  { href: "/dashboard/ai", label: "AI co-founder", icon: Sparkles },
  { href: "/dashboard/files", label: "Files", icon: FolderOpen },
  { href: "/dashboard/billing", label: "Billing", icon: CreditCard },
  { href: "/dashboard/settings", label: "Settings", icon: Settings },
];

export const ADMIN_NAV: NavItem[] = [
  { href: "/admin", label: "Overview", icon: LayoutDashboard, exact: true },
  { href: "/admin/applications", label: "Applications", icon: Inbox },
  { href: "/admin/students", label: "People", icon: Users },
  { href: "/admin/cohorts", label: "Cohorts", icon: Calendar },
  { href: "/admin/teams", label: "Teams", icon: Briefcase },
  { href: "/admin/course", label: "Course", icon: BookOpen },
  { href: "/admin/events", label: "Events", icon: CalendarDays },
  { href: "/admin/mentors", label: "Mentors", icon: Handshake },
  { href: "/admin/announcements", label: "Announcements", icon: Megaphone },
  { href: "/admin/discord", label: "Discord", icon: MessagesSquare },
  { href: "/admin/charges", label: "Fees & fines", icon: CreditCard },
  { href: "/admin/payments", label: "Payments", icon: CreditCard },
  { href: "/admin/audit", label: "Audit log", icon: ScrollText },
  { href: "/admin/settings", label: "Settings", icon: Settings },
];

export const MENTOR_NAV: NavItem[] = [
  { href: "/mentor", label: "Overview", icon: LayoutDashboard, exact: true },
  { href: "/mentor/students", label: "Students", icon: Users },
  { href: "/mentor/course", label: "Course", icon: BookOpen },
  { href: "/mentor/assignments", label: "Assignments", icon: ClipboardList },
];

export const INVESTOR_NAV: NavItem[] = [
  { href: "/investor", label: "Overview", icon: LayoutDashboard, exact: true },
  { href: "/investor/teams", label: "Teams", icon: Briefcase },
  { href: "/investor/interests", label: "My interests", icon: Star },
];

export const STAFF_LINKS = {
  admin: { href: "/admin", label: "Admin panel", icon: ShieldCheck },
  mentor: { href: "/mentor", label: "Mentor panel", icon: Handshake },
  investor: { href: "/investor", label: "Investor panel", icon: Briefcase },
};
