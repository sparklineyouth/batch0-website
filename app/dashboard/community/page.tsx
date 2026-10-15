import { redirect } from "next/navigation";

/**
 * The old Community page (a link to the Discord server). Discord is gone and
 * the community is batch0 Chat; lessons, kickoff checklists and old bells
 * still link here, so it forwards rather than 404s.
 */
export default function CommunityPage(): never {
  redirect("/chat");
}
