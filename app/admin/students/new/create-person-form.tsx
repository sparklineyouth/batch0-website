"use client";
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input, Select, Label, FieldError } from "@/components/ui/input";
import { UserPlus, CheckCircle2 } from "lucide-react";
import { createPerson, type CreatedPerson } from "./actions";
import { getActionError } from "@/lib/action-error";

type Cohort = { id: string; name: string; status: string };

export function CreatePersonForm({ cohorts }: { cohorts: Cohort[] }) {
  const router = useRouter();
  const nameRef = useRef<HTMLInputElement>(null);
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [grade, setGrade] = useState("");
  // Sticky across submits: adding a whole cohort's worth of people one after
  // another shouldn't mean re-picking the cohort every time.
  const [cohortId, setCohortId] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();
  const [added, setAdded] = useState<CreatedPerson[]>([]);

  function submit() {
    setError(undefined);
    if (!fullName.trim()) {
      setError("Name is required.");
      nameRef.current?.focus();
      return;
    }
    start(async () => {
      try {
        const res = await createPerson({
          full_name: fullName,
          email,
          grade,
          cohort_id: cohortId,
        });
        if (!res.ok) {
          setError(res.error);
          return;
        }
        // Prepend so the newest addition is on top, then clear the identity
        // fields (but keep the cohort) and drop focus back on the name.
        if (res.data) setAdded((prev) => [res.data!, ...prev]);
        setFullName("");
        setEmail("");
        setGrade("");
        nameRef.current?.focus();
        router.refresh();
      } catch (e) {
        setError(getActionError(e));
      }
    });
  }

  return (
    <div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="grid gap-4"
      >
        <div>
          <Label htmlFor="full_name" required>
            Name *
          </Label>
          <Input
            ref={nameRef}
            id="full_name"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder="Ada Lovelace"
            autoComplete="off"
            required
            disabled={pending}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="email">Email (optional)</Label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="ada@example.com"
              autoComplete="off"
              disabled={pending}
            />
            <p className="mt-1 text-xs text-ink-faint">
              Leave blank if you don&apos;t have it — you can add it later.
            </p>
          </div>
          <div>
            <Label htmlFor="grade">Grade</Label>
            <Input
              id="grade"
              value={grade}
              onChange={(e) => setGrade(e.target.value)}
              placeholder="e.g. 10th"
              autoComplete="off"
              disabled={pending}
            />
          </div>
        </div>

        <div>
          <Label htmlFor="cohort_id">Enroll into cohort (optional)</Label>
          <Select
            id="cohort_id"
            value={cohortId}
            onChange={(e) => setCohortId(e.target.value)}
            disabled={pending}
          >
            <option value="">— Don&apos;t enroll yet —</option>
            {cohorts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.status !== "active" ? ` (${c.status})` : ""}
              </option>
            ))}
          </Select>
        </div>

        {error && <FieldError>{error}</FieldError>}

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={pending}>
            <UserPlus className="h-4 w-4" />
            {pending ? "Enrolling…" : "Enroll them"}
          </Button>
        </div>
      </form>

      {added.length > 0 && (
        <div className="mt-6 border-t border-line pt-4">
          <p className="mb-2 text-xs font-mono font-semibold uppercase tracking-wider text-ink-faint">
            Added this session · {added.length}
          </p>
          <ul className="space-y-1.5">
            {added.map((p) => (
              <li
                key={p.id}
                className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg border border-line bg-wash px-3 py-2 text-sm"
              >
                <CheckCircle2 className="h-4 w-4 shrink-0 text-phosphor-ink" />
                <span className="font-medium text-ink">{p.full_name}</span>
                <span className="text-ink-faint">
                  {p.email ?? "no email"}
                  {p.grade ? ` · grade ${p.grade}` : ""}
                  {p.cohort_name ? ` · enrolled in ${p.cohort_name}` : ""}
                </span>
                <Link
                  href={`/admin/students/${p.id}`}
                  className="ml-auto text-xs text-phosphor-ink hover:underline"
                >
                  Manage →
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
