"use client";

import { ArchiveRestore, RotateCcw } from "lucide-react";
import { useState } from "react";
import { Pill } from "@/components/ui/badges";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, EmptyState, SkeletonRows } from "@/components/ui/misc";
import type { DeletedItem, DeleteKind } from "@/domain/dto";
import { formatCairo } from "@/domain/rules";
import { useRunAction } from "@/lib/run-action";
import { useApi, useWorkspace } from "@/lib/workspace";
import { restoreDeleted } from "@/server/delete-actions";

const KIND: Record<DeleteKind, { label: string; className: string }> = {
  payment: { label: "Payment", className: "bg-info-bg text-info" },
  enrollment: { label: "Enrollment", className: "bg-navy-50 text-navy-900" },
  lead: { label: "Lead", className: "bg-[#eeeff3] text-[#4b4e66]" },
  customer: { label: "Person", className: "bg-bad-bg text-bad" },
};

/** Settings → Deleted items (managers) and Accounting → Deleted items (the accountant's own payments). */
export function DeletedItemsView() {
  const { me } = useWorkspace();
  const runAction = useRunAction();
  const [busy, setBusy] = useState<string | null>(null);
  const { data, loading } = useApi<{ items: DeletedItem[] }>("/api/deleted-items");
  const restore = async (it: DeletedItem) => {
    setBusy(it.id);
    const r = await runAction(restoreDeleted(it.id), null);
    setBusy(null);
    if (r.ok) {
      runAction(Promise.resolve({ ok: true as const, value: null }),
        `${KIND[it.kind].label} restored${r.value.queued ? ". Its sales agent has left, so the lead went back to the unassigned queue." : "."}`);
    }
  };
  return (
    <Card>
      <CardHeader title="Deleted items"
        subtitle={me.role === "manager" ? "Everything deleted in the last 30 days. Restore puts it back exactly as it was, with its history. After 30 days it is removed for good." : "Payments you deleted in the last 30 days. Restore puts them back exactly as they were."}
        count={data?.items.length} />
      {!data && loading ? <SkeletonRows rows={4} /> : !data?.items.length ? (
        <EmptyState icon={<ArchiveRestore size={22} />} title="Nothing deleted">Deleted records stay here for 30 days.</EmptyState>
      ) : (
        <ul aria-label="Deleted items" className="divide-y divide-line">
          {data.items.map((it) => (
            <li key={it.id} className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3" data-deleted-item={it.label}>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-sm">
                  <Pill className={KIND[it.kind].className}>{KIND[it.kind].label}</Pill>
                  <span className="font-medium" dir="auto">{it.label}</span>
                </p>
                <p className="mt-1 text-xs text-muted">{it.summary}</p>
                <p className="mt-1 text-sm" dir="auto">Reason: {it.reason}</p>
                <p className="mt-1 text-xs text-muted">Deleted by {it.deletedBy} · {formatCairo(it.deletedAt)} · removed for good on {formatCairo(it.purgeAfter, "date")}</p>
              </div>
              <Button size="sm" icon={<RotateCcw size={14} />} disabled={busy === it.id} onClick={() => restore(it)} aria-label={`Restore ${it.label}`}>Restore</Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
