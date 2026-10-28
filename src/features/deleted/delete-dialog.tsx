"use client";

import { AlertTriangle, Loader2, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/form";
import { Dialog } from "@/components/ui/overlay";
import type { DeleteKind, DeletePreview } from "@/domain/dto";
import { useRunAction } from "@/lib/run-action";
import { useWorkspace } from "@/lib/workspace";
import { deleteRecord, previewDelete } from "@/server/delete-actions";

const TITLE: Record<DeleteKind, string> = {
  payment: "Delete payment",
  enrollment: "Delete enrollment",
  lead: "Delete lead",
  customer: "Delete person",
};

/**
 * Asks for a reason (and the word DELETE when confirmed money goes), after showing exactly what
 * will go with the record. Deleted records can be restored from Deleted items for 30 days.
 */
export function DeleteDialog({ kind, id, onClose, onDeleted }: { kind: DeleteKind; id: string; onClose: () => void; onDeleted?: () => void }) {
  const { me } = useWorkspace();
  const runAction = useRunAction();
  const [preview, setPreview] = useState<DeletePreview | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    previewDelete(kind, id).then((r) => {
      if (!live) return;
      if (r.ok) setPreview(r.value);
      else setFailed(r.error);
    }).catch(() => live && setFailed("Could not reach the server. Check your connection and try again."));
    return () => { live = false; };
  }, [kind, id]);

  const where = me.role === "manager" ? "Settings → Deleted items" : "Accounting → Deleted items";
  const ready = !!preview && !preview.closedMonth && !!reason.trim() && (!preview.needsTyped || typed.trim() === "DELETE");
  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    const r = await runAction(deleteRecord({ kind, id, reason, confirm: preview?.needsTyped ? typed.trim() : undefined }), null);
    setBusy(false);
    if (r.ok) {
      runAction(Promise.resolve({ ok: true as const, value: null }),
        r.value.flagged ? `Deleted. The customer is now below the handover rule and was flagged for review. Restore it from ${where} within 30 days.` : `Deleted. You can restore it from ${where} within 30 days.`);
      onDeleted?.();
      onClose();
    }
  };

  return (
    <Dialog open onClose={onClose} title={TITLE[kind]}
      description={preview ? preview.label : undefined}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="danger" icon={<Trash2 size={14} />} disabled={!ready || busy} onClick={submit}>Delete</Button></>}>
      {!preview && !failed && <p className="flex items-center gap-2 text-sm text-muted"><Loader2 size={14} className="animate-spin" aria-hidden /> Checking what goes with it…</p>}
      {failed && <p role="alert" className="text-sm text-bad">{failed}</p>}
      {preview && (
        <div className="space-y-4">
          <div className="rounded-lg bg-canvas px-3 py-2.5 text-sm" data-testid="delete-summary">
            <p className="font-medium">This deletes: {preview.summary}.</p>
            <p className="mt-1 text-xs text-muted">It leaves every list, report and Accounting figure at once. You can restore it from {where} for 30 days; after that it is removed for good.</p>
          </div>
          {preview.closedMonth ? (
            <p role="alert" className="flex items-start gap-2 rounded-lg bg-bad-bg px-3 py-2.5 text-sm text-bad">
              <AlertTriangle size={15} className="mt-0.5 shrink-0" aria-hidden />
              It has sessions in a closed salary month ({preview.closedMonth}), so it cannot be deleted. A manager can reopen the month in Accounting → Teachers, then delete it.
            </p>
          ) : (
            <>
              <Field label="Reason" required>
                {(p) => <Textarea value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Duplicate record, entered twice" {...p} />}
              </Field>
              {preview.needsTyped && (
                <Field label="Type DELETE to confirm" required hint="It includes confirmed money.">
                  {(p) => <Input value={typed} autoComplete="off" spellCheck={false} onChange={(e) => setTyped(e.target.value)} {...p} />}
                </Field>
              )}
            </>
          )}
        </div>
      )}
    </Dialog>
  );
}
