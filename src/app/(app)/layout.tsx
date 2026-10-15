import type { ReactNode } from "react";
import { AppShell } from "@/components/layout/app-shell";
import { ToastProvider } from "@/components/ui/toast";
import { LeadPanelHost } from "@/features/lead-panel/lead-panel";
import { WorkspaceProvider } from "@/lib/workspace";
import { requestTime, requireStaffPage } from "@/server/auth";
import { loadReference } from "@/server/queries";

/** Everything behind sign-in. Reference data is loaded once here, as the signed-in user. */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const staff = await requireStaffPage();
  const reference = await loadReference(staff);
  return (
    <WorkspaceProvider me={staff} reference={reference} serverNow={requestTime()}>
      <ToastProvider>
        <AppShell>{children}</AppShell>
        <LeadPanelHost />
      </ToastProvider>
    </WorkspaceProvider>
  );
}
