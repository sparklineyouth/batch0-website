import { notFound } from "next/navigation";
import { requireActor } from "@/lib/server-guards";
import { can } from "@/lib/permissions";
import { loadQueuedEmail } from "../actions";
import { QueuedEmailEditor } from "./edit-form";

export const metadata = { title: "Edit queued email · Admin" };
export const dynamic = "force-dynamic";

export default async function QueuedEmailPage({
  params,
}: {
  params: { id: string };
}) {
  const [{ caps }, res] = await Promise.all([
    requireActor(),
    loadQueuedEmail(params.id),
  ]);
  if (!res.ok) notFound();

  // ADMIN_ROUTE_PERMISSIONS matches by boundary-aware prefix, so it can't give
  // the list (`email.view`) and this detail page (`email.send`) different
  // requirements — every path under /admin/email/outbox resolves to the same
  // rule. The check lives here instead. Every mutating action re-checks
  // `email.send` on its own anyway; this only stops a viewer being shown a
  // form whose every button would be refused.
  return (
    <QueuedEmailEditor
      row={res.row}
      canEdit={can(caps, "email.send")}
    />
  );
}
