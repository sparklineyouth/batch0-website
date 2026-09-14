/** Scope commands to the configured server while retaining onboarding DMs. */
export function allowedDiscordInteraction(
  type: number,
  guildId: unknown,
  configuredGuildId: string | undefined,
): boolean {
  // Signature verification happens before this policy in the route.
  if (type === 1) return true;
  if (!configuredGuildId) return false;
  if (guildId != null) return guildId === configuredGuildId;
  // Existing onboarding DMs contain buttons and can open a modal. Slash and
  // context-menu commands must come from the official guild.
  return type === 3 || type === 5;
}
