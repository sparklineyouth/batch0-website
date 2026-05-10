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
  GraduationCap,
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
  { href: "/admin/payments", label: "Payments", icon: CreditCard },
  { href: "/admin/audit", label: "Audit log", icon: ScrollText },
  { href: "/admin/settings", label: "Settings", icon: Settings },
];

export const PROFESSOR_NAV: NavItem[] = [
  { href: "/professor", label: "Overview", icon: LayoutDashboard, exact: true },
  { href: "/professor/students", label: "Students", icon: Users },
  { href: "/professor/course", label: "Course", icon: BookOpen },
  { href: "/professor/assignments", label: "Assignments", icon: ClipboardList },
];

export const MENTOR_NAV: NavItem[] = [
  { href: "/mentor", label: "Overview", icon: LayoutDashboard, exact: true },
  { href: "/mentor/students", label: "My students", icon: Users },
  { href: "/mentor/notes", label: "Notes", icon: MessagesSquare },
];

export const INVESTOR_NAV: NavItem[] = [
  { href: "/investor", label: "Overview", icon: LayoutDashboard, exact: true },
  { href: "/investor/teams", label: "Teams", icon: Briefcase },
  { href: "/investor/interests", label: "My interests", icon: Star },
];

export const STAFF_LINKS = {
  admin: { href: "/admin", label: "Admin panel", icon: ShieldCheck },
  professor: { href: "/professor", label: "Professor panel", icon: GraduationCap },
  mentor: { href: "/mentor", label: "Mentor panel", icon: Handshake },
  investor: { href: "/investor", label: "Investor panel", icon: Briefcase },
};
