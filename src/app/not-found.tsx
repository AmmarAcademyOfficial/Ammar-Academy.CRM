import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-canvas px-6 text-center">
      <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-orange-500 text-2xl font-bold text-navy-900" aria-hidden>A</span>
      <h1 className="text-xl font-semibold text-navy-900">Page not found</h1>
      <p className="mt-2 max-w-sm text-sm text-muted">This address does not exist in the CRM, or the link is out of date.</p>
      <Link href="/" className="mt-6 inline-flex h-10 items-center rounded-lg bg-navy-900 px-4 text-sm font-semibold text-white hover:bg-navy-800">Go to the CRM</Link>
    </main>
  );
}
