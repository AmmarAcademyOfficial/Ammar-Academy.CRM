"use client";

import { FileSpreadsheet } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";

/**
 * "Download Excel": asks the server for the .xlsx of exactly what the current filters show and saves
 * it. The server records every download in the audit log, and explains any refusal (for example,
 * more than 20,000 rows), which is shown as a toast.
 */
export function DownloadExcelButton({ url, body, disabled, className }: { url: string; body: unknown; disabled?: boolean; className?: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as { error?: string } | null;
        toast.error(err?.error ?? "The download could not be prepared. Try again.");
        return;
      }
      const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? "download.xlsx";
      const href = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = href;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 10_000);
      toast.success("Excel file downloaded");
    } catch {
      toast.error("Could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button icon={<FileSpreadsheet size={16} />} disabled={disabled || busy} onClick={run} className={className}>
      {busy ? "Preparing…" : "Download Excel"}
    </Button>
  );
}
