"use client";

import { AlertTriangle, CalendarPlus, CheckCircle2, Circle, Hand, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { SUPPORT_STATUS_LABEL, SupportStatusBadge } from "@/components/ui/badges";
import { Button } from "@/components/ui/button";
import { cn as clsx } from "@/components/ui/cn";
import { Field, Input, Select } from "@/components/ui/form";
import { Dialog } from "@/components/ui/overlay";
import type { LeadDetail } from "@/domain/dto";
import { formatCairo, formatRelative } from "@/domain/rules";
import type { SupportStatus } from "@/domain/types";
import { profileName } from "@/lib/lead-row";
import { useRunAction } from "@/lib/run-action";
import { useWorkspace } from "@/lib/workspace";
import { assignCustomer, claimCustomer, clearCustomerFlag, completeSupportFollowUp, createSupportFollowUp, setChecklistItem, setSupportStatus } from "@/server/payment-actions";
import { cairoLocalInput, fromCairoLocal } from "./dialogs";
import { SessionsSection } from "./sessions-section";
import { TeachersSection } from "./teachers-section";

export function SupportTab({ detail }: { detail: LeadDetail }) {
  const { me, ref, now } = useWorkspace();
  const runAction = useRunAction();
  const ob = detail.onboarding!;
  const [modal, setModal] = useState<null | "followup" | "assign" | "clear">(null);
  const canWork = me.role === "manager" || (me.role === "support" && ob.supportOwnerId === me.id);
  const done = ob.checklist.filter((c) => c.doneAt).length;
  const openFus = detail.supportFollowUps.filter((f) => f.status === "open");

  return (
    <div className="space-y-5">
      {ob.flaggedForReview && (
        <div role="alert" className="rounded-lg bg-warn-bg p-3 text-sm text-warn">
          <p className="flex gap-2"><AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden /> {ob.flaggedForReview}</p>
          {me.role === "manager" && <Button size="sm" className="mt-2" icon={<ShieldCheck size={14} />} onClick={() => setModal("clear")}>Mark as resolved</Button>}
        </div>
      )}

      <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line p-4">
        <div>
          <p className="text-xs text-muted">Support owner</p>
          <p className={clsx("font-medium", !ob.supportOwnerId && "text-orange-ink")}>{ob.supportOwnerId ? profileName(ref, ob.supportOwnerId) : "Waiting in the support queue"}</p>
          <p className="text-xs text-muted">Handed over {formatCairo(ob.createdAt)}{ob.claimedAt ? ` · assigned ${formatRelative(ob.claimedAt, now)}` : ""}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!ob.supportOwnerId && me.role === "support" && (
            <Button variant="primary" icon={<Hand size={16} />} onClick={() => runAction(claimCustomer(ob.id), "Customer assigned to you")}>Assign to Me</Button>
          )}
          {me.role === "manager" && <Button size="sm" onClick={() => setModal("assign")}>{ob.supportOwnerId ? "Reassign" : "Assign"}</Button>}
        </div>
      </section>

      <TeachersSection detail={detail} canWork={canWork} />

      <SessionsSection detail={detail} canWork={canWork} />

      <section>
        <div className="mb-2 flex items-center justify-between gap-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Status</h3>
          <SupportStatusBadge status={ob.status} />
        </div>
        <Select aria-label="Support status" value={ob.status} disabled={!canWork}
          onChange={(e) => runAction(setSupportStatus(ob.id, e.target.value as SupportStatus), "Support status updated")}>
          {(Object.keys(SUPPORT_STATUS_LABEL) as SupportStatus[]).map((s) => <option key={s} value={s}>{SUPPORT_STATUS_LABEL[s]}</option>)}
        </Select>
        {ob.status !== "active" && <p className="mt-1 text-xs text-muted">Active needs every checklist step done.</p>}
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Onboarding checklist</h3>
          <span className="text-xs text-muted">{done} of {ob.checklist.length} done</span>
        </div>
        <ul className="divide-y divide-line rounded-xl border border-line">
          {ob.checklist.map((c) => {
            const overdue = !c.doneAt && c.dueAt && new Date(c.dueAt) < now;
            return (
              <li key={c.templateItemId}>
                <button disabled={!canWork} aria-pressed={!!c.doneAt}
                  onClick={() => runAction(setChecklistItem(ob.id, c.templateItemId, !c.doneAt), c.doneAt ? "Step reopened" : "Step done")}
                  className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-navy-50 disabled:cursor-default disabled:hover:bg-transparent">
                  {c.doneAt ? <CheckCircle2 size={20} className="mt-0.5 shrink-0 text-ok" aria-hidden /> : <Circle size={20} className="mt-0.5 shrink-0 text-line" aria-hidden />}
                  <span className="min-w-0">
                    <span className={clsx("block text-sm", c.doneAt && "text-muted line-through")}>{c.label}</span>
                    <span className={clsx("text-xs", overdue ? "font-medium text-bad" : "text-muted")}>
                      {c.doneAt ? `Done ${formatCairo(c.doneAt)} by ${profileName(ref, c.doneById)}` : c.dueAt ? `${overdue ? "Overdue · was due" : "Due"} ${formatCairo(c.dueAt, "date")}` : "No due date"}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
          {ob.checklist.length === 0 && <li className="px-4 py-3 text-sm text-muted">No checklist steps were set up when this customer was handed over.</li>}
        </ul>
        {!canWork && <p className="mt-2 text-xs text-muted">{ob.supportOwnerId ? "Only the support owner can update this." : me.role === "support" ? "Assign this customer to yourself to start onboarding." : "Read only."}</p>}
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Support follow-ups</h3>
          {canWork && <Button size="sm" icon={<CalendarPlus size={14} />} onClick={() => setModal("followup")}>Add</Button>}
        </div>
        {openFus.length === 0 ? (
          <p className="text-sm text-muted">No open support follow-ups.</p>
        ) : (
          <ul className="space-y-2">
            {openFus.map((f) => {
              const overdue = new Date(f.dueAt) < now;
              return (
                <li key={f.id} className="flex items-center gap-3 rounded-lg border border-line px-3 py-2 text-sm">
                  <span className="min-w-0 flex-1">
                    <span dir="auto" className="block">{f.note}</span>
                    <span className={clsx("text-xs", overdue ? "font-medium text-bad" : "text-muted")}>{overdue ? "Overdue · " : ""}{formatCairo(f.dueAt)}</span>
                  </span>
                  {canWork && <Button size="sm" onClick={() => runAction(completeSupportFollowUp(f.id), "Follow-up done")}>Done</Button>}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {modal === "followup" && <SupportFollowUpDialog onboardingId={ob.id} onClose={() => setModal(null)} />}
      {modal === "assign" && <AssignSupportDialog onboardingId={ob.id} current={ob.supportOwnerId} onClose={() => setModal(null)} />}
      {modal === "clear" && <ClearFlagDialog onboardingId={ob.id} onClose={() => setModal(null)} />}
    </div>
  );
}

function SupportFollowUpDialog({ onboardingId, onClose }: { onboardingId: string; onClose: () => void }) {
  const runAction = useRunAction();
  const [when, setWhen] = useState(() => cairoLocalInput(new Date(Date.now() + 24 * 3600_000)));
  const [note, setNote] = useState("");
  return (
    <Dialog open onClose={onClose} title="Add support follow-up" description="Times are in Cairo time."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!note.trim() || !when} onClick={async () => { const r = await runAction(createSupportFollowUp(onboardingId, fromCairoLocal(when), note), "Follow-up added"); if (r.ok) onClose(); }}>Save</Button></>}>
      <div className="space-y-4">
        <Field label="Date and time" required>{(p) => <Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} {...p} />}</Field>
        <Field label="What to do" required>{(p) => <Input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Check the first week went well" {...p} />}</Field>
      </div>
    </Dialog>
  );
}

function AssignSupportDialog({ onboardingId, current, onClose }: { onboardingId: string; current: string | null; onClose: () => void }) {
  const { ref } = useWorkspace();
  const runAction = useRunAction();
  const people = ref.profiles.filter((p) => p.role === "support" && p.active && p.id !== current);
  const [to, setTo] = useState(people[0]?.id ?? "");
  const [reason, setReason] = useState("");
  return (
    <Dialog open onClose={onClose} title={current ? "Reassign support owner" : "Assign support owner"}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!to || (Boolean(current) && !reason.trim())} onClick={async () => { const r = await runAction(assignCustomer(onboardingId, to, reason || undefined), "Support owner updated"); if (r.ok) onClose(); }}>Save</Button></>}>
      {people.length === 0 ? <p className="text-sm text-muted">There are no other active support team members.</p> : (
        <div className="space-y-4">
          <Field label="Support team member" required>{(p) => <Select value={to} onChange={(e) => setTo(e.target.value)} {...p}>{people.map((x) => <option key={x.id} value={x.id}>{x.fullName}</option>)}</Select>}</Field>
          {current && <Field label="Reason" required>{(p) => <Input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Covering leave" {...p} />}</Field>}
        </div>
      )}
    </Dialog>
  );
}

function ClearFlagDialog({ onboardingId, onClose }: { onboardingId: string; onClose: () => void }) {
  const runAction = useRunAction();
  const [note, setNote] = useState("");
  return (
    <Dialog open onClose={onClose} title="Mark the review flag as resolved" description="For example: the customer paid again, or the reversal was a bank error."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!note.trim()} onClick={async () => { const r = await runAction(clearCustomerFlag(onboardingId, note), "Flag cleared"); if (r.ok) onClose(); }}>Mark resolved</Button></>}>
      <Field label="How was it resolved?" required>{(p) => <Input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} {...p} />}</Field>
    </Dialog>
  );
}
