"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Label, Textarea, Select, FieldError } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/dialog";
import {
  removeFromProgram,
  moveToCohort,
  sendPasswordResetForUser,
  deleteUserAccount,
  refundLatestPayment,
} from "./actions";
import { getActionError } from "@/lib/action-error";
import {
  KeyRound,
  ArrowRightLeft,
  UserMinus,
  Undo2,
  Trash2,
} from "lucide-react";

type Action = "remove" | "move" | "reset" | "refund" | "delete" | null;

export function ManagePanel({
  userId,
  isSelf,
  isAdminTarget,
  hasRefundable,
  cohorts,
  currentCohortId,
}: {
  userId: string;
  /** Some actions are disabled when the admin is looking at themselves. */
  isSelf: boolean;
  /** Deleting an admin is blocked server-side; mirror that in the UI. */
  isAdminTarget: boolean;
  /** Whether there's a succeeded payment available to refund. */
  hasRefundable: boolean;
  cohorts: { id: string; name: string }[];
  currentCohortId: string | null;
}) {
  const router = useRouter();
  const [action, setAction] = useState<Action>(null);
  const [reason, setReason] = useState("");
  const [targetCohort, setTargetCohort] = useState(currentCohortId ?? "");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();
  const [okMsg, setOkMsg] = useState<string | undefined>();

  function close() {
    if (pending) return;
    setAction(null);
    setReason("");
    setError(undefined);
  }

  function execute() {
    setError(undefined);
    start(async () => {
      try {
        if (action === "remove") {
          await removeFromProgram(userId, reason);
          setOkMsg("Removed from program.");
        } else if (action === "move") {
          await moveToCohort(userId, targetCohort);
          setOkMsg("Moved to selected cohort.");
        } else if (action === "reset") {
          await sendPasswordResetForUser(userId);
          setOkMsg("Password reset email sent.");
        } else if (action === "refund") {
          await refundLatestPayment(userId, reason);
          setOkMsg("Refund issued.");
        } else if (action === "delete") {
          await deleteUserAccount(userId, reason);
          // After deleting, jump back to the list — the detail page
          // would 404.
          router.replace("/admin/students");
          router.refresh();
          return;
        }
        close();
        router.refresh();
      } catch (e: any) {
        setError(getActionError(e));
      }
    });
  }

  return (
    <>
      <div className="grid gap-2 sm:grid-cols-2">
        <ActionButton
          icon={KeyRound}
          label="Send password reset"
          hint="Emails a reset link."
          onClick={() => {
            setAction("reset");
            setReason("");
          }}
          disabled={isSelf}
        />
        <ActionButton
          icon={ArrowRightLeft}
          label="Move to a different cohort"
          hint="Re-enrolls if paid."
          onClick={() => setAction("move")}
        />
        <ActionButton
          icon={UserMinus}
          tone="warn"
          label="Remove from program"
          hint="Withdraws application + enrollment."
          onClick={() => setAction("remove")}
          disabled={isSelf}
        />
        <ActionButton
          icon={Undo2}
          tone="warn"
          label="Refund latest payment"
          hint={
            hasRefundable
              ? "Refunds via Stripe + resets application to accepted."
              : "No succeeded payment available."
          }
          onClick={() => setAction("refund")}
          disabled={!hasRefundable}
        />
        <ActionButton
          icon={Trash2}
          tone="danger"
          label="Delete account"
          hint={
            isAdminTarget
              ? "Demote from admin first."
              : "Removes auth user + all associated rows."
          }
          onClick={() => setAction("delete")}
          disabled={isSelf || isAdminTarget}
        />
      </div>
      {okMsg && (
        <p className="mt-3 text-xs text-emerald-700 dark:text-emerald-300">{okMsg}</p>
      )}

      <ConfirmDialog
        open={action === "reset"}
        title="Send password reset?"
        description="An email with a one-time reset link will be sent to this user."
        confirmLabel="Send reset email"
        pending={pending}
        onConfirm={execute}
        onCancel={close}
      />

      <ConfirmDialog
        open={action === "move"}
        title="Move to a different cohort"
        description={
          <>
            <Label>Target cohort</Label>
            <Select
              value={targetCohort}
              onChange={(e) => setTargetCohort(e.target.value)}
            >
              <option value="">— Pick a cohort —</option>
              {cohorts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
            <p className="mt-3 text-xs text-ink-soft">
              Their latest application moves to this cohort. If they were
              paid/enrolled, the enrollment is re-created against the new
              cohort.
            </p>
            {error && <FieldError>{error}</FieldError>}
          </>
        }
        confirmLabel="Move"
        pending={pending}
        onConfirm={execute}
        onCancel={close}
      />

      <ConfirmDialog
        open={action === "remove"}
        title="Remove from the program?"
        description={
          <>
            <p>
              Marks their application <span className="text-ink">withdrawn</span>
              {" "}and deletes any enrollment. They'll be emailed.
            </p>
            <div className="mt-3">
              <Label>Reason (optional, shown to the user)</Label>
              <Textarea
                rows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. inactive for 3+ weeks"
              />
            </div>
            {error && <FieldError>{error}</FieldError>}
          </>
        }
        confirmLabel="Remove"
        destructive
        pending={pending}
        onConfirm={execute}
        onCancel={close}
      />

      <ConfirmDialog
        open={action === "refund"}
        title="Refund the latest payment?"
        description={
          <>
            <p>
              Issues a Stripe refund for the most recent succeeded payment,
              marks the row <span className="text-ink">refunded</span>, and
              resets the related application back to{" "}
              <span className="text-ink">accepted</span>.
            </p>
            <div className="mt-3">
              <Label>Internal reason (audit only)</Label>
              <Textarea
                rows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. duplicate charge / cancelled before start"
              />
            </div>
            {error && <FieldError>{error}</FieldError>}
          </>
        }
        confirmLabel="Refund"
        destructive
        pending={pending}
        onConfirm={execute}
        onCancel={close}
      />

      <ConfirmDialog
        open={action === "delete"}
        title="Delete this user permanently?"
        description={
          <>
            <p className="text-amber-700 dark:text-amber-300">
              This deletes the auth user and cascades through every related
              row (applications, enrollments, submissions, files, payments).
              This is irreversible.
            </p>
            <div className="mt-3">
              <Label>Reason (audit only)</Label>
              <Textarea
                rows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. duplicate test account"
              />
            </div>
            {error && <FieldError>{error}</FieldError>}
          </>
        }
        confirmLabel="Delete account"
        destructive
        pending={pending}
        onConfirm={execute}
        onCancel={close}
      />
    </>
  );
}

function ActionButton({
  icon: Icon,
  label,
  hint,
  onClick,
  disabled,
  tone = "neutral",
}: {
  icon: any;
  label: string;
  hint: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: "neutral" | "warn" | "danger";
}) {
  const toneCls =
    tone === "danger"
      ? "border-red-500/30 hover:border-red-500/60 hover:bg-red-500/5 text-red-700 dark:text-red-300"
      : tone === "warn"
        ? "border-amber-500/30 hover:border-amber-500/60 hover:bg-amber-500/5 text-amber-700 dark:text-amber-300"
        : "border-line hover:border-ink/30 hover:bg-wash text-ink";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex items-start gap-3 rounded-xl border bg-wash px-4 py-3 text-left transition disabled:cursor-not-allowed disabled:opacity-40 ${toneCls}`}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-ink-faint">{hint}</div>
      </div>
    </button>
  );
}
