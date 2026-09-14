"use client";

import { useState, useTransition } from "react";
import { saveAutomaticQuestions, checkAutomaticQuestionConnection } from "./auto-questions-actions";
import type { AutomaticQuestionSnapshot } from "@/lib/discord-auto-runtime";

export function AutoQuestionsPanel({ initial }: { initial: AutomaticQuestionSnapshot }) {
  const [snapshot,setSnapshot] = useState(initial);
  const [excluded,setExcluded] = useState(initial.excludedChannelIds.join("\n"));
  const [daily,setDaily] = useState(String(initial.dailyBudgetMicrousd / 1_000_000));
  const [total,setTotal] = useState(String(initial.lifetimeBudgetMicrousd / 1_000_000));
  const [message,setMessage] = useState("");
  const [pending,startTransition] = useTransition();
  function save(enabled: boolean) {
    setMessage("");
    startTransition(async () => {
      try {
        const result=await saveAutomaticQuestions({enabled,excludedChannelIds:excluded.split(/[\s,]+/).filter(Boolean),dailyBudgetDollars:Number(daily),lifetimeBudgetDollars:Number(total)});
        setSnapshot(result);
        setMessage(enabled ? "Automatic answers enabled. Only new questions will be considered." : "Automatic answers paused.");
      } catch(error) { setMessage(error instanceof Error ? error.message : "Could not save automatic answers."); }
    });
  }
  return <section className="mt-6 rounded-xl border border-line bg-paper p-5" aria-labelledby="automatic-questions-title">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 id="automatic-questions-title" className="text-lg font-semibold text-ink">Automatic question answers</h2>
      <span className="text-sm text-ink-soft">{snapshot.effectiveEnabled ? "On" : "Paused"}</span>
    </div>
    <p className="mt-2 text-sm text-ink-soft">Batch0 AI checks new questions about once a minute and replies in the same channel without an @mention. It works in channels and active threads the bot can already read and reply to. Ordinary conversation is skipped.</p>
    <p className="mt-2 text-xs text-ink-soft">Answers use the question, brief context from that channel, and public program links. No private student records or other channels are searched. Personal account and payment issues go to staff.</p>
    {!snapshot.available && <p className="mt-3 text-sm text-amber-800 dark:text-amber-300">{snapshot.notice}</p>}
    {snapshot.available && <div className="mt-4 grid gap-4 sm:grid-cols-2">
      <label className="text-sm text-ink">Daily AI limit (USD)
        <input type="number" min="0.01" max="1" step="0.01" value={daily} onChange={e=>setDaily(e.target.value)} className="mt-1 block w-full rounded-lg border border-line bg-paper px-3 py-2" />
      </label>
      <label className="text-sm text-ink">Total AI limit (USD)
        <input type="number" min="0.01" max="5" step="0.01" value={total} onChange={e=>setTotal(e.target.value)} className="mt-1 block w-full rounded-lg border border-line bg-paper px-3 py-2" />
      </label>
      <label className="text-sm text-ink sm:col-span-2">Excluded channel or category IDs
        <textarea rows={3} value={excluded} onChange={e=>setExcluded(e.target.value)} placeholder="Optional: one Discord ID per line" className="mt-1 block w-full rounded-lg border border-line bg-paper px-3 py-2" />
        <span className="mt-1 block text-xs text-ink-soft">An excluded channel also excludes its threads; an excluded category excludes its channels. Leaving this empty covers every channel the bot can access.</span>
      </label>
    </div>}
    <p className="mt-3 text-xs text-ink-soft">AI usage including pending reservations: ${ (snapshot.todayMicrousd/1_000_000).toFixed(4) } today · ${ (snapshot.totalMicrousd/1_000_000).toFixed(4) } total. This is the operator’s AI budget; students are not billed. Pausing or re-enabling does not reset spend.</p>
    <p className="mt-2 text-xs text-ink-soft">At most 100 model calls a day and one per person/channel per minute. Questions older than ten minutes are skipped. Existing slash commands and buttons remain available.</p>
    <p className="mt-2 text-xs text-ink-soft">Last run: {snapshot.lastRunAt ? new Date(snapshot.lastRunAt).toLocaleString() : "Not yet run"}. {snapshot.notice}</p>
    <div className="mt-4 flex flex-wrap gap-2">
      <button disabled={pending || !snapshot.available} onClick={()=>save(!snapshot.enabled)} className="rounded-lg bg-ink px-4 py-2 text-sm font-medium text-paper disabled:opacity-50">{pending ? "Working…" : snapshot.enabled ? "Pause automatic answers" : "Enable automatic answers"}</button>
      <button disabled={pending || !snapshot.available} onClick={()=>save(snapshot.enabled)} className="rounded-lg border border-line px-4 py-2 text-sm disabled:opacity-50">Save limits and exclusions</button>
      <button disabled={pending} onClick={()=>{ setMessage(""); startTransition(async()=>{try{setMessage(await checkAutomaticQuestionConnection());}catch(error){setMessage(error instanceof Error?error.message:"Connection check failed.");}}); }} className="rounded-lg border border-line px-4 py-2 text-sm disabled:opacity-50">Check connection</button>
    </div>
    {message && <p role="status" aria-live="polite" className="mt-3 text-sm text-ink">{message}</p>}
  </section>;
}
