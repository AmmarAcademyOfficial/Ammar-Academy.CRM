import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Runs before each page request:
 *  - keeps the Supabase session cookie fresh, and
 *  - sends signed-out visitors to /login.
 * This is only a convenience redirect. Every page, API route and server action
 * checks the session again on the server, and the database enforces permissions.
 */
const PUBLIC = ["/login", "/forgot-password", "/auth/confirm"];

export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const isPublic = PUBLIC.some((p) => path === p || path.startsWith(p + "/"));

  if (process.env.AUTH_MODE === "local") {
    if (!isPublic && !request.cookies.get("crm_local_session")) return toLogin(request);
    return NextResponse.next();
  }

  let response = NextResponse.next({ request });
  const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (toSet) => {
        toSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        toSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });
  const { data } = await supabase.auth.getClaims();
  if (!data?.claims && !isPublic) return toLogin(request);
  return response;
}

function toLogin(request: NextRequest) {
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  if (request.nextUrl.pathname !== "/") url.searchParams.set("next", request.nextUrl.pathname);
  return NextResponse.redirect(url);
}

export const config = {
  // Skip static files and API routes (API routes return 401 themselves instead of redirecting).
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|robots.txt|.*\\.(?:png|jpg|svg|ico|woff2?)$).*)"],
};
