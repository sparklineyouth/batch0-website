"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea, FieldError } from "@/components/ui/input";
import { saveLanding, type LandingInput } from "./actions";
import { getActionError } from "@/lib/action-error";

export function LandingForm({ initial }: { initial: LandingInput }) {
  const router = useRouter();
  const [v, setV] = useState(initial);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();
  const [okMsg, setOkMsg] = useState<string | undefined>();

  function save() {
    setError(undefined);
    setOkMsg(undefined);
    start(async () => {
      try {
        await saveLanding(v);
        setOkMsg("Saved.");
        router.refresh();
      } catch (e) {
        setError(getActionError(e));
      }
    });
  }

  return (
    <div className="space-y-5">
      <div>
        <Label>Headline</Label>
        <Input
          value={v.landing_headline}
          onChange={(e) => setV({ ...v, landing_headline: e.target.value })}
          placeholder="Default: Startups built at SparkLine"
        />
      </div>
      <div>
        <Label>Subhead</Label>
        <Textarea
          rows={3}
          value={v.landing_subhead}
          onChange={(e) => setV({ ...v, landing_subhead: e.target.value })}
          placeholder="The supporting line under the headline."
        />
      </div>
      <div>
        <Label>CTA label</Label>
        <Input
          value={v.landing_cta_label}
          onChange={(e) => setV({ ...v, landing_cta_label: e.target.value })}
          placeholder="Default: Apply to the next cohort"
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label>Accent color (hex)</Label>
          <Input
            value={v.accent_hex}
            onChange={(e) => setV({ ...v, accent_hex: e.target.value })}
            placeholder="#facc15"
          />
          {v.accent_hex && (
            <div
              className="mt-2 h-6 w-12 rounded border border-white/10"
              style={{ background: v.accent_hex || "transparent" }}
            />
          )}
        </div>
        <div>
          <Label>Hero image URL</Label>
          <Input
            value={v.hero_image_url}
            onChange={(e) => setV({ ...v, hero_image_url: e.target.value })}
            placeholder="https://…"
          />
        </div>
      </div>
      {error && <FieldError>{error}</FieldError>}
      {okMsg && <p className="text-xs text-emerald-300">{okMsg}</p>}
      <div className="flex justify-end">
        <Button onClick={save} disabled={pending}>
          {pending ? "Saving…" : "Save landing"}
        </Button>
      </div>
    </div>
  );
}
