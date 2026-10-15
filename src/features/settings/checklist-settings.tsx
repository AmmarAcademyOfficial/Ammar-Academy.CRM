"use client";

import { Archive, ArchiveRestore, ArrowDown, ArrowUp, Pencil, Plus } from "lucide-react";
import { useState } from "react";
import { Button, IconButton } from "@/components/ui/button";
import { cn as clsx } from "@/components/ui/cn";
import { Field, Input } from "@/components/ui/form";
import { Card, CardHeader } from "@/components/ui/misc";
import { Dialog } from "@/components/ui/overlay";
import type { ChecklistTemplateItem } from "@/domain/types";
import { useRunAction } from "@/lib/run-action";
import { useWorkspace } from "@/lib/workspace";
import { moveChecklistStep, saveChecklistStep, setChecklistStepArchived } from "@/server/payment-actions";

/** Settings → Support Checklist: the steps every new customer goes through. */
export function ChecklistSettings() {
  const { ref } = useWorkspace();
  const runAction = useRunAction();
  const [editing, setEditing] = useState<Partial<ChecklistTemplateItem> | null>(null);
  const active = ref.checklist.filter((c) => !c.archived);
  const archived = ref.checklist.filter((c) => c.archived);
  return (
    <Card>
      <CardHeader title="Onboarding checklist" subtitle="Copied to each customer when they are handed over. Changes apply to new handovers only." action={<Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => setEditing({ dueAfterDays: 1 })}>Add step</Button>} />
      <ol className="divide-y divide-line">
        {active.map((c, i) => (
          <li key={c.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
            <span className="w-5 text-xs tabular-nums text-muted">{i + 1}.</span>
            <span className="min-w-0 flex-1">{c.label}</span>
            <span className="text-xs text-muted">{c.dueAfterDays === null ? "No due date" : c.dueAfterDays === 0 ? "Due on handover day" : `Due ${c.dueAfterDays} day${c.dueAfterDays === 1 ? "" : "s"} after handover`}</span>
            <IconButton label={`Move ${c.label} up`} icon={<ArrowUp size={14} />} disabled={i === 0} onClick={() => runAction(moveChecklistStep(c.id, -1), null, { reference: true })} />
            <IconButton label={`Move ${c.label} down`} icon={<ArrowDown size={14} />} disabled={i === active.length - 1} onClick={() => runAction(moveChecklistStep(c.id, 1), null, { reference: true })} />
            <IconButton label={`Edit ${c.label}`} icon={<Pencil size={14} />} onClick={() => setEditing(c)} />
            <IconButton label={`Archive ${c.label}`} icon={<Archive size={14} />} onClick={() => runAction(setChecklistStepArchived(c.id, true), "Step archived", { reference: true })} />
          </li>
        ))}
        {archived.map((c) => (
          <li key={c.id} className={clsx("flex items-center gap-3 px-4 py-2.5 text-sm text-muted")}>
            <span className="w-5" />
            <span className="min-w-0 flex-1 line-through">{c.label}</span>
            <span className="text-xs">Archived</span>
            <IconButton label={`Restore ${c.label}`} icon={<ArchiveRestore size={14} />} onClick={() => runAction(setChecklistStepArchived(c.id, false), "Step restored", { reference: true })} />
          </li>
        ))}
      </ol>
      {editing && <StepDialog step={editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function StepDialog({ step, onClose }: { step: Partial<ChecklistTemplateItem>; onClose: () => void }) {
  const runAction = useRunAction();
  const [label, setLabel] = useState(step.label ?? "");
  const [days, setDays] = useState(step.dueAfterDays === null || step.dueAfterDays === undefined ? "" : String(step.dueAfterDays));
  return (
    <Dialog open onClose={onClose} title={step.id ? "Edit step" : "Add step"}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={async () => { const r = await runAction(saveChecklistStep({ id: step.id, label, dueAfterDays: days === "" ? null : Number(days) }), "Step saved", { reference: true }); if (r.ok) onClose(); }}>Save</Button></>}>
      <div className="space-y-4">
        <Field label="Step" required>{(p) => <Input value={label} maxLength={120} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Welcome call done" {...p} />}</Field>
        <Field label="Due (days after handover)" hint="Leave empty for no due date.">{(p) => <Input type="number" min={0} max={365} value={days} onChange={(e) => setDays(e.target.value)} {...p} />}</Field>
      </div>
    </Dialog>
  );
}
