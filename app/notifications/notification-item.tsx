"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Bell,
  CreditCard,
  Megaphone,
  Sparkles,
  FileText,
  CalendarDays,
  CheckCircle,
  MessageSquareText,
  GraduationCap,
  ShieldAlert,
} from "lucide-react";
import { markNotificationRead } from "./actions";
import { formatRelativeTime } from "@/lib/format-time";

type N = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  read_at: string | null;
  created_at: string;
};

const ICON_BY_TYPE: Record<string, any> = {
  welcome: Sparkles,
  announcement: Megaphone,
  application_submitted: FileText,
  application_decision: FileText,
  application_accepted: GraduationCap,
  fine_issued: ShieldAlert,
  fee_issued: CreditCard,
  charge_waived: CreditCard,
  payment_succeeded: CreditCard,
  event_created: CalendarDays,
  checkin_submitted: CheckCircle,
  checkin_feedback: MessageSquareText,
};

function iconFor(type: string) {
  return ICON_BY_TYPE[type] ?? Bell;
}

export function NotificationItem({ n }: { n: N }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const Icon = iconFor(n.type);

  function onClick() {
    if (!n.read_at) {
      start(async () => {
        try {
          await markNotificationRead(n.id);
        } catch {}
        if (n.link) router.push(n.link);
        else router.refresh();
      });
    } else if (n.link) {
      router.push(n.link);
    }
  }

  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className={`flex w-full items-start gap-3 px-4 py-3.5 text-left transition hover:bg-white/[0.03] ${
          n.read_at ? "opacity-70" : ""
        }`}
      >
        <div
          className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${
            n.read_at
              ? "border-white/10 bg-zinc-900/60 text-white/40"
              : "border-spark/30 bg-spark/10 text-spark"
          }`}
        >
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="text-sm font-medium text-white">{n.title}</div>
            {!n.read_at && (
              <span className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-spark" />
            )}
          </div>
          {n.body && (
            <p className="mt-0.5 text-sm text-white/60">{n.body}</p>
          )}
          <p className="mt-1.5 text-[11px] uppercase tracking-wider text-white/35">
            {formatRelativeTime(n.created_at)}
          </p>
        </div>
      </button>
    </li>
  );
}
