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
  ChevronRight,
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
  const isUnread = !n.read_at;

  function onClick() {
    if (isUnread) {
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
        className="group press relative flex w-full items-start gap-4 py-5 text-left hover:bg-wash"
      >
        {isUnread && (
          <span
            aria-hidden
            className="absolute left-0 top-0 h-full w-[2px] bg-phosphor"
          />
        )}
        <div
          className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md border ${
            isUnread
              ? "border-phosphor/30 bg-phosphor/10 text-phosphor-ink"
              : "border-line text-ink-faint"
          }`}
        >
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <p
              className={`min-w-0 flex-1 break-words text-[15px] leading-snug ${
                isUnread
                  ? "font-medium text-ink"
                  : "font-normal text-ink-soft"
              }`}
            >
              {n.title}
            </p>
            <p
              className={`shrink-0 pt-0.5 font-mono text-[11px] tabular-nums ${
                isUnread ? "text-ink-soft" : "text-ink-faint"
              }`}
            >
              {formatRelativeTime(n.created_at)}
            </p>
          </div>
          {n.body && (
            <p
              className={`mt-1 break-words text-sm leading-relaxed ${
                isUnread ? "text-ink-soft" : "text-ink-faint"
              }`}
            >
              {n.body}
            </p>
          )}
        </div>
        {n.link && (
          <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-ink-faint transition-transform group-hover:translate-x-0.5 group-hover:text-ink-soft" />
        )}
      </button>
    </li>
  );
}
