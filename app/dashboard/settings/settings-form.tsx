"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input, Label, FieldError } from "@/components/ui/input";

export function SettingsForm({
  initialFullName,
  email,
}: {
  initialFullName: string;
  email: string;
}) {
  const router = useRouter();
  const [fullName, setFullName] = useState(initialFullName);
  const [password, setPassword] = useState("");
  const [pwSaving, setPwSaving] = useState(false);
  const [pwError, setPwError] = useState<string | undefined>();
  const [pwOk, setPwOk] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileError, setProfileError] = useState<string | undefined>();
  const [profileOk, setProfileOk] = useState(false);

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    setProfileSaving(true);
    setProfileError(undefined);
    setProfileOk(false);
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      setProfileSaving(false);
      return;
    }
    const { error } = await supabase
      .from("profiles")
      .update({ full_name: fullName })
      .eq("id", user.id);
    if (error) setProfileError(error.message);
    else {
      setProfileOk(true);
      router.refresh();
    }
    setProfileSaving(false);
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwSaving(true);
    setPwError(undefined);
    setPwOk(false);
    const supabase = createClient();
    const { error } = await supabase.auth.updateUser({ password });
    if (error) setPwError(error.message);
    else {
      setPwOk(true);
      setPassword("");
    }
    setPwSaving(false);
  }

  return (
    <div className="space-y-8">
      <form onSubmit={saveProfile} className="space-y-4">
        <h3 className="text-sm font-medium uppercase tracking-wider text-white/50">
          Profile
        </h3>
        <div>
          <Label>Email</Label>
          <Input value={email} disabled />
          <p className="mt-1 text-xs text-white/40">
            To change your email, contact us.
          </p>
        </div>
        <div>
          <Label htmlFor="full_name">Full name</Label>
          <Input
            id="full_name"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
          />
        </div>
        <FieldError>{profileError}</FieldError>
        {profileOk && <p className="text-xs text-emerald-300">Saved.</p>}
        <Button type="submit" disabled={profileSaving}>
          {profileSaving ? "Saving…" : "Save profile"}
        </Button>
      </form>

      <div className="border-t border-white/10 pt-8">
        <form onSubmit={changePassword} className="space-y-4">
          <h3 className="text-sm font-medium uppercase tracking-wider text-white/50">
            Change password
          </h3>
          <div>
            <Label htmlFor="password">New password</Label>
            <Input
              id="password"
              type="password"
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
            />
          </div>
          <FieldError>{pwError}</FieldError>
          {pwOk && <p className="text-xs text-emerald-300">Password updated.</p>}
          <Button type="submit" disabled={pwSaving || password.length < 8}>
            {pwSaving ? "Saving…" : "Update password"}
          </Button>
        </form>
      </div>
    </div>
  );
}
