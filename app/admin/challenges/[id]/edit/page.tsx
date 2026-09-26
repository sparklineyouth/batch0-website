import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/auth";
import { getChallengeById } from "@/lib/challenges";
import { ChallengeEditor } from "../../challenge-editor";
import { challengeToInitial } from "../../challenge-initial";

export const metadata = { title: "Edit challenge · Admin" };
export const dynamic = "force-dynamic";

export default async function EditChallengePage(props: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await props.params;
  await requirePermission("challenges.manage");
  const challenge = await getChallengeById(id);
  if (!challenge) notFound();
  // Deliberately not keyed on updatedAt: remounting after a save would throw
  // away anything typed while the save was in flight.
  return <ChallengeEditor initial={challengeToInitial(challenge)} />;
}
