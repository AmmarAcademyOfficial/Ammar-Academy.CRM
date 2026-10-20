import Link from "next/link";
import { Logo } from "@/components/ui/logo";

export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-canvas px-6 text-center">
      <Logo height={64} className="mb-6" />
      <h1 className="text-xl font-semibold text-navy-900">Page not found</h1>
      <p className="mt-2 max-w-sm text-sm text-muted">This address does not exist in the CRM, or the link is out of date.</p>
      <Link href="/" className="mt-6 inline-flex h-10 items-center rounded-lg bg-navy-900 px-4 text-sm font-semibold text-white hover:bg-navy-800">Go to the CRM</Link>
    </main>
  );
}
