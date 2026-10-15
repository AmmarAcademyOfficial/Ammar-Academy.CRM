import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { getStaff } from "@/server/auth";
import { appUrl, google, googleEnabled, redirectUri } from "@/server/google";

const GOOGLE_STATE_COOKIE = "crm_google_state";

/** Starts "Connect Google Sheet": sends the manager to Google's sign-in screen. */
export async function GET() {
  const staff = await getStaff();
  if (!staff) return NextResponse.redirect(`${appUrl()}/login?next=/settings/sheets`);
  if (staff.role !== "manager") return NextResponse.redirect(`${appUrl()}/`);
  if (!googleEnabled()) return NextResponse.redirect(`${appUrl()}/settings/sheets?google=not_configured`);
  // A one-time value tied to this browser, checked on return, so nobody can plant their own Google account.
  const state = randomBytes(24).toString("base64url");
  const res = NextResponse.redirect(google().authUrl(state, redirectUri()));
  res.cookies.set(GOOGLE_STATE_COOKIE, state, { httpOnly: true, sameSite: "lax", secure: appUrl().startsWith("https://"), path: "/api/google", maxAge: 600 });
  return res;
}
