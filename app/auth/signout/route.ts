import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const supabase = createClient();
  await supabase.auth.signOut();
  const url = new URL(request.url);
  return NextResponse.redirect(`${url.origin}/`, { status: 303 });
}
