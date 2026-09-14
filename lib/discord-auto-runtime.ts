import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { createDiscordAutoStore } from "./discord-auto-store.ts";
import { DiscordAutoTransport, DiscordTransportError } from "./discord-auto-transport.ts";
import { createDiscordAutoAnswerer } from "./discord-auto-ai.ts";
import { runDiscordAutoQuestions } from "./discord-auto-engine.ts";
import { DISCORD_AUTO_MODEL } from "./discord-auto-policy.ts";

export type AutomaticQuestionSnapshot = {
  available: boolean; enabled: boolean; effectiveEnabled: boolean;
  excludedChannelIds: string[]; dailyBudgetMicrousd: number; lifetimeBudgetMicrousd: number;
  todayMicrousd: number; totalMicrousd: number; lastRunAt: string|null; notice: string;
};

export async function automaticQuestionSnapshot(): Promise<AutomaticQuestionSnapshot> {
  try {
    const s=await createDiscordAutoStore(createAdminClient()).getState();
    return {available:true,enabled:s.enabled,effectiveEnabled:s.effectiveEnabled,
      excludedChannelIds:s.excludedChannelIds,dailyBudgetMicrousd:s.dailyBudgetMicrousd,lifetimeBudgetMicrousd:s.lifetimeBudgetMicrousd,
      todayMicrousd:s.dailySpentMicrousd+s.dailyReservedMicrousd,totalMicrousd:s.lifetimeSpentMicrousd+s.lifetimeReservedMicrousd,
      lastRunAt:s.lastRunFinishedAt,
      notice:s.lastError ? `Last run needs attention: ${s.lastError.replaceAll("_"," ")}. Check the connection before resuming.` : !s.masterEnabled ? "The main Discord switch is paused." : s.lastRunSummary.backlog ? "A busy channel exceeded the scan limit. Recent questions will be checked on the next run." : ""};
  } catch {
    return {available:false,enabled:false,effectiveEnabled:false,excludedChannelIds:[],dailyBudgetMicrousd:250_000,lifetimeBudgetMicrousd:5_000_000,todayMicrousd:0,totalMicrousd:0,lastRunAt:null,notice:"Automatic answer storage is unavailable. Answers stay paused until setup is complete."};
  }
}

export function automaticQuestionTransport(signal?: AbortSignal) {
  if(!env.discordBotToken || !env.discordGuildId || !env.discordClientId) throw new Error("Discord bot credentials are not configured.");
  return new DiscordAutoTransport({token:env.discordBotToken,guildId:env.discordGuildId,signal,timeoutMs:8_000,maxRequests:100});
}

async function checkAutomaticQuestionModel(): Promise<boolean> {
  if(!env.anthropicApiKey) return false;
  const {default:Anthropic}=await import("@anthropic-ai/sdk");
  try {
    const client=new Anthropic({apiKey:env.anthropicApiKey,maxRetries:0,timeout:5_000});
    // Free token-counting request verifies model access without generating an
    // answer, scanning anyone's messages, or reserving/spending the AI budget.
    const count=await client.messages.countTokens({model:DISCORD_AUTO_MODEL,messages:[{role:"user",content:"How can I test an idea?"}]});
    return Number.isSafeInteger(count.input_tokens) && count.input_tokens>0;
  } catch {return false;}
}

/** Read-only provider check. Never returns tokens, source messages or model text. */
export async function automaticQuestionHealth() {
  const transport=automaticQuestionTransport(AbortSignal.timeout(25_000));
  const health=await transport.health();
  if(health.applicationId!==env.discordClientId) throw new Error("The Discord bot and configured application do not match.");
  const discovery=await transport.discoverChannels();
  return {
    applicationId:health.applicationId,
    messageContentEnabled:health.messageContentEnabled,
    readableChannels:discovery.channels.length,
    replyChannels:discovery.channels.filter(c=>c.canReply && !c.archived && !c.locked).length,
    modelConfigured:Boolean(env.anthropicApiKey),
    modelAvailable:await checkAutomaticQuestionModel(),
    cronConfigured:Boolean(env.cronSecret),
    production:process.env.VERCEL_ENV==="production",
    storage:await automaticQuestionSnapshot(),
  };
}

export async function enableAutomaticQuestionPrerequisites() {
  if(!env.anthropicApiKey || !env.cronSecret) throw new Error("The AI key and scheduled-job secret must be configured before enabling answers.");
  if(!(await checkAutomaticQuestionModel())) throw new Error("The configured AI model could not be reached.");
  const transport=automaticQuestionTransport(AbortSignal.timeout(25_000));
  let health=await transport.health();
  if(health.applicationId!==env.discordClientId) throw new Error("The Discord bot and configured application do not match.");
  if(!health.messageContentEnabled) health=await transport.enableLimitedMessageContent(health.applicationFlags);
  if(!health.messageContentEnabled) throw new Error("Enable Message Content Intent in the Discord Developer Portal before starting automatic answers.");
  const discovery=await transport.discoverChannels();
  if(!discovery.channels.some(c=>c.canReply && !c.archived && !c.locked)) throw new Error("The bot needs permission to read message history and reply in at least one channel.");
}

export async function runAutomaticQuestionCron() {
  // Preview shares some integration credentials. It must never consume the
  // production cursor/budget or reply to real members, even when called manually.
  if(process.env.VERCEL_ENV!=="production") return {status:"preview_paused"};
  if(!env.anthropicApiKey || !env.discordBotToken || !env.discordGuildId || !env.discordClientId) {
    // Cleanup of expiring cached answers remains possible if a provider key is
    // removed while paused. This never constructs a model or Discord client.
    const store=createDiscordAutoStore(createAdminClient());
    const lease=await store.acquireRun();
    if(lease) await store.releaseRun(lease,{error:"provider_not_configured"});
    return {status:"provider_not_configured",errors:1};
  }
  const signal=AbortSignal.timeout(140_000);
  return runDiscordAutoQuestions({store:createDiscordAutoStore(createAdminClient()),
    transport:automaticQuestionTransport(signal),guildId:env.discordGuildId!,applicationId:env.discordClientId!,
    generate:createDiscordAutoAnswerer(env.anthropicApiKey),signal});
}

export function automaticQuestionError(error: unknown): string {
  if(error instanceof DiscordTransportError) {
    if(error.kind==="forbidden" || error.kind==="unsupported") return "Discord did not permit this change. Check Message Content Intent and the bot’s channel permissions in Discord.";
    if(error.kind==="unauthorized") return "Discord rejected the configured bot credentials.";
    if(error.kind==="rate_limit") return "Discord is rate limiting requests. Wait before checking again.";
    return `Discord connection check failed (${error.kind.replaceAll("_"," ")}).`;
  }
  return "Automatic answers could not be configured. Check the bot, AI, scheduled-job and database setup.";
}
