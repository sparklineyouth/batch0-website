"use client";
import React from "react";
import Image from "next/image";
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

export default function ScrollPreview() {
  return (
    <section id="how-it-works" className="relative -mt-16">
      <ContainerScroll
        titleComponent={
          <>
            <h2 className="text-3xl md:text-5xl font-bold tracking-tight text-white">
              From idea to <span className="shine">funded startup</span>
            </h2>
            <p className="mt-4 text-base md:text-xl text-white/60 max-w-2xl mx-auto">
              4 weeks, fully online. A real curriculum, real mentors, real
              investors on demo day.
            </p>
          </>
        }
      >
        <div className="relative h-full w-full bg-black overflow-hidden">
          <div className="absolute inset-0 grid-bg opacity-40" />
          <div className="absolute -right-32 -top-32 h-96 w-96 rounded-full bg-spark/15 blur-3xl" />

          <div className="relative grid h-full grid-cols-12 gap-0 text-left">
            {/* Sidebar — matches the real /dashboard sidebar */}
            <aside className="col-span-3 hidden md:flex h-full flex-col border-r border-white/10 bg-zinc-950/50 px-3 py-4">
              <div className="mb-6 flex items-center justify-between px-2">
                <div className="flex items-center gap-2">
                  <Image src="/logo.svg" alt="" width={20} height={20} />
                  <span className="font-semibold tracking-tight text-white text-sm">
                    Spark<span className="text-spark">Line</span>
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
            <main className="col-span-12 md:col-span-9 h-full overflow-hidden px-4 py-4 md:px-10 md:py-8">
              {/* Mobile-only brand bar (the sidebar carries this on desktop). */}
              <div className="mb-4 flex items-center justify-between md:hidden">
                <div className="flex items-center gap-1.5">
                  <Image src="/logo.svg" alt="" width={16} height={16} />
                  <span className="text-xs font-semibold tracking-tight text-white">
                    Spark<span className="text-spark">Line</span>
                  </span>
                </div>
                <div className="relative">
                  <span className="flex h-6 w-6 items-center justify-center rounded-md border border-white/10 text-white/70">
                    <Bell className="h-3 w-3" />
                  </span>
                  <span className="absolute -right-1 -top-1 flex h-3 min-w-3 items-center justify-center rounded-full bg-spark px-1 text-[8px] font-bold text-black">
                    2
                  </span>
                </div>
              </div>

              <div>
                <h3 className="text-lg sm:text-xl md:text-3xl font-bold tracking-tight text-white">
                  Welcome, Riya.
                </h3>
                <p className="mt-1 text-[11px] sm:text-xs md:text-sm text-white/50">
                  Here's where your SparkLine journey lives.
                </p>
              </div>

              <div className="mt-4 md:mt-8 grid gap-3 md:gap-4 grid-cols-2">
                {/* Application card */}
                <div className="rounded-xl md:rounded-2xl border border-white/10 bg-white/[0.03] p-3 md:p-5">
                  <div className="flex items-start justify-between gap-2">
                    <h4 className="text-[9px] md:text-xs font-medium uppercase tracking-wider text-white/45">
                      Application
                    </h4>
                    <span className="rounded-full border border-spark/40 bg-spark/10 px-1.5 py-0.5 text-[8px] md:text-[10px] font-semibold uppercase tracking-wider text-spark">
                      Accepted
                    </span>
                  </div>
                  <p className="mt-1.5 md:mt-2 text-base md:text-2xl font-semibold text-white">
                    You're in
                  </p>
                  <div className="mt-3 md:mt-5">
                    <button className="inline-flex h-7 md:h-9 items-center gap-1 md:gap-1.5 rounded-md md:rounded-lg bg-spark px-2 md:px-3.5 text-[10px] md:text-xs font-semibold text-black">
                      Pay $97
                      <ArrowRight className="h-3 w-3 md:h-3.5 md:w-3.5" />
                    </button>
                  </div>
                </div>

                {/* Course access card */}
                <div className="rounded-xl md:rounded-2xl border border-white/10 bg-white/[0.03] p-3 md:p-5">
                  <h4 className="text-[9px] md:text-xs font-medium uppercase tracking-wider text-white/45">
                    Course access
                  </h4>
                  <p className="mt-1.5 md:mt-2 text-base md:text-2xl font-semibold text-white">
                    Summer 2026
                  </p>
                  <p className="mt-0.5 md:mt-1 text-[10px] md:text-xs text-white/45">
                    Jun 15 → Jul 13
                  </p>
                  <div className="mt-3 md:mt-5">
                    <button className="inline-flex h-7 md:h-9 items-center gap-1 md:gap-1.5 rounded-md md:rounded-lg border border-white/15 bg-white/5 px-2 md:px-3.5 text-[10px] md:text-xs font-semibold text-white">
                      Open course
                      <ArrowRight className="h-3 w-3 md:h-3.5 md:w-3.5" />
                    </button>
                  </div>
                </div>
              </div>

              {/* Quick links row */}
              <div className="mt-4 md:mt-8">
                <h4 className="text-xs md:text-sm font-semibold text-white">
                  Quick links
                </h4>
                <div className="mt-2 md:mt-3 flex flex-wrap gap-1.5 md:gap-2">
                  {[
                    "View application",
                    "Billing",
                    "Settings",
                    "Community",
                  ].map((label) => (
                    <span
                      key={label}
                      className="rounded-md md:rounded-lg border border-white/15 bg-white/5 px-2 md:px-2.5 py-0.5 md:py-1 text-[9px] md:text-[11px] text-white/75"
                    >
                      {label}
                    </span>
                  ))}
                </div>
              </div>

              {/* This-week callout — visible on both, just denser on mobile. */}
              <div className="mt-4 md:mt-6 rounded-lg md:rounded-xl border border-spark/20 bg-spark/[0.04] p-2.5 md:p-4">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-[8px] md:text-[10px] uppercase tracking-widest text-spark">
                      This week
                    </div>
                    <div className="mt-0.5 truncate text-[11px] md:text-sm text-white">
                      Week 1 · Customer discovery due Sunday
                    </div>
                  </div>
                  <span className="hidden md:inline rounded-full bg-spark px-3 py-1.5 text-xs font-semibold text-black">
                    Open
                  </span>
                </div>
              </div>
            </main>
          </div>
        </div>
      </ContainerScroll>
    </section>
  );
}
