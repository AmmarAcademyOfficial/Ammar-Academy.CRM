import type { Metadata, Viewport } from "next";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-arabic";
import "./globals.css";
import { HydrationMark } from "@/components/hydration-mark";

export const metadata: Metadata = {
  title: "Ammar Academy CRM",
  description: "Sales, payments and onboarding workspace for Ammar Academy.",
  // Private staff tool: never indexed.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#0e0f3b",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body className="min-h-dvh">
        {children}
        <HydrationMark />
      </body>
    </html>
  );
}
