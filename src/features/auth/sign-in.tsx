"use client";

import { FlaskConical, LogIn } from "lucide-react";
import Link from "next/link";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form";
import { localSignIn, requestPasswordReset, signIn, updatePassword, type FormState } from "@/server/auth-actions";

function Heading({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="mb-6">
      <div className="mb-6 flex items-center gap-2.5 lg:hidden">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-navy-900 font-bold text-orange-400" aria-hidden>A</span>
        <span className="font-semibold text-navy-900">Ammar Academy CRM</span>
      </div>
      <h1 className="text-2xl font-semibold tracking-tight text-navy-900">{title}</h1>
      {sub && <p className="mt-1 text-sm text-muted">{sub}</p>}
    </div>
  );
}

function Alert({ state }: { state: FormState }) {
  if (state.error) return <p role="alert" className="rounded-lg bg-bad-bg px-3 py-2 text-sm text-bad">{state.error}</p>;
  if (state.message) return <p role="status" className="rounded-lg bg-ok-bg px-3 py-2 text-sm text-ok">{state.message}</p>;
  return null;
}

export function SignInForm({ next, inactive }: { next: string; inactive: boolean }) {
  const [state, action, pending] = useActionState(signIn, inactive ? { error: "Your account is not active. Ask a manager to reactivate it." } : {});
  return (
    <>
      <Heading title="Sign in" sub="Use the email your manager invited." />
      <form action={action} className="space-y-4">
        <input type="hidden" name="next" value={next} />
        <Alert state={state} />
        <Field label="Email">{(p) => <Input name="email" type="email" autoComplete="username" required dir="ltr" {...p} />}</Field>
        <Field label="Password">{(p) => <Input name="password" type="password" autoComplete="current-password" required {...p} />}</Field>
        <Button type="submit" variant="primary" className="w-full" disabled={pending} icon={<LogIn size={16} />}>
          {pending ? "Signing in…" : "Sign in"}
        </Button>
      </form>
      <p className="mt-4 text-center text-sm">
        <Link href="/forgot-password" className="font-medium text-navy-700 hover:underline">Forgot your password?</Link>
      </p>
    </>
  );
}

export function ForgotPasswordForm() {
  const [state, action, pending] = useActionState(requestPasswordReset, {});
  return (
    <>
      <Heading title="Reset your password" sub="We will email you a link to choose a new password." />
      <form action={action} className="space-y-4">
        <Alert state={state} />
        <Field label="Email">{(p) => <Input name="email" type="email" required dir="ltr" {...p} />}</Field>
        <Button type="submit" variant="primary" className="w-full" disabled={pending}>{pending ? "Sending…" : "Send reset link"}</Button>
      </form>
      <p className="mt-4 text-center text-sm"><Link href="/login" className="font-medium text-navy-700 hover:underline">Back to sign in</Link></p>
    </>
  );
}

export function NewPasswordForm() {
  const [state, action, pending] = useActionState(updatePassword, {});
  return (
    <>
      <Heading title="Choose your password" sub="At least 10 characters." />
      <form action={action} className="space-y-4">
        <Alert state={state} />
        <Field label="New password">{(p) => <Input name="password" type="password" autoComplete="new-password" required minLength={10} {...p} />}</Field>
        <Field label="Repeat password">{(p) => <Input name="confirm" type="password" autoComplete="new-password" required minLength={10} {...p} />}</Field>
        <Button type="submit" variant="primary" className="w-full" disabled={pending}>{pending ? "Saving…" : "Save password"}</Button>
      </form>
    </>
  );
}

/** Development only. Shown when AUTH_MODE=local against a local database. */
export function LocalSignIn({ staff, next }: { staff: { id: string; name: string; role: string }[]; next: string }) {
  return (
    <>
      <Heading title="Local sign-in" sub="Development database. Choose a staff member; no password is needed." />
      <p className="mb-4 flex items-center gap-2 rounded-lg border border-dashed border-orange-ink/40 bg-orange-50 px-3 py-2 text-xs text-orange-ink">
        <FlaskConical size={14} aria-hidden /> Only available when the database runs on this computer. Real deployments use email and password.
      </p>
      <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-white">
        {staff.map((s) => (
          <li key={s.id}>
            <form action={localSignIn}>
              <input type="hidden" name="userId" value={s.id} />
              <input type="hidden" name="next" value={next} />
              <button type="submit" className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-navy-50">
                <span className="font-medium">{s.name}</span>
                <span className="text-xs capitalize text-muted">{s.role}</span>
              </button>
            </form>
          </li>
        ))}
      </ul>
    </>
  );
}
