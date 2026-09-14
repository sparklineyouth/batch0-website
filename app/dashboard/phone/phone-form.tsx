"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label, FieldError } from "@/components/ui/input";
import { Check, Loader2 } from "lucide-react";
import { isValidPhone } from "@/lib/phone";
import { savePhoneAction } from "./actions";

/**
 * The one field on /dashboard/phone. Mirrors the form's own validation with
 * the shared `isValidPhone` so the inline error matches what the server will
 * say, and only actually submits once the number is plausible.
 */
export function PhoneForm({ initialPhone }: { initialPhone: string }) {
  const [phone, setPhone] = useState(initialPhone);
  const [error, setError] = useState<string | undefined>();
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = phone.trim();
    if (!trimmed) {
      setError("Required");
      return;
    }
    if (!isValidPhone(trimmed)) {
      setError("Enter a valid phone number");
      return;
    }
    setError(undefined);
    const fd = new FormData();
    fd.append("phone", trimmed);
    startTransition(async () => {
      const res = await savePhoneAction(null, fd);
      if (res.ok) {
        setSaved(true);
      } else {
        setError(res.error ?? "Something went wrong — please try again.");
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="mt-6 space-y-3" noValidate>
      <div>
        <Label htmlFor="phone" required>
          Phone number{" "}
          <span aria-hidden className="text-phosphor-ink">
            *
          </span>
        </Label>
        <Input
          id="phone"
          name="phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          error={error}
          value={phone}
          onChange={(e) => {
            setPhone(e.target.value);
            setSaved(false);
            if (error) setError(undefined);
          }}
          placeholder="+1 (555) 123-4567"
          required
          aria-required
        />
        <FieldError id="phone-error">{error}</FieldError>
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? (
            <span className="inline-flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              Saving…
            </span>
          ) : saved ? (
            "Update number"
          ) : (
            "Save phone number"
          )}
        </Button>
        {saved && !pending && (
          <span className="inline-flex items-center gap-1.5 text-sm font-medium text-phosphor-ink">
            <Check className="h-4 w-4" />
            Saved — thank you!
          </span>
        )}
      </div>
    </form>
  );
}
