import "server-only";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { env } from "@/server/env";

/** Supabase client bound to the visitor's auth cookies (sign-in, sign-out, password reset). */
export async function supabaseForRequest() {
  const e = env();
  const store = await cookies();
  return createServerClient(e.NEXT_PUBLIC_SUPABASE_URL!, e.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (toSet) => {
        try {
          toSet.forEach(({ name, value, options }) => store.set(name, value, options));
        } catch {
          // Server Components cannot set cookies; the proxy refreshes them instead.
        }
      },
    },
  });
}

/** Admin client (server only) for inviting and blocking staff logins. */
export function supabaseAdmin() {
  const e = env();
  if (!e.SUPABASE_SECRET_KEY) throw new Error("SUPABASE_SECRET_KEY is required to manage staff logins.");
  return createClient(e.NEXT_PUBLIC_SUPABASE_URL!, e.SUPABASE_SECRET_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
