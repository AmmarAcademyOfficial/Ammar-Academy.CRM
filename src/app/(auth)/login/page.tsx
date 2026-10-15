import { redirect } from "next/navigation";
import { LocalSignIn, SignInForm } from "@/features/auth/sign-in";
import { getStaff } from "@/server/auth";
import { asSystem } from "@/server/db";
import { env } from "@/server/env";

export const metadata = { title: "Sign in · Ammar Academy CRM" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const sp = await searchParams;
  const next = typeof sp.next === "string" ? sp.next : "/";
  if (await getStaff()) redirect(next);
  const inactive = sp.reason === "inactive";

  if (env().AUTH_MODE === "local") {
    const staff = await asSystem((tx) => tx<{ id: string; full_name: string; role: string }[]>`
      select id, full_name, role from public.profiles where active order by role, full_name`);
    return <LocalSignIn staff={staff.map((s) => ({ id: s.id, name: s.full_name, role: s.role }))} next={next} />;
  }
  return <SignInForm next={next} inactive={inactive} />;
}
