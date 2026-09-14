"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertPermission } from "@/lib/server-guards";
import { createAdminClient } from "@/lib/supabase/admin";
import { logAudit } from "@/lib/audit";
import { runAction } from "@/lib/action-result";
import { createDiscordAutoStore } from "@/lib/discord-auto-store";
import { automaticQuestionSnapshot, automaticQuestionHealth, enableAutomaticQuestionPrerequisites, automaticQuestionError } from "@/lib/discord-auto-runtime";

const inputSchema=z.object({enabled:z.boolean(),excludedChannelIds:z.array(z.string().regex(/^\d{17,20}$/)).max(100),dailyBudgetDollars:z.number().min(0.01).max(1),lifetimeBudgetDollars:z.number().min(0.01).max(5)}).strict();

export async function saveAutomaticQuestions(input: z.infer<typeof inputSchema>) {
  return runAction({name:"discord.auto_questions.configure"},async()=>{
  await assertPermission("discord.manage");
  if(process.env.VERCEL_ENV!=="production") throw new Error("Save automatic-answer settings from the live website. Preview settings cannot start or change the live bot.");
  const parsed=inputSchema.safeParse(input);
  if(!parsed.success) throw new Error("Use valid Discord IDs and limits between $0.01–$1 daily and $0.01–$5 total.");
  const store=createDiscordAutoStore(createAdminClient());
  const before=await store.getState();
  if(parsed.data.enabled) {
    if(!before.masterEnabled) throw new Error("Turn on the main Discord integration first.");
    try {await enableAutomaticQuestionPrerequisites();} catch(error) {throw new Error(automaticQuestionError(error));}
  }
  await store.configure({enabled:parsed.data.enabled,excludedChannelIds:[...new Set(parsed.data.excludedChannelIds)],
    dailyBudgetMicrousd:Math.round(parsed.data.dailyBudgetDollars*1_000_000),lifetimeBudgetMicrousd:Math.round(parsed.data.lifetimeBudgetDollars*1_000_000)});
  await logAudit({action:"discord.auto_questions_configured",payload:{enabled:parsed.data.enabled,excludedChannelCount:parsed.data.excludedChannelIds.length,dailyBudgetDollars:parsed.data.dailyBudgetDollars,lifetimeBudgetDollars:parsed.data.lifetimeBudgetDollars}});
  revalidatePath("/admin/discord");
  return automaticQuestionSnapshot();
  });
}

export async function checkAutomaticQuestionConnection() {
  return runAction({name:"discord.auto_questions.check"},async()=>{
  await assertPermission("discord.manage");
  try {
    const health=await automaticQuestionHealth();
    const checks=[`${health.replyChannels} channels allow replies.`,health.messageContentEnabled ? "Message Content Intent is enabled." : "Message Content Intent is required; enabling automatic answers will request it.",health.modelAvailable ? "AI model access passed the free connection check." : health.modelConfigured ? "AI key is configured, but the model connection check failed." : "AI key is missing.",health.cronConfigured ? "Scheduled-job secret is configured." : "Scheduled-job secret is missing.",health.storage.available ? "Answer storage is ready." : "Answer storage is unavailable.",health.production ? "This is the live site." : "Preview cannot send automatic answers."];
    return checks.join(" ");
  } catch(error) {throw new Error(automaticQuestionError(error));}
  });
}
