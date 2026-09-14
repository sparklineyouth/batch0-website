import { createHash } from "node:crypto";
import type { DiscordAutoStore, DiscordAutoJob, DiscordAutoState } from "./discord-auto-store.ts";
import { DiscordTransportError } from "./discord-auto-transport.ts";
import type { DiscordAutoTransport, DiscordMessage, DiscordReadableChannel } from "./discord-auto-transport.ts";
import type { AutoGeneration } from "./discord-auto-ai.ts";
import { compareSnowflakes, isQuestionCandidate, snowflakeAt, DISCORD_AUTO_MAX_AGE_MS } from "./discord-auto-policy.ts";

type Transport = Pick<DiscordAutoTransport,"health"|"discoverChannels"|"fetchAfter"|"fetchMessages"|"fetchMessage"|"replyToMessage">;
export type AutoRunReport = {
  status: string; channels: number; inspected: number; generated: number;
  sent: number; reconciled: number; skipped: number; backlog: number; errors: number;
};

export function discordSourceHash(message: DiscordMessage): string {
  return createHash("sha256").update(JSON.stringify([message.channelId,message.authorId,message.type,message.content])).digest("hex");
}

export function isExcludedDiscordChannel(id: string, excluded: string[], channels: DiscordReadableChannel[]): boolean {
  const byId = new Map(channels.map(channel=>[channel.id,channel]));
  const seen = new Set<string>();
  let next: string | null = id;
  while(next && !seen.has(next)) {
    if(excluded.includes(next)) return true;
    const category=byId.get(next)?.categoryId;
    if(category && excluded.includes(category)) return true;
    seen.add(next); next=byId.get(next)?.parentId ?? null;
  }
  return false;
}

function candidate(message: DiscordMessage, state: DiscordAutoState, guildId: string, botId: string, now: number) {
  if(!state.activationAt) return false;
  return isQuestionCandidate({id:message.id,channel_id:message.channelId,content:message.content,
    timestamp:message.createdAt,type:message.type,author:{id:message.authorId,bot:message.authorBot},
    webhook_id:message.webhookId ?? undefined},
    {guildId,botUserId:botId,channelId:message.channelId,activatedAt:state.activationAt,now});
}

/** Bounded, awaited work. No background promises survive this invocation. */
export async function runDiscordAutoQuestions(args: {
  store: DiscordAutoStore; transport: Transport; guildId: string; applicationId: string;
  generate: (question: string, context: string[], signal?: AbortSignal)=>Promise<AutoGeneration>;
  signal?: AbortSignal; now?: ()=>number; durationMs?: number;
}): Promise<AutoRunReport> {
  const now=args.now ?? Date.now;
  const deadline=now() + Math.min(args.durationMs ?? 135_000,135_000);
  const report: AutoRunReport={status:"ready",channels:0,inspected:0,generated:0,sent:0,reconciled:0,skipped:0,backlog:0,errors:0};
  const acquiredLease=await args.store.acquireRun();
  if(!acquiredLease) return {...report,status:"busy_or_backoff"};
  const lease=acquiredLease;
  let errorCode: string | undefined;
  let retryAfterMs: number | undefined;
  const exhausted=()=>args.signal?.aborted || now()>=deadline-10_000;
  try {
    const state=await args.store.getState();
    if(!state.effectiveEnabled || !state.activationAt || !state.activationSnowflake) { report.status="paused"; return report; }
    const health=await args.transport.health();
    if(health.applicationId !== args.applicationId || health.botId !== health.applicationId) throw new DiscordTransportError("configuration","Discord application mismatch");
    if(!health.messageContentEnabled) {report.status="message_content_required";errorCode=report.status;report.errors++;return report;}
    const discovery=await args.transport.discoverChannels();
    const eligible=(channel: DiscordReadableChannel, current: DiscordAutoState)=>channel.canReply && !channel.archived && !channel.locked && !isExcludedDiscordChannel(channel.id,current.excludedChannelIds,discovery.channels);
    const channels=discovery.channels.filter(channel=>eligible(channel,state));
    const byId=new Map(channels.map(channel=>[channel.id,channel]));
    const cursors=new Map((await args.store.getCursors(lease)).map(cursor=>[cursor.channelId,cursor]));

    async function deliver(job: DiscordAutoJob): Promise<void> {
      const current=await args.store.getState();
      const channel=byId.get(job.channel_id);
      if(!current.effectiveEnabled || !channel || !eligible(channel,current)) return;
      // A cached answer must never outlive a deleted, edited, or stale question.
      let source: DiscordMessage;
      try { source=await args.transport.fetchMessage(job.channel_id,job.message_id); }
      catch(error) {
        if(error instanceof DiscordTransportError && ["not_found","forbidden"].includes(error.kind)) {
          await args.store.skipJob(lease,job.message_id,"source_unavailable"); report.skipped++; return;
        }
        throw error;
      }
      if(!candidate(source,current,args.guildId,health.botId,now()) || discordSourceHash(source)!==job.source_hash) {
        await args.store.skipJob(lease,job.message_id,"source_changed_or_stale"); report.skipped++; return;
      }
      // The transaction checks fresh switches + fencing immediately before POST.
      const sending=await args.store.beginSend(lease,job.message_id);
      if(sending.outcome!=="sending" || !sending.job.answer) return;
      let reply: {id: string; channelId: string};
      try {
        reply=await args.transport.replyToMessage({channelId:job.channel_id,messageId:job.message_id,content:sending.job.answer});
      } catch(error) {
        if(error instanceof DiscordTransportError && (error.kind==="rate_limit" || error.kind==="budget")) {
          // These errors prove no POST was accepted. Keep the paid answer for
          // a later fenced attempt; a stale worker cannot authorize the retry.
          await args.store.rejectSend(lease,job.message_id,error.kind==="budget" ? "request_budget" : "rate_limit");
          throw error;
        }
        // A lost response could mean Discord accepted it. Never POST it again.
        // The next run may only reconcile a provable existing bot reply.
        await args.store.markUncertain(lease,job.message_id,"delivery_uncertain");
        throw error;
      }
      try {
        await args.store.markSent(lease,job.message_id,reply.id); report.sent++;
      } catch(error) {
        // Discord already returned a reply. Even a misleading error type from
        // the ledger must never restore the job to a state that can POST again.
        await args.store.markUncertain(lease,job.message_id,"delivery_uncertain");
        throw error;
      }
    }

    // Recover saved generations without paying twice. Ambiguous deliveries are
    // read-only reconciliation, never resends (Discord nonce expires quickly).
    for(const job of (await args.store.listPending(lease)).slice(0,20)) {
      if(exhausted()) break;
      const channel=byId.get(job.channel_id);
      if(!channel) continue;
      if(job.status==="generated") { await deliver(job); continue; }
      if(!job.send_started_at || now()-Date.parse(job.send_started_at)>DISCORD_AUTO_MAX_AGE_MS) continue;
      const recent=await args.transport.fetchMessages(job.channel_id,{limit:100});
      const existing=recent.messages.find(message=>message.authorId===health.botId && message.authorBot && !message.webhookId && message.referencedMessageId===job.message_id);
      if(existing) {await args.store.reconcileSent(lease,job.message_id,existing.id);report.reconciled++;}
    }

    // Least recently polled first: large guilds rotate instead of starving the
    // channels near the end of Discord's list. Categories inherit exclusions.
    channels.sort((a,b)=>Date.parse(cursors.get(a.id)?.lastPolledAt ?? "1970-01-01")-Date.parse(cursors.get(b.id)?.lastPolledAt ?? "1970-01-01") || compareSnowflakes(a.id,b.id));
    for(const channel of channels.slice(0,30)) {
      if(exhausted()) {report.status="time_budget";break;}
      const floor=snowflakeAt(Math.max(Date.parse(state.activationAt),now()-DISCORD_AUTO_MAX_AGE_MS));
      const previous=cursors.get(channel.id)?.lastMessageId ?? state.activationSnowflake;
      const after=compareSnowflakes(previous,floor)>0 ? previous : floor;
      let processed=after;
      try {
        const batch=await args.transport.fetchAfter(channel.id,after,{limit:100,maxPages:5});
        report.channels++;
        if(!batch.complete) {
          // Never jump over an incomplete page gap. Surface backlog, rotate,
          // and retry as older messages age out of the ten-minute window.
          report.backlog++;
          await args.store.advanceCursor(lease,channel.id,previous); continue;
        }
        for(let index=0;index<batch.messages.length;index++) {
          const message=batch.messages[index];
          if(exhausted()) break;
          report.inspected++;
          if(!candidate(message,state,args.guildId,health.botId,now())) {processed=message.id;continue;}
          // A human's explicit reply has already taken this question. Do not
          // compete with it or use another channel to construct a response.
          if(batch.messages.some(later=>compareSnowflakes(later.id,message.id)>0 && later.referencedMessageId===message.id && !later.authorBot && !later.webhookId)) {
            report.skipped++;processed=message.id;continue;
          }
          if(report.generated>=3 || now()>deadline-45_000) {report.status="work_budget";break;}
          // Re-read category/parent exclusions before spending or sharing text
          // with the model. The claim also checks switches/exact channel in SQL.
          const current=await args.store.getState();
          if(!current.effectiveEnabled || !eligible(channel,current) || !candidate(message,current,args.guildId,health.botId,now())) {
            report.skipped++;processed=message.id;continue;
          }
          const claim=await args.store.claimJob(lease,{messageId:message.id,channelId:channel.id,userId:message.authorId,sourceHash:discordSourceHash(message)});
          if(claim.outcome!=="claimed") {report.skipped++;processed=message.id;continue;}
          const context=batch.messages.slice(Math.max(0,index-3),index)
            .filter(item=>item.channelId===channel.id && (!item.authorBot || item.authorId===health.botId) && !item.webhookId)
            .map(item=>`${item.authorId===health.botId ? "Batch0 AI" : "Channel member"}: ${item.content}`);
          let generated: DiscordAutoJob;
          try {
            const result=await args.generate(message.content,context,args.signal);
            report.generated++;
            generated=await args.store.completeGeneration(lease,message.id,result);
          } catch(error) {
            await args.store.markUncertain(lease,message.id,"generation_uncertain");
            throw error;
          }
          if(generated.status==="generated") await deliver(generated);
          else report.skipped++;
          processed=message.id;
        }
        await args.store.advanceCursor(lease,channel.id,processed);
      } catch(error) {
        if(error instanceof DiscordTransportError && ["forbidden","not_found"].includes(error.kind)) {
          report.skipped++; await args.store.advanceCursor(lease,channel.id,processed); continue;
        }
        throw error;
      }
    }
    if(report.status==="ready") report.status=report.backlog ? "backlog" : "complete";
    return report;
  } catch(error) {
    report.errors++;
    errorCode=error instanceof DiscordTransportError ? `discord_${error.kind}` : "state_or_model_failure";
    if(error instanceof DiscordTransportError && error.retryAfterMs) retryAfterMs=Math.min(Math.ceil(error.retryAfterMs),86_400_000);
    report.status=errorCode;
    return report;
  } finally {
    // A failed release remains fenced until its 240s expiry. Never hide it.
    await args.store.releaseRun(lease,{error:errorCode,summary:{...report},retryAfterMs});
  }
}
