import Link from "next/link";
import type { ReactNode } from "react";

/** Sign-in pages: brand panel on wide screens, a single column on phones. */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[1fr_1.1fr]">
      <aside className="hidden flex-col justify-between bg-navy-900 p-10 text-white lg:flex">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-orange-500 text-lg font-bold text-navy-900" aria-hidden>A</span>
          <span className="leading-tight">
            <span className="block text-base font-semibold">Ammar Academy</span>
            <span className="block text-[11px] font-medium uppercase tracking-[0.14em] text-orange-400">CRM</span>
          </span>
        </div>
        <div className="max-w-md">
          <p className="text-3xl font-semibold leading-tight text-balance">Every SAT and IELTS inquiry, from first call to first class.</p>
          <p className="mt-3 text-sm text-navy-100/70">Staff access only. Accounts are created by a manager.</p>
        </div>
        <p className="text-xs text-navy-100/50">Times shown in Cairo time.</p>
      </aside>
      <main className="flex items-center justify-center bg-canvas px-4 py-10">
        <div className="w-full max-w-sm">
          {children}
          <p className="mt-8 text-center text-xs text-muted"><Link href="/privacy" className="underline hover:text-ink">Privacy policy</Link></p>
        </div>
      </main>
    </div>
  );
}
