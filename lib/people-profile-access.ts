/**
 * What a viewer may see and do on a person's profile (/admin/students/[id]).
 * Pure, and the one place both sides read: the page renders a section or a
 * control only when this says so, and the server actions behind the controls
 * assert the very keys listed here. So a button is never shown to someone the
 * action would refuse, and the two can't drift.
 *
 * The profile opens on people.view, which is directory access, not finance
 * access. It used to fetch and render the payment ledger (amounts, statuses,
 * Stripe payment-intent ids) and fees & fines for anyone who could open it,
 * through the service-role client, although /admin/payments refuses a
 * people.view-only role. Finance now follows the Finance permissions:
 *   - the payment ledger: payments.view, what /admin/payments needs;
 *   - fees & fines: charges.manage or payments.view, the rule the app-host
 *     profile (app/app/admin/people/[id]) already used;
 * and the data isn't fetched at all for a viewer who may not see it.
 */
import { can, canAny, type Capabilities, type Permission } from "./permissions.ts";

/**
 * The permission each Manage control's server action asserts
 * (app/admin/students/[id]/actions.ts). Delete is not here: it's full-admin
 * only (assertAdmin), by design not delegable.
 */
export const PROFILE_ACTION_PERMISSIONS = {
  passwordReset: "people.manage",
  moveCohort: "people.manage",
  removeFromProgram: "people.manage",
  refund: "payments.manage",
} as const satisfies Record<string, Permission>;

export type ProfileAction = keyof typeof PROFILE_ACTION_PERMISSIONS | "deleteAccount";

export type ProfileAccess = {
  /** The payment ledger: amounts, statuses, Stripe ids. */
  payments: boolean;
  /** Fees & fines, and the pending-charges count. */
  charges: boolean;
  /** "Issue a charge →" (/admin/charges). */
  issueCharge: boolean;
  /** Whether payment rows are read at all: to show them, or to know if a refund is possible. */
  readPayments: boolean;
  /** Which Manage controls render. */
  actions: Record<ProfileAction, boolean>;
};

export function profileAccess(caps: Capabilities | null): ProfileAccess {
  const payments = can(caps, "payments.view");
  const refund = can(caps, PROFILE_ACTION_PERMISSIONS.refund);
  return {
    payments,
    charges: canAny(caps, ["charges.manage", "payments.view"]),
    issueCharge: can(caps, "charges.manage"),
    readPayments: payments || refund,
    actions: {
      passwordReset: can(caps, PROFILE_ACTION_PERMISSIONS.passwordReset),
      moveCohort: can(caps, PROFILE_ACTION_PERMISSIONS.moveCohort),
      removeFromProgram: can(caps, PROFILE_ACTION_PERMISSIONS.removeFromProgram),
      refund,
      deleteAccount: !!caps?.superAdmin,
    },
  };
}

/** True when the Manage card has anything to offer this viewer. */
export function hasAnyProfileAction(access: ProfileAccess): boolean {
  return Object.values(access.actions).some(Boolean);
}
