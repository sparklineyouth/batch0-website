"use server";
import { assertPermission } from "@/lib/server-guards";
import { createAdminClient } from "@/lib/supabase/admin";
import { logAudit } from "@/lib/audit";
import { revalidatePath } from "next/cache";
import { z } from "zod";

export async function updateFollowup(input: unknown) {
  await assertPermission("applications.review");
  const values = z.object({applicationId:z.string().uuid(),paused:z.boolean(),note:z.string().trim().max(2000),contacted:z.boolean()}).parse(input);
  const patch = {followup_paused:values.paused};
  const {data,error} = await createAdminClient().from("applications").update(patch).eq("id",values.applicationId).select("id").single();
  if (error || !data) throw new Error("Could not save follow-up. Refresh and try again.");
  const {error:notesError} = await createAdminClient().from("recovery_followups").upsert({application_id:values.applicationId,note:values.note,updated_at:new Date().toISOString(),...(values.contacted?{contacted_at:new Date().toISOString()}:{})},{onConflict:"application_id"});
  if(notesError) throw new Error("Pause saved, but conversation notes could not be saved. Try saving again.");
  await logAudit({action:"application.followup_updated",targetType:"application",targetId:values.applicationId,payload:{paused:values.paused,contacted:values.contacted}});
  revalidatePath("/admin/recovery");
}
