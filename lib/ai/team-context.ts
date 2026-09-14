/**
 * A saved conversation's team_id is user-editable, so it is a preference,
 * never proof of membership. Pass only memberships freshly read for the
 * authenticated user. An invalid pin must not fall back to another team.
 */
export function resolveAiTeamContext(
  pinnedTeamId: string | null | undefined,
  membershipTeamIds: readonly string[],
): string | null {
  const currentTeams = [...new Set(membershipTeamIds.filter(Boolean))];
  if (pinnedTeamId) return currentTeams.includes(pinnedTeamId) ? pinnedTeamId : null;
  // Several teams without a pin are ambiguous; do not blend their context.
  return currentTeams.length === 1 ? currentTeams[0] : null;
}
