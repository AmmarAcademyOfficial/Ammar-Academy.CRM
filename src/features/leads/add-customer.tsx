"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DiscardDialog } from "@/components/ui/confirm";
import { Field, Input, Select } from "@/components/ui/form";
import { Dialog } from "@/components/ui/overlay";
import { useToast } from "@/components/ui/toast";
import { fieldErrors, newCustomerSchema } from "@/domain/validation";
import { priceText } from "@/lib/courses";
import { useRunAction } from "@/lib/run-action";
import { useWorkspace } from "@/lib/workspace";
import { createCustomer } from "@/server/actions";

export function AddCustomerDialog({ onClose }: { onClose: () => void }) {
  const { me, ref, openInquiry } = useWorkspace();
  const toast = useToast();
  const runAction = useRunAction();
  const [form, setForm] = useState({ name: "", phone: "", programId: "", contactType: "student" as "student" | "parent" | "other", studentName: "", phoneSecondary: "", courseId: "" });
  const [assign, setAssign] = useState<string>("queue");
  const [errors, setErrors] = useState<Record<string, string> | null>(null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const dirty = Object.entries(form).some(([k, v]) => v && !(k === "contactType" && v === "student"));
  const close = () => (dirty ? setAsking(true) : onClose());

  const submit = async () => {
    const e = fieldErrors(newCustomerSchema, form);
    setErrors(e);
    if (e) return;
    setBusy(true);
    const r = await runAction(createCustomer(form, me.role === "manager" ? assign : null), null);
    setBusy(false);
    if (!r.ok) return;
    toast.success(
      r.value.queued ? "Customer added. Nobody eligible is on shift, so it waits in the unassigned queue." : assign === "queue" && me.role === "manager" ? `Customer added and assigned to ${ref.profiles.find((x) => x.id === r.value.ownerId)?.fullName ?? "the next agent"}` : r.value.matchedExisting ? "Added and linked to the existing contact with this phone number" : "Customer added",
    );
    onClose();
    openInquiry(r.value.inquiryId);
  };

  return (
    <Dialog open onClose={close} title="Add customer" description="Only name, phone and program are needed to start." footer={<><Button onClick={close}>Cancel</Button><Button variant="primary" disabled={busy} onClick={submit}>{busy ? "Adding…" : "Add customer"}</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" required error={errors?.name} className="sm:col-span-2">
          {(p) => <Input autoFocus value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Arabic or English" {...p} />}
        </Field>
        <Field label="Phone number" required error={errors?.phone} hint="Egyptian numbers can start with 01, +20 or 0020">
          {(p) => <Input type="tel" dir="ltr" value={form.phone} onChange={(e) => set("phone", e.target.value)} placeholder="0100 123 4567" {...p} />}
        </Field>
        <Field label="Program" required error={errors?.programId}>
          {(p) => (
            <Select value={form.programId} onChange={(e) => setForm((f) => ({ ...f, programId: e.target.value, courseId: "" }))} {...p}>
              <option value="">Choose…</option>
              {ref.programs.filter((x) => x.active).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </Select>
          )}
        </Field>
        <Field label="Course (optional)" hint={form.programId ? undefined : "Choose the program first."}>
          {(p) => (
            <Select value={form.courseId} disabled={!form.programId} onChange={(e) => set("courseId", e.target.value)} {...p}>
              <option value="">Not decided yet</option>
              {ref.courses.filter((c) => c.active && c.programId === form.programId).map((c) => (
                <option key={c.id} value={c.id}>{c.name} · {priceText(c)}</option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Contact type">
          {(p) => (
            <Select value={form.contactType} onChange={(e) => set("contactType", e.target.value)} {...p}>
              <option value="student">Student</option>
              <option value="parent">Parent</option>
              <option value="other">Other</option>
            </Select>
          )}
        </Field>
        <Field label="Student name (optional)" error={errors?.studentName} hint="Use it when a parent asks for more than one child">
          {(p) => <Input value={form.studentName} onChange={(e) => set("studentName", e.target.value)} {...p} />}
        </Field>
        <Field label="Additional number (optional)" error={errors?.phoneSecondary}>
          {(p) => <Input type="tel" dir="ltr" value={form.phoneSecondary} onChange={(e) => set("phoneSecondary", e.target.value)} {...p} />}
        </Field>
        {me.role === "manager" ? (
          <Field label="Assign to">
            {(p) => (
              <Select value={assign} onChange={(e) => setAssign(e.target.value)} {...p}>
                <option value="queue">Automatic (next agent on shift)</option>
                {ref.profiles.filter((u) => u.role === "sales" && u.active).map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
              </Select>
            )}
          </Field>
        ) : (
          <p className="self-end text-xs text-muted">The new inquiry will be assigned to you.</p>
        )}
        <p className="text-xs text-muted sm:col-span-2">If this phone number already belongs to a contact, the inquiry is linked to that contact. Nothing is merged.</p>
      </div>
      {asking && <DiscardDialog open onKeep={() => setAsking(false)} onDiscard={onClose} what="this new customer" />}
    </Dialog>
  );
}
