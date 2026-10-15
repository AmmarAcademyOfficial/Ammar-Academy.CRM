"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { supabaseForRequest } from "@/lib/supabase/server";
import { LOCAL_COOKIE, localSessionValue } from "./auth";
import { asSystem } from "./db";
import { env } from "./env";

export interface FormState {
  error?: string;
  message?: string;
}

const safeNext = (v: FormDataEntryValue | null) => {
  const s = typeof v === "string" ? v : "";
  return s.startsWith("/") && !s.startsWith("//") ? s : "/";
};

export async function signIn(_prev: FormState, form: FormData): Promise<FormState> {
  const parsed = z.object({ email: z.string().trim().email(), password: z.string().min(1) }).safeParse({
    email: form.get("email"),
    password: form.get("password"),
  });
  if (!parsed.success) return { error: "Enter your email and password." };
  const supabase = await supabaseForRequest();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  // One message for every failure, so the form does not reveal which emails exist.
  if (error) return { error: "That email and password do not match. Try again or reset your password." };
  redirect(safeNext(form.get("next")));
}

/** Local development only: sign in as a seeded staff member without a password. */
export async function localSignIn(form: FormData): Promise<void> {
  if (env().AUTH_MODE !== "local") throw new Error("Local sign-in is disabled.");
  const id = z.string().uuid().parse(form.get("userId"));
  const [p] = await asSystem((tx) => tx`select id from public.profiles where id = ${id} and active`);
  if (!p) throw new Error("That account is not active.");
  (await cookies()).set(LOCAL_COOKIE, localSessionValue(id), { httpOnly: true, sameSite: "lax", path: "/", secure: false });
  redirect(safeNext(form.get("next")));
}

export async function signOut(): Promise<void> {
  if (env().AUTH_MODE === "local") {
    (await cookies()).delete(LOCAL_COOKIE);
  } else {
    const supabase = await supabaseForRequest();
    await supabase.auth.signOut();
  }
  redirect("/login");
}

export async function requestPasswordReset(_prev: FormState, form: FormData): Promise<FormState> {
  const email = z.string().trim().email().safeParse(form.get("email"));
  if (!email.success) return { error: "Enter a valid email address." };
  if (env().AUTH_MODE === "supabase") {
    const h = await headers();
    const origin = env().APP_URL ?? `${h.get("x-forwarded-proto") ?? "https"}://${h.get("x-forwarded-host") ?? h.get("host")}`;
    const supabase = await supabaseForRequest();
    await supabase.auth.resetPasswordForEmail(email.data, { redirectTo: `${origin}/auth/confirm?next=/reset-password` });
  }
  // Same answer whether or not the email exists.
  return { message: "If that email belongs to a staff account, a reset link is on its way. Check your inbox." };
}

export async function updatePassword(_prev: FormState, form: FormData): Promise<FormState> {
  const password = String(form.get("password") ?? "");
  const confirm = String(form.get("confirm") ?? "");
  if (password.length < 10) return { error: "Use at least 10 characters." };
  if (password !== confirm) return { error: "The two passwords do not match." };
  const supabase = await supabaseForRequest();
  const { error } = await supabase.auth.updateUser({ password });
  if (error) return { error: "Your reset link has expired. Request a new one from the sign-in page." };
  redirect("/");
}
