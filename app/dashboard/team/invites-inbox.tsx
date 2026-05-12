"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/input";
import { respondToInvite } from "./actions";

type Invite = {
  id: string;
  message: string | null;
  created_at: string;
  team: { id: string; name: string; tagline: string | null };
  invited_by_profile: { full_name: string | null; email: string };
};

export function InvitesInbox({ invites }: { invites: Invite[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | undefined>();
  const [active, setActive] = useState<string | null>(null);

  function respond(id: string, accept: boolean) {
    setErr(undefined);
    setActive(id);
    start(async () => {
      try {
        await respondToInvite({ inviteId: id, accept });
        router.refresh();
      } catch (e: any) {
        setErr(e.message);
      } finally {
        setActive(null);
      }
    });
  }

  return (
    <div className="space-y-3">
      {invites.map((inv) => {
        const t = Array.isArray(inv.team) ? inv.team[0] : inv.team;
        const by = Array.isArray(inv.invited_by_profile)
          ? inv.invited_by_profile[0]
          : inv.invited_by_profile;
        return (
          <Card key={inv.id}>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <h3 className="text-base font-semibold">{t?.name}</h3>
                {t?.tagline && (
                  <p className="mt-0.5 text-sm text-white/55">{t.tagline}</p>
                )}
                <p className="mt-2 text-xs text-white/45">
                  Invited by {by?.full_name ?? by?.email}
                </p>
                {inv.message && (
                  <p className="mt-3 whitespace-pre-wrap text-sm text-white/80">
                    {inv.message}
                  </p>
                )}
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={pending && active === inv.id}
                  onClick={() => respond(inv.id, false)}
                >
                  Decline
                </Button>
                <Button
                  size="sm"
                  disabled={pending && active === inv.id}
                  onClick={() => respond(inv.id, true)}
                >
                  {pending && active === inv.id ? "Working…" : "Accept"}
                </Button>
              </div>
            </div>
          </Card>
        );
      })}
      <FieldError>{err}</FieldError>
    </div>
  );
}
