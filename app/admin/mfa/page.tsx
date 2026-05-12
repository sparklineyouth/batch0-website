import { requireAdmin } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { MfaManager } from "./mfa-manager";

export const metadata = { title: "Two-factor auth · Admin" };

export default async function AdminMfaPage() {
  await requireAdmin();
  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-3xl font-bold tracking-tight">Two-factor auth</h1>
      <p className="mt-1 text-sm text-white/55">
        Admins should enroll a TOTP app (Authy, 1Password, Google Authenticator).
        Once enrolled, sensitive actions (waiving charges, role changes, CSV
        exports) require a recent verification — protecting the account if a
        session token is ever stolen.
      </p>
      <Card className="mt-6">
        <MfaManager />
      </Card>
    </div>
  );
}
