"use client";
import { useState, useTransition, useRef } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Label, FieldError } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/dialog";
import { createClient } from "@/lib/supabase/client";
import { Upload, Trash2 } from "lucide-react";
import {
  updateTeamInfo,
  getTeamLogoUploadToken,
  setTeamLogo,
  clearTeamLogo,
  leaveTeam,
} from "./actions";
import { getActionError } from "@/lib/action-error";

type Team = {
  id: string;
  name: string;
  tagline: string | null;
  description: string | null;
  logo_url: string | null;
  logo_status: "pending" | "approved" | "rejected";
  website_url: string | null;
};

export function TeamProfileTab({ team }: { team: Team }) {
  const router = useRouter();
  const [name, setName] = useState(team.name);
  const [tagline, setTagline] = useState(team.tagline ?? "");
  const [description, setDescription] = useState(team.description ?? "");
  const [website, setWebsite] = useState(team.website_url ?? "");
  const [err, setErr] = useState<string | undefined>();
  const [pending, start] = useTransition();
  const [uploadErr, setUploadErr] = useState<string | undefined>();
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);

  function save() {
    setErr(undefined);
    start(async () => {
      try {
        await updateTeamInfo({
          teamId: team.id,
          name,
          tagline,
          description,
          website_url: website,
        });
        router.refresh();
      } catch (e: any) {
        setErr(getActionError(e));
      }
    });
  }

  async function onPickLogo(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadErr(undefined);
    if (file.size > 5 * 1024 * 1024) {
      setUploadErr("Logo must be under 5 MB.");
      return;
    }
    if (!file.type.startsWith("image/")) {
      setUploadErr("Pick an image file.");
      return;
    }
    setUploading(true);
    try {
      const { path, token } = await getTeamLogoUploadToken({
        teamId: team.id,
        filename: file.name,
      });
      const supabase = createClient();
      const up = await supabase.storage
        .from("team-logos")
        .uploadToSignedUrl(path, token, file);
      if (up.error) throw up.error;
      await setTeamLogo({ teamId: team.id, path });
      router.refresh();
    } catch (err: any) {
      setUploadErr(err.message ?? String(err));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function removeLogo() {
    setUploadErr(undefined);
    start(async () => {
      try {
        await clearTeamLogo({ teamId: team.id });
        router.refresh();
      } catch (e: any) {
        setUploadErr(e.message);
      }
    });
  }

  function executeLeave() {
    start(async () => {
      try {
        await leaveTeam();
        router.refresh();
      } catch (e: any) {
        setErr(getActionError(e));
      } finally {
        setConfirmLeave(false);
      }
    });
  }

  return (
    <div className="space-y-6">
      <Card>
        <h3 className="text-base font-semibold">Logo</h3>
        <p className="mt-1 text-xs text-ink-faint">
          Used on your team's public page. Uploads are reviewed before
          showing publicly to keep cohorts safe.
        </p>
        <div className="mt-4 flex items-center gap-4">
          <div className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-2xl border border-line bg-wash">
            {team.logo_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={team.logo_url} alt="" className="h-full w-full object-cover" />
            ) : (
              <span className="text-3xl font-bold text-phosphor-ink">
                {team.name.slice(0, 1).toUpperCase()}
              </span>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <label className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-lg bg-phosphor px-3 text-sm font-semibold text-on-phosphor hover:bg-phosphor-200">
              <Upload className="h-4 w-4" />
              {uploading ? "Uploading…" : "Upload logo"}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={onPickLogo}
                disabled={uploading}
              />
            </label>
            {team.logo_url && (
              <Button
                variant="secondary"
                size="md"
                onClick={removeLogo}
                disabled={pending}
              >
                <Trash2 className="h-3.5 w-3.5" /> Remove
              </Button>
            )}
          </div>
        </div>
        <FieldError>{uploadErr}</FieldError>
      </Card>

      <Card>
        <h3 className="text-base font-semibold">Team info</h3>
        <div className="mt-4 space-y-4">
          <div>
            <Label htmlFor="team-name">Name</Label>
            <Input
              id="team-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
            />
          </div>
          <div>
            <Label htmlFor="team-tagline">Tagline</Label>
            <Input
              id="team-tagline"
              value={tagline}
              onChange={(e) => setTagline(e.target.value)}
              placeholder="One-line description of what you're building"
              maxLength={120}
            />
          </div>
          <div>
            <Label htmlFor="team-desc">About</Label>
            <Textarea
              id="team-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="The problem, who it's for, where you are"
              maxLength={4000}
              rows={5}
            />
          </div>
          <div>
            <Label htmlFor="team-site">Website</Label>
            <Input
              id="team-site"
              type="url"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
              placeholder="https://..."
            />
          </div>
          <div className="flex items-center gap-3">
            <Button onClick={save} disabled={pending}>
              {pending ? "Saving…" : "Save changes"}
            </Button>
            <FieldError>{err}</FieldError>
          </div>
        </div>
      </Card>

      <Card>
        <h3 className="text-base font-semibold text-red-700 dark:text-red-300">Danger zone</h3>
        <p className="mt-1 text-xs text-ink-faint">
          Leaving is permanent. If you're the last member the team will be
          deleted (and all drive files lost).
        </p>
        <div className="mt-4">
          <Button
            variant="danger"
            size="sm"
            onClick={() => setConfirmLeave(true)}
          >
            Leave team
          </Button>
        </div>
      </Card>

      <ConfirmDialog
        open={confirmLeave}
        title="Leave this team?"
        description="You'll lose access to the thread, drive, and pitch submission."
        confirmLabel="Leave"
        destructive
        pending={pending}
        onConfirm={executeLeave}
        onCancel={() => !pending && setConfirmLeave(false)}
      />
    </div>
  );
}
