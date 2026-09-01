"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Input, Textarea, Label } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import { getActionError } from "@/lib/action-error";
import type { PassProfile } from "@/lib/founder-pass";
import { updatePassProfileAction } from "./actions";

/**
 * The holder's editor for their optional public founder profile (perk 9).
 * Everything here is holder-controlled: what to fill in, and — via the publish
 * toggle — whether any of it shows on the public /pass/[serial] page at all.
 * The ticket (name + serial + code) is always public once a card is claimed;
 * this block is the part the holder opts into.
 */
export function ProfileEditor({
  serial,
  initial,
}: {
  serial: number;
  initial: PassProfile;
}) {
  const [projectName, setProjectName] = useState(initial.projectName ?? "");
  const [bio, setBio] = useState(initial.bio ?? "");
  const [websiteUrl, setWebsiteUrl] = useState(initial.websiteUrl ?? "");
  const [demoUrl, setDemoUrl] = useState(initial.demoUrl ?? "");
  const [milestones, setMilestones] = useState(
    (initial.milestones ?? []).join("\n"),
  );
  const [isPublic, setIsPublic] = useState(initial.public);

  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();
  const [saved, setSaved] = useState(false);

  function save(nextPublic = isPublic) {
    setError(undefined);
    setSaved(false);
    start(async () => {
      try {
        const res = await updatePassProfileAction({
          projectName,
          bio,
          websiteUrl,
          demoUrl,
          milestones: milestones
            .split("\n")
            .map((m) => m.trim())
            .filter(Boolean),
          isPublic: nextPublic,
        });
        if (!res.ok) {
          setError(res.message);
          return;
        }
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      } catch (e) {
        setError(getActionError(e));
      }
    });
  }

  return (
    <div className="space-y-4">
      <Toggle
        label={isPublic ? "Profile is public" : "Profile is private"}
        description={
          isPublic
            ? "Your project and links show on your public pass page."
            : "Only your ticket is public. Publish to show the details below."
        }
        checked={isPublic}
        disabled={pending}
        onChange={(next) => {
          setIsPublic(next);
          // Toggling publish is the one action worth persisting immediately —
          // it changes what the world sees, so it shouldn't wait behind "Save".
          save(next);
        }}
      />

      {isPublic && (
        <p className="text-xs text-ink-faint">
          Live at{" "}
          <Link
            href={`/pass/${serial}`}
            className="font-medium text-phosphor-ink underline underline-offset-4"
          >
            batch0.org/pass/{serial}
          </Link>
        </p>
      )}

      <div>
        <Label htmlFor="project-name">Project</Label>
        <Input
          id="project-name"
          value={projectName}
          maxLength={120}
          placeholder="What you're building"
          disabled={pending}
          onChange={(e) => setProjectName(e.target.value)}
        />
      </div>

      <div>
        <Label htmlFor="founder-bio">Bio</Label>
        <Textarea
          id="founder-bio"
          rows={3}
          value={bio}
          maxLength={600}
          placeholder="A line or two about you and what you're working on."
          disabled={pending}
          onChange={(e) => setBio(e.target.value)}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="website-url">Website</Label>
          <Input
            id="website-url"
            value={websiteUrl}
            placeholder="yoursite.com"
            disabled={pending}
            onChange={(e) => setWebsiteUrl(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="demo-url">Demo</Label>
          <Input
            id="demo-url"
            value={demoUrl}
            placeholder="Link to a demo or video"
            disabled={pending}
            onChange={(e) => setDemoUrl(e.target.value)}
          />
        </div>
      </div>

      <div>
        <Label htmlFor="milestones">Shipped milestones</Label>
        <Textarea
          id="milestones"
          rows={4}
          value={milestones}
          placeholder={"One per line —\nShipped v1\nFirst 10 users\nRevenue"}
          disabled={pending}
          onChange={(e) => setMilestones(e.target.value)}
        />
        <p className="mt-1 text-xs text-ink-faint">
          One per line. Up to 8 show on your page.
        </p>
      </div>

      {error && <p className="text-xs text-red-700 dark:text-red-300">{error}</p>}

      <div className="flex items-center gap-3">
        <Button size="sm" onClick={() => save()} disabled={pending}>
          {pending ? "Saving…" : "Save profile"}
        </Button>
        {saved && (
          <span className="text-xs font-medium text-phosphor-ink">Saved</span>
        )}
      </div>
    </div>
  );
}
