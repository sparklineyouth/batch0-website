"use client";
import React from "react";
import Image from "next/image";
import type { SiteConfig } from "@/lib/site-config";
import {
  Home,
  FileText,
  PlayCircle,
  ClipboardList,
  CheckCircle,
  CalendarDays,
  FolderArchive,
  MessagesSquare,
  Sparkles,
  FolderOpen,
  CreditCard,
  Settings,
  Bell,
  ArrowRight,
  Users,
  Trophy,
  type LucideIcon,
} from "lucide-react";
import { ContainerScroll } from "./container-scroll";

const NAV = [
  { label: "Home", icon: Home, active: true },
  { label: "Application", icon: FileText },
  { label: "Course", icon: PlayCircle },
  { label: "Assignments", icon: ClipboardList },
  { label: "Check-in", icon: CheckCircle },
  { label: "Events", icon: CalendarDays },
  { label: "Resources", icon: FolderArchive },
  { label: "Community", icon: MessagesSquare },
  { label: "AI co-founder", icon: Sparkles },
  { label: "Files", icon: FolderOpen },
  { label: "Billing", icon: CreditCard },
  { label: "Settings", icon: Settings },
];

const MOBILE_FEATURES: {
  icon: LucideIcon;
  eyebrow: string;
  title: string;
  body: string;
  accent?: boolean;
}[] = [
  {
    icon: PlayCircle,
    eyebrow: "Curriculum",
    title: "Weekly skill blocks + live sessions",
    body: "Pre-recorded startup modules you can watch on your schedule, plus a weekly group session with mentors and peers.",
  },
  {
    icon: Sparkles,
    eyebrow: "Always-on",
    title: "Your AI co-founder",
    body: "Stuck on a Lean Canvas at 11pm? Your AI co-founder is trained on the cohort curriculum and your own progress.",
    accent: true,
  },
  {
    icon: Trophy,
    eyebrow: "Pitch Day",
    title: "Investor pitch + intros",
    body: "Week 4 ends live on Zoom in front of the SparkLine team and our investor network. Standouts may be offered sponsorship and warm intros — zero equity, ever. Funding is never guaranteed.",
  },
];

export default function ScrollPreview({ config }: { config: SiteConfig }) {
  const { derived } = config;
  return (
    <section id="how-it-works" className="relative -mt-16">
      {/* Mobile: simple stacked feature cards. The 3D zoom mock works at
         desktop sizes but on a 360px phone it shrinks to a barely-legible
         postage stamp with 9px labels. Showing three real, readable
         feature cards instead actually communicates the product. */}
      <div className="md:hidden relative px-5 pt-20 pb-20">
        <div className="mx-auto max-w-md text-center">
          <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-spark">
            The product
          </p>
          <h2 className="mt-3 text-[28px] font-bold tracking-[-0.02em] text-white leading-[1.05]">
            From idea to <span className="shine">investor-ready</span>
          </h2>
          <p className="mt-3 text-[15px] text-white/75 leading-[1.55]">
            Live startup curriculum, weekly deliverables, real founder
            mentors, and a cohort dashboard that keeps everything in
            one place.
          </p>
        </div>
        <ul className="mt-10 mx-auto max-w-md space-y-3">
          {MOBILE_FEATURES.map((f) => {
            const Icon = f.icon;
            return (
              <li
                key={f.title}
                className={`group relative overflow-hidden rounded-2xl border p-5 ${
                  f.accent
                    ? "border-spark/30 bg-gradient-to-br from-spark/[0.08] to-transparent"
                    : "border-white/10 bg-white/[0.02]"
                }`}
              >
                <div className="flex items-start gap-4">
                  <span
                    className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${
                      f.accent
                        ? "bg-spark text-black"
                        : "bg-white/[0.04] text-spark"
                    }`}
                  >
                    <Icon className="h-5 w-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-white/45">
                      {f.eyebrow}
                    </p>
                    <h3 className="mt-1 text-[17px] font-semibold tracking-tight text-white">
                      {f.title}
                    </h3>
                    <p className="mt-1.5 text-[14px] text-white/70 leading-[1.55]">
                      {f.body}
                    </p>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
        <p className="mt-6 text-center text-xs text-white/55">
          Everything ships inside one dashboard ·{" "}
          <a href="#apply" className="text-spark hover:underline">
            Apply
          </a>
        </p>
      </div>

      {/* Desktop: 3D scroll-zoom mock dashboard — the original treatment. */}
      <div className="hidden md:block">
        <ContainerScroll
          titleComponent={
            <>
              <p className="text-xs font-medium uppercase tracking-[0.22em] text-spark">
                The product
              </p>
              <h2 className="mt-3 text-3xl md:text-5xl font-bold tracking-[-0.02em] text-white leading-[1.05]">
                From idea to <span className="shine">investor-ready</span>
              </h2>
              <p className="mt-4 max-w-2xl text-base md:text-lg text-white/75 mx-auto leading-relaxed">
                Live startup curriculum, weekly deliverables, real
                founder mentors, and a cohort dashboard that keeps
                everything in one place.
              </p>
            </>
          }
        >
          <div className="relative h-full w-full bg-black overflow-hidden">
            <div className="relative grid h-full grid-cols-12 gap-0 text-left">
              {/* Sidebar — matches the real /dashboard sidebar */}
              <aside className="col-span-3 flex h-full flex-col border-r border-white/10 bg-zinc-950/50 px-3 py-4">
                <div className="mb-6 flex items-center justify-between px-2">
                  <div className="flex items-center gap-2">
                    <Image src="/logo.svg" alt="" width={20} height={20} />
                    <span className="font-semibold tracking-tight text-white text-sm">
                      Spark<span className="text-spark">Line</span> Youth
                    </span>
                  </div>
                  <div className="relative">
                    <span className="flex h-7 w-7 items-center justify-center rounded-lg border border-white/10 text-white/70">
                      <Bell className="h-3.5 w-3.5" />
                    </span>
                    <span className="absolute -right-1 -top-1 flex h-3 min-w-3 items-center justify-center rounded-full bg-spark px-1 text-[8px] font-bold text-black">
                      2
                    </span>
                  </div>
                </div>
                <nav className="space-y-0.5">
                  {NAV.map((item) => {
                    const Icon = item.icon;
                    return (
                      <div
                        key={item.label}
                        className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs ${
                          item.active
                            ? "bg-spark/10 text-spark"
                            : "text-white/55"
                        }`}
                      >
                        <Icon className="h-3.5 w-3.5" />
                        {item.label}
                      </div>
                    );
                  })}
                </nav>
              </aside>

              {/* Main content — mirrors /dashboard/page.tsx layout */}
              <main className="col-span-9 h-full overflow-hidden px-10 py-8">
                <div>
                  <h3 className="text-3xl font-bold tracking-tight text-white">
                    Welcome, Riya.
                  </h3>
                  <p className="mt-1 text-sm text-white/50">
                    Your startup, your skill blocks, your investor prep.
                  </p>
                </div>

                <div className="mt-8 grid gap-4 grid-cols-2">
                  <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
                    <div className="flex items-start justify-between gap-2">
                      <h4 className="text-xs font-medium uppercase tracking-wider text-white/45">
                        Application
                      </h4>
                      <span className="rounded-full border border-spark/40 bg-spark/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-spark">
                        Accepted
                      </span>
                    </div>
                    <p className="mt-2 text-2xl font-semibold text-white">
                      You're in
                    </p>
                    <div className="mt-5">
                      <button className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-spark px-3.5 text-xs font-semibold text-black">
                        Pay {derived.priceLabel}
                        <ArrowRight className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>

                  <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
                    <h4 className="text-xs font-medium uppercase tracking-wider text-white/45">
                      Course access
                    </h4>
                    <p className="mt-2 text-2xl font-semibold text-white">
                      {derived.cohortName}
                    </p>
                    {derived.dateRangeLabel && (
                      <p className="mt-1 text-xs text-white/45">
                        {derived.dateRangeLabel}
                      </p>
                    )}
                    <div className="mt-5">
                      <button className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-3.5 text-xs font-semibold text-white">
                        Open course
                        <ArrowRight className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                </div>

                <div className="mt-8">
                  <h4 className="text-sm font-semibold text-white">
                    Quick links
                  </h4>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {[
                      "View application",
                      "Billing",
                      "Settings",
                      "Community",
                    ].map((label) => (
                      <span
                        key={label}
                        className="rounded-lg border border-white/15 bg-white/5 px-2.5 py-1 text-[11px] text-white/75"
                      >
                        {label}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="mt-6 rounded-xl border border-spark/20 bg-spark/[0.04] p-4">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-[10px] uppercase tracking-widest text-spark">
                        This week
                      </div>
                      <div className="mt-0.5 truncate text-sm text-white">
                        Week 1 · Customer discovery due Sunday
                      </div>
                    </div>
                    <span className="rounded-full bg-spark px-3 py-1.5 text-xs font-semibold text-black">
                      Open
                    </span>
                  </div>
                </div>
              </main>
            </div>
          </div>
        </ContainerScroll>
      </div>
    </section>
  );
}
