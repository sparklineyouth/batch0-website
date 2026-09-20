"use client";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { updateFollowup } from "./actions";

export function RecoveryControls({applicationId,paused,note,canPay}:{applicationId:string;paused:boolean;note:string;canPay:boolean}) {
  const [isPaused,setPaused]=useState(paused);
  const [memo,setMemo]=useState(note);
  const [message,setMessage]=useState("");
  const [payerUrl,setPayerUrl]=useState("");
  const [busy,start]=useTransition();
  function save(contacted=false) {
    start(async()=>{try {await updateFollowup({applicationId,paused:isPaused,note:memo,contacted});setMessage(contacted?"Contact recorded. No message was sent.":"Saved.");}catch(err){setMessage(err instanceof Error?err.message:"Could not save.");}});
  }
  function payerLink() {
    start(async()=>{try {
      const res=await fetch("/api/stripe/payer-link",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({applicationId})});
      const body=await res.json();
      if(!res.ok)throw new Error(body.error||"Could not create payment link.");
      setPayerUrl(body.url);setMessage("Private payment link ready. Share directly with this family only.");
    }catch(err){setMessage(err instanceof Error?err.message:"Could not create payment link.");}});
  }
  return <div className="mt-4 space-y-3 border-t border-line pt-4">
    <label className="block text-xs text-ink-muted">Conversation notes (private to staff)
      <textarea className="mt-1 w-full rounded-md border border-line bg-paper p-2 text-sm text-ink" rows={2} maxLength={2000} value={memo} onChange={e=>setMemo(e.target.value)} placeholder="Main question, next step, and agreed follow-up date" />
    </label>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={isPaused} onChange={e=>setPaused(e.target.checked)} /> Pause payment follow-ups for this application</label>
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="secondary" disabled={busy} onClick={()=>save()}>Save notes</Button>
      <Button size="sm" variant="secondary" disabled={busy} onClick={()=>save(true)}>Mark contacted</Button>
      {canPay&&<Button size="sm" disabled={busy} onClick={payerLink}>Create parent payment link</Button>}
    </div>
    {payerUrl&&<div className="space-y-2"><label className="block text-xs text-ink-muted">Private payment link<input aria-label="Private payment link" readOnly value={payerUrl} className="mt-1 w-full rounded border border-line bg-paper p-2 text-xs" onFocus={e=>e.target.select()} /></label><Button size="sm" variant="secondary" onClick={async()=>{try{await navigator.clipboard.writeText(payerUrl);setMessage("Copied. No message was sent.");}catch{setMessage("Select the link above and copy it.");}}}>Copy link</Button></div>}
    {message&&<p role="status" className="text-xs text-ink-muted">{message}</p>}
  </div>;
}
