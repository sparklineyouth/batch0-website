"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Textarea, FieldError, Label } from "@/components/ui/input";
import { Search, X, UserMinus } from "lucide-react";
import {
  searchStudentsForInvite,
  inviteStudent,
  cancelInvite,
  removeTeamMember,
} from "./actions";
import { getActionError } from "@/lib/action-error";

type Member = {
  id: string;
  user_id: string;
  role: string;
  profile: { full_name: string | null; email: string };
};

type Invite = {
  id: string;
  message: string | null;
  created_at: string;
  invitee: { full_name: string | null; email: string };
};

export function TeamMembersTab({
  currentUserId,
  team,
  members,
  pendingInvites,
}: {
  currentUserId: string;
  team: { id: string };
  members: Member[];
  pendingInvites: Invite[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | undefined>();

  // Search state.
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<
    { id: string; full_name: string | null; email: string }[]
  >([]);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<{
    id: string;
    full_name: string | null;
    email: string;
  } | null>(null);
  const [message, setMessage] = useState("");

  async function doSearch() {
    setErr(undefined);
    setSearching(true);
    try {
      const r = await searchStudentsForInvite({
        teamId: team.id,
        query,
      });
      setResults(r);
    } catch (e: any) {
      setErr(getActionError(e));
    } finally {
      setSearching(false);
    }
  }

  function sendInvite() {
    if (!picked) return;
    setErr(undefined);
    start(async () => {
      try {
        await inviteStudent({
          teamId: team.id,
          inviteeId: picked.id,
          message,
        });
        setPicked(null);
        setMessage("");
        setQuery("");
        setResults([]);
        router.refresh();
      } catch (e: any) {
        setErr(getActionError(e));
      }
    });
  }

  function removeMember(memberUserId: string) {
    start(async () => {
      try {
        await removeTeamMember({
          teamId: team.id,
          memberId: memberUserId,
        });
        router.refresh();
      } catch (e: any) {
        setErr(getActionError(e));
      }
    });
  }

  function cancelOutbound(inviteId: string) {
    start(async () => {
      try {
        await cancelInvite({ inviteId });
        router.refresh();
      } catch (e: any) {
        setErr(getActionError(e));
      }
    });
  }

  return (
    <div className="space-y-6">
      <Card>
        <h3 className="text-base font-semibold">
          Members ({members.length} / 5)
        </h3>
        <ul className="mt-4 divide-y divide-white/5">
          {members.map((m) => (
            <li key={m.id} className="flex items-center justify-between py-3">
              <div className="min-w-0">
                <div className="truncate text-sm text-white">
                  {m.profile?.full_name ?? m.profile?.email}
                </div>
                <div className="text-xs text-white/40">
                  {m.role}
                  {m.user_id === currentUserId && " · you"}
                </div>
              </div>
              {m.user_id !== currentUserId && (
                <button
                  type="button"
                  onClick={() => removeMember(m.user_id)}
                  disabled={pending}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-white/40 hover:bg-white/5 hover:text-red-400"
                >
                  <UserMinus className="h-3 w-3" /> Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <h3 className="text-base font-semibold">Invite a teammate</h3>
        <p className="mt-1 text-xs text-white/50">
          Search by name or email. They'll get a notification and decide
          whether to accept.
        </p>

        {!picked && (
          <>
            <div className="mt-4 flex gap-2">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/30" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") doSearch();
                  }}
                  placeholder="Search name or email"
                  className="pl-9"
                />
              </div>
              <Button
                onClick={doSearch}
                disabled={searching || query.trim().length < 2}
                variant="secondary"
              >
                {searching ? "Searching…" : "Search"}
              </Button>
            </div>

            {results.length > 0 && (
              <ul className="mt-3 divide-y divide-white/5 rounded-lg border border-white/10">
                {results.map((r) => (
                  <li
                    key={r.id}
                    className="flex items-center justify-between gap-2 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm text-white">
                        {r.full_name ?? "—"}
                      </div>
                      <div className="truncate text-xs text-white/40">
                        {r.email}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setPicked(r)}
                    >
                      Invite
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {query.trim().length >= 2 &&
              results.length === 0 &&
              !searching && (
                <p className="mt-3 text-xs text-white/40">
                  No matches. They might already be on a team, or have a
                  different role.
                </p>
              )}
          </>
        )}

        {picked && (
          <div className="mt-4 space-y-3">
            <div className="flex items-center justify-between rounded-lg border border-white/10 bg-zinc-900/50 px-3 py-2">
              <div className="min-w-0">
                <div className="truncate text-sm">
                  {picked.full_name ?? picked.email}
                </div>
                <div className="truncate text-xs text-white/40">
                  {picked.email}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setPicked(null)}
                className="text-white/40 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div>
              <Label htmlFor="invite-msg">Personal message (optional)</Label>
              <Textarea
                id="invite-msg"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="What you're building, why you want them on the team…"
                maxLength={400}
                rows={3}
              />
            </div>
            <Button onClick={sendInvite} disabled={pending}>
              {pending ? "Sending…" : "Send invite"}
            </Button>
          </div>
        )}
        <FieldError>{err}</FieldError>
      </Card>

      {pendingInvites.length > 0 && (
        <Card>
          <h3 className="text-base font-semibold">Pending invites</h3>
          <ul className="mt-3 divide-y divide-white/5">
            {pendingInvites.map((inv) => {
              const p = Array.isArray(inv.invitee)
                ? inv.invitee[0]
                : inv.invitee;
              return (
                <li
                  key={inv.id}
                  className="flex items-center justify-between py-3"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm">
                      {p?.full_name ?? p?.email}
                    </div>
                    <div className="text-xs text-white/40">
                      Sent {new Date(inv.created_at).toLocaleDateString()}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => cancelOutbound(inv.id)}
                    disabled={pending}
                    className="rounded-md px-2 py-1 text-xs text-white/40 hover:text-red-400"
                  >
                    Cancel
                  </button>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}
