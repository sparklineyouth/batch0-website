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
  Calendar as CalendarIcon,
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
  { href: "/dashboard/team", label: "Team", icon: Rocket },
  { href: "/dashboard/checkin", label: "Check-in", icon: CheckCircle },
  { href: "/dashboard/office-hours", label: "Office hours", icon: CalendarIcon },
  { href: "/dashboard/events", label: "Events", icon: CalendarDays },
  { href: "/dashboard/resources", label: "Resources", icon: FolderArchive },
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
  { href: "/admin/demo-day", label: "Demo Day", icon: Rocket },
  { href: "/admin/intros", label: "Intros", icon: Handshake },
  { href: "/admin/moderation", label: "Moderation", icon: ShieldCheck },
  { href: "/admin/course", label: "Course", icon: BookOpen },
  { href: "/admin/events", label: "Events", icon: CalendarDays },
  { href: "/admin/mentors", label: "Mentors", icon: Handshake },
  { href: "/admin/resources", label: "Resources", icon: FolderArchive },
  { href: "/admin/announcements", label: "Announcements", icon: Megaphone },
  { href: "/admin/discord", label: "Discord", icon: MessagesSquare },
  { href: "/admin/charges", label: "Fees & fines", icon: CreditCard },
  { href: "/admin/payments", label: "Payments", icon: CreditCard },
  { href: "/admin/audit", label: "Audit log", icon: ScrollText },
  { href: "/admin/mfa", label: "Two-factor", icon: ShieldCheck },
  { href: "/admin/settings", label: "Settings", icon: Settings },
];

export const MENTOR_NAV: NavItem[] = [
  { href: "/mentor", label: "Overview", icon: LayoutDashboard, exact: true },
  { href: "/mentor/students", label: "Students", icon: Users },
  { href: "/mentor/teams", label: "Teams", icon: Briefcase },
  { href: "/mentor/checkins", label: "Check-ins", icon: CheckCircle },
  { href: "/mentor/office-hours", label: "Office hours", icon: CalendarIcon },
  { href: "/mentor/course", label: "Course", icon: BookOpen },
];

export const INVESTOR_NAV: NavItem[] = [
  { href: "/investor", label: "Overview", icon: LayoutDashboard, exact: true },
  { href: "/investor/teams", label: "Teams", icon: Briefcase },
  { href: "/investor/demo-day", label: "Demo Day", icon: Rocket },
  { href: "/investor/interests", label: "My interests", icon: Star },
  { href: "/investor/intros", label: "Intros", icon: Handshake },
];

export const STAFF_LINKS = {
  admin: { href: "/admin", label: "Admin panel", icon: ShieldCheck },
  mentor: { href: "/mentor", label: "Mentor panel", icon: Handshake },
  investor: { href: "/investor", label: "Investor panel", icon: Briefcase },
};
