import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getStaff } from "@/server/auth";
import { encryptSecret } from "@/server/crypto";
import { asSystem } from "@/server/db";
import { appUrl, forgetAccessToken, google, GoogleAuthError, redirectUri } from "@/server/google";

const STATE_COOKIE = "crm_google_state";

function back(result: string) {
  const res = NextResponse.redirect(`${appUrl()}/settings/sheets?google=${result}`);
  res.cookies.set(STATE_COOKIE, "", { path: "/api/google", maxAge: 0 });
  return res;
}

/** Google sends the manager back here after they click Allow (or Cancel). */
export async function GET(req: NextRequest) {
  const staff = await getStaff();
  if (!staff || staff.role !== "manager") return back("forbidden");
  const p = req.nextUrl.searchParams;
  if (p.get("error")) return back("cancelled");
  const state = p.get("state") ?? "";
  const expected = req.cookies.get(STATE_COOKIE)?.value ?? "";
  if (!state || state.length !== expected.length || !timingSafeEqual(Buffer.from(state), Buffer.from(expected))) return back("expired");
  try {
    const grant = await google().exchangeCode(p.get("code") ?? "", redirectUri());
    const [{ id }] = await asSystem((tx) => tx<{ id: string }[]>`
      select private.save_google_account(${grant.email}, ${encryptSecret(grant.refreshToken)}, ${grant.scopes}, ${staff.id}) as id`);
    forgetAccessToken(id);
    return back("connected");
  } catch (e) {
    console.error("[google] sign-in failed", (e as Error).message);
    return back(e instanceof GoogleAuthError ? "refused" : "failed");
  }
}
