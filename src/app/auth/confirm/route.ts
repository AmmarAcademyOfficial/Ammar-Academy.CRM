import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { supabaseForRequest } from "@/lib/supabase/server";

/**
 * Landing point for links in invitation and password-reset emails.
 * Verifies the one-time token, which signs the person in, then continues.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const tokenHash = params.get("token_hash");
  const type = params.get("type") as EmailOtpType | null;
  const next = params.get("next")?.startsWith("/") ? params.get("next")! : "/";
  const url = request.nextUrl.clone();
  url.search = "";

  if (tokenHash && type) {
    const supabase = await supabaseForRequest();
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) {
      url.pathname = next;
      return NextResponse.redirect(url);
    }
  }
  url.pathname = "/login";
  url.searchParams.set("reason", "link");
  return NextResponse.redirect(url);
}
