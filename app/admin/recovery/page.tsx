import Link from "next/link";
import { assertPermission } from "@/lib/server-guards";
import { createAdminClient } from "@/lib/supabase/admin";
import { recoveryBlocker } from "@/lib/email-recovery";
import { cohortEligibility } from "@/lib/cohort-eligibility";
import { Card } from "@/components/ui/card";
import { RecoveryControls } from "./controls";

export const dynamic="force-dynamic";
export const metadata={title:"Enrollment recovery · Admin",robots:{index:false,follow:false}};

export default async function RecoveryPage({searchParams}:{searchParams:Promise<{cohort?:string}>}) {
  await assertPermission("applications.review");
  const admin=createAdminClient();
  const params=await searchParams;
  const [appsResult,paymentsResult,enrollmentsResult,cohortsResult]=await Promise.all([
    admin.from("applications").select("id,user_id,cohort_id,status,full_name,parent_email,created_at,followup_paused,followup:recovery_followups(note,contacted_at),profile:profiles!applications_user_id_fkey(email,role)").eq("status","accepted").order("created_at",{ascending:false}).limit(1000),
    admin.from("payments").select("user_id,cohort_id,status,amount_refunded_cents").limit(10000),
    admin.from("enrollments").select("user_id,cohort_id").limit(10000),
    admin.from("cohorts").select("id,name,status,capacity,starts_on,ends_on,applications_close_at,late_entry_until,catch_up_plan").order("starts_on"),
  ]);
  if([appsResult,paymentsResult,enrollmentsResult,cohortsResult].some(r=>r.error))throw new Error("Recovery checks unavailable. Refresh before contacting families.");
  const cohorts=cohortsResult.data??[];
  const payments=paymentsResult.data??[];
  const enrollments=enrollmentsResult.data??[];
  const selected=cohorts.find(c=>c.id===params.cohort)??cohorts.find(c=>cohortEligibility(c).eligible)??cohorts.at(-1);
  const occupied=enrollments.filter(e=>e.cohort_id===selected?.id).length;
  const rows=(appsResult.data??[]).filter(a=>a.cohort_id===selected?.id).map(app=>{
    const profile=Array.isArray(app.profile)?app.profile[0]:app.profile;
    const eligibility=selected?cohortEligibility(selected,new Date(),occupied):null;
    const reason=recoveryBlocker(app,payments,enrollments)??(profile?.role!=="student"?"Staff/test account: review manually":null)??(!eligibility?.eligible?eligibility?.reason??"No open cohort":null);
    const followup=Array.isArray(app.followup)?app.followup[0]:app.followup;
    return {app,profile,reason,followup};
  }).sort((a,b)=>Number(Boolean(a.reason))-Number(Boolean(b.reason)));
  const ready=rows.filter(r=>!r.reason).length;
  return <div className="space-y-6">
    <div><p className="text-xs uppercase tracking-wider text-ink-muted">Admissions</p><h1 className="mt-2 text-3xl font-semibold">Enrollment recovery</h1><p className="mt-2 max-w-3xl text-ink-muted">Start with a personal conversation about fit, schedule, cost, or checkout. This list is a live eligibility check, not a promise that every accepted family wants to join.</p></div>
    <div className="flex flex-wrap gap-2">{cohorts.map(c=><Link key={c.id} href={`/admin/recovery?cohort=${c.id}`} className={`rounded-full border px-4 py-2 text-sm ${c.id===selected?.id?"border-phosphor bg-phosphor/10":"border-line"}`}>{c.name}</Link>)}</div>
    <div className="grid gap-4 sm:grid-cols-3">{[["Ready for review",ready],["Needs review / paused",rows.length-ready],["Enrolled seats",`${occupied} / ${selected?.capacity??"—"}`]].map(([label,value])=><Card key={label} className="p-5"><p className="text-sm text-ink-muted">{label}</p><p className="mt-2 text-3xl font-semibold">{value}</p></Card>)}</div>
    <Card className="space-y-2 p-5 text-sm"><p><strong>Before the call:</strong> read their application, open the <Link href={`/parents?cohort=${selected?.id??""}`} className="underline">parent guide</Link> and <Link href="/sample-lesson" className="underline">sample lesson</Link>, and check the current calendar. Create a private payment link only for the correct student.</p><p>Ask one useful question: “What would you need to know to decide whether this is a good fit?” Record their answer and an agreed next step below. A pause applies to payment follow-ups; transactional receipts still work.</p><p className="text-ink-muted">The old payment reminder campaign is paused. Nothing on this page sends a message. A payment link checks price, deadline and seat availability again at checkout.</p></Card>
    {rows.length===0&&<Card className="p-6">No accepted applications awaiting review in this cohort.</Card>}
    <div className="grid gap-4 lg:grid-cols-2">{rows.map(({app,profile,reason,followup})=><Card key={app.id} className="p-5">
      <div className="flex items-start justify-between gap-3"><div><Link className="font-semibold underline decoration-line underline-offset-4" href={`/admin/applications/${app.id}`}>{app.full_name||"Student"}</Link><p className="mt-1 break-all text-sm text-ink-muted">Student: {profile?.email||"No email"}</p><p className="mt-1 break-all text-sm text-ink-muted">Parent: {app.parent_email||"Ask the student for a parent introduction"}</p></div><span className={`rounded-full px-3 py-1 text-xs ${reason?"bg-wash text-ink-muted":"bg-phosphor/15"}`}>{reason?"Review":"Ready"}</span></div>
      <p className="mt-3 text-sm">{reason??"Accepted, unpaid, and eligible for enrollment. Confirm interest before sending a payment link."}</p>
      {followup?.contacted_at&&<p className="mt-2 text-xs text-ink-muted">Last contact recorded: {new Date(followup?.contacted_at).toLocaleDateString("en-US",{timeZone:"America/New_York"})}</p>}
      <RecoveryControls applicationId={app.id} paused={app.followup_paused} note={followup?.note??""} canPay={!reason} />
    </Card>)}</div>
  </div>;
}
