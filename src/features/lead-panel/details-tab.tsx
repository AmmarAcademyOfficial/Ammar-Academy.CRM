"use client";

import { AlertTriangle, ChevronDown, Lock } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/form";
import { Name, PhoneText } from "@/components/ui/misc";
import { canEditField, canReadField } from "@/domain/permissions";
import { fieldAppliesTo, formatCairo, isFieldRequired } from "@/domain/rules";
import type { FieldDefinition, FieldValue } from "@/domain/types";
import { profileName, type LeadRow } from "@/lib/lead-row";
import { useRunAction } from "@/lib/run-action";
import { useWorkspace } from "@/lib/workspace";
import { saveFieldValues } from "@/server/actions";
import { FieldInput, fieldDisplay } from "./field-input";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[140px_1fr] gap-3 py-1.5 text-sm">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

export function DetailsTab({ row, values, onDirtyChange, onReload }: { row: LeadRow; values: Record<string, FieldValue>; onDirtyChange: (dirty: boolean) => void; onReload: () => void }) {
  const { me, ref } = useWorkspace();
  const runAction = useRunAction();
  const q = row.inquiry;
  // The version this person started editing from; a newer version means someone else saved.
  const [editBase, setEditBase] = useState<number | null>(null);
  const [draft, setDraft] = useState<Record<string, FieldValue>>({});
  const [conflict, setConflict] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const dirty = Object.keys(draft).length > 0;

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  const fields = ref.fields.filter((f) => fieldAppliesTo(f, q.programId) && canReadField(me.role, f)).sort((a, b) => a.order - b.order);
  const main = fields.filter((f) => f.importance !== "additional");
  const more = fields.filter((f) => f.importance === "additional");

  const save = async (onTop = false) => {
    setBusy(true);
    const r = await runAction(saveFieldValues(q.id, draft, onTop ? q.version : (editBase ?? q.version)), "Details saved", { quiet: true });
    setBusy(false);
    if (r.ok) {
      setDraft({});
      setConflict(false);
      setEditBase(null);
    } else if (r.code === "conflict") {
      setConflict(true);
      onReload();
    }
  };

  const discard = () => {
    setDraft({});
    setConflict(false);
    setEditBase(null);
    onReload();
  };

  const renderField = (f: FieldDefinition) => {
    const editable = canEditField(me.role, f) && me.role !== "support";
    const required = isFieldRequired(f, q.programId, row.stage.systemKey, ref.stages);
    const value = f.id in draft ? draft[f.id] : values[f.id];
    if (!editable) {
      return (
        <Row key={f.id} label={f.label}>
          <span className="inline-flex items-center gap-1.5">
            {fieldDisplay(f, values[f.id])}
            <Lock size={12} className="text-muted" aria-label="Read only for your role" />
          </span>
        </Row>
      );
    }
    return (
      <Field key={f.id} label={f.label} required={required}>
        {(p) => <FieldInput field={f} value={value} onChange={(v) => {
          setEditBase((b) => b ?? q.version);
          setDraft((d) => ({ ...d, [f.id]: v }));
        }} {...p} />}
      </Field>
    );
  };

  return (
    <div className="space-y-6">
      <section>
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Contact</h3>
        <dl className="divide-y divide-line/60">
          <Row label="Name"><Name>{row.contact.name}</Name></Row>
          <Row label="Main phone"><PhoneText value={row.contact.phoneNormalized} /></Row>
          <Row label="Additional phone">{row.contact.phoneSecondary ? <PhoneText value={row.contact.phoneSecondary} /> : "—"}</Row>
          <Row label="Contact type"><span className="capitalize">{row.contact.contactType}</span></Row>
          <Row label="Student name">{q.studentName ? <Name>{q.studentName}</Name> : "—"}</Row>
        </dl>
      </section>

      <section>
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Inquiry</h3>
        <dl className="divide-y divide-line/60">
          <Row label="Program">{row.program.code}</Row>
          <Row label="Sales owner">{profileName(ref, q.salesOwnerId)}</Row>
          <Row label="Source">{q.source === "manual" ? "Added manually" : "Google Sheet"}</Row>
          <Row label="Created">{formatCairo(q.createdAt)}</Row>
          <Row label="Assigned">{q.assignedAt ? formatCairo(q.assignedAt) : "Not yet"}</Row>
          <Row label="First contact attempt">{q.firstContactAttemptAt ? formatCairo(q.firstContactAttemptAt) : "Not yet"}</Row>
          <Row label="Latest contact">{q.lastContactAt ? formatCairo(q.lastContactAt) : "—"}</Row>
          {q.lostReason && <Row label="Lost reason">{q.lostReason}</Row>}
        </dl>
        <p className="mt-2 flex items-center gap-1.5 text-xs text-muted"><Lock size={12} aria-hidden /> System IDs, timestamps and ownership are protected.</p>
      </section>

      <section>
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">Customer fields</h3>
        {conflict && (
          <div role="alert" className="mb-4 rounded-lg border border-orange-500/50 bg-orange-50 p-3 text-sm">
            <p className="flex items-center gap-2 font-medium text-orange-ink"><AlertTriangle size={16} aria-hidden /> Someone else saved this record while you were editing.</p>
            <p className="mt-1 text-muted">Your unsaved changes are still here, and the latest saved values have loaded. Choose what to do:</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" variant="navy" disabled={busy} onClick={() => save(true)}>Apply my changes on top</Button>
              <Button size="sm" onClick={discard}>Discard mine and show latest</Button>
            </div>
          </div>
        )}
        {fields.length === 0 && <p className="text-sm text-muted">No customer fields apply to this program.</p>}
        <div className="space-y-4">{main.map(renderField)}</div>
        {more.length > 0 && (
          <div className="mt-4">
            <button className="inline-flex items-center gap-1 text-sm font-medium text-navy-700" aria-expanded={showMore} onClick={() => setShowMore((s) => !s)}>
              <ChevronDown size={16} className={showMore ? "rotate-180" : ""} aria-hidden /> {showMore ? "Hide" : "Show"} additional fields ({more.length})
            </button>
            {showMore && <div className="mt-3 space-y-4">{more.map(renderField)}</div>}
          </div>
        )}
        {dirty && !conflict && (
          <div className="sticky bottom-0 mt-5 flex items-center gap-2 border-t border-line bg-white py-3">
            <span className="mr-auto text-xs text-muted">Unsaved changes</span>
            <Button size="sm" onClick={discard}>Discard</Button>
            <Button size="sm" variant="primary" disabled={busy} onClick={() => save()}>Save details</Button>
          </div>
        )}
      </section>
    </div>
  );
}
