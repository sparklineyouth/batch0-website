import { timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import { automaticQuestionHealth, runAutomaticQuestionCron } from "@/lib/discord-auto-runtime";

export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=180;

export async function GET(request: Request) {
  if(!env.cronSecret) return Response.json({error:"Scheduled-job authentication is not configured"},{status:503});
  const actual=Buffer.from(request.headers.get("authorization") ?? "");
  const expected=Buffer.from(`Bearer ${env.cronSecret}`);
  if(actual.length!==expected.length || !timingSafeEqual(actual,expected)) return Response.json({error:"Unauthorized"},{status:401});
  try {
    // Deployment validation can inspect prerequisites without scanning messages,
    // reserving money, changing cursors, or sending anything.
    const report=new URL(request.url).searchParams.get("check")==="1" ? await automaticQuestionHealth() : await runAutomaticQuestionCron();
    return Response.json(report,{headers:{"Cache-Control":"no-store"}});
  } catch {
    console.error("[discord-auto] scheduled run failed; no request/source contents logged");
    return Response.json({error:"Automatic question answering needs attention"},{status:503});
  }
}
