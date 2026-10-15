"use client";

import Link from "next/link";
import { useEffect } from "react";

/** Friendly page for an unexpected error. Shows a reference code, never technical details. */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[crm] page error", error.digest ?? "");
  }, [error]);
  return (
    <main className="flex min-h-[70dvh] flex-col items-center justify-center px-6 text-center">
      <h1 className="text-xl font-semibold text-navy-900">Something went wrong</h1>
      <p className="mt-2 max-w-sm text-sm text-muted">Nothing you entered was lost. Try again; if it keeps happening, tell a manager{error.digest ? <> and mention code <span className="font-mono text-ink">{error.digest}</span></> : null}.</p>
      <div className="mt-6 flex gap-2">
        <button onClick={reset} className="inline-flex h-10 items-center rounded-lg bg-navy-900 px-4 text-sm font-semibold text-white hover:bg-navy-800">Try again</button>
        <Link href="/" className="inline-flex h-10 items-center rounded-lg border border-line bg-white px-4 text-sm font-medium hover:bg-navy-50">Go to the CRM</Link>
      </div>
    </main>
  );
}
