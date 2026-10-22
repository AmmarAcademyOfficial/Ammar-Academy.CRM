"use client";

import { cn as clsx } from "@/components/ui/cn";
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, Lock, Pencil, Plus } from "lucide-react";
import { useState } from "react";
import { Pill } from "@/components/ui/badges";
import { Button, IconButton } from "@/components/ui/button";
import { Checkbox, Field, Input, Select } from "@/components/ui/form";
import { Card, CardHeader } from "@/components/ui/misc";
import { Dialog } from "@/components/ui/overlay";
import { ROLE_LABEL } from "@/domain/permissions";
import type { FieldDefinition, FieldImportance, FieldType, Role, StageKey } from "@/domain/types";
import { fieldDefinitionSchema, fieldErrors } from "@/domain/validation";
import { useRunAction } from "@/lib/run-action";
import { useWorkspace } from "@/lib/workspace";
import { moveField, saveField, setFieldArchived } from "@/server/actions";
import { FieldInput } from "../lead-panel/field-input";

const TYPE_LABEL: Record<FieldType, string> = { text: "Text", phone: "Phone", number: "Number", date: "Date", dropdown: "Dropdown", checkbox: "Checkbox" };
const IMPORTANCE: Record<FieldImportance, [string, string]> = {
  essential: ["Essential", "bg-orange-100 text-orange-ink"],
  standard: ["Standard", "bg-navy-100 text-navy-800"],
  additional: ["Additional", "bg-[#eeeff3] text-[#4b4e66]"],
};
const ROLES: Role[] = ["manager", "sales", "support"];
const SHORT_ROLE: Record<Role, string> = { manager: "Manager", sales: "Sales", support: "Support", accountant: "Accountant" };

/** The protected core fields always exist and are not stored as custom fields. */
const CORE = ["Name", "Main phone", "Program", "Contact type", "Student name", "Additional phone", "Sales owner", "Stage"];

export function FieldsSettings() {
  const { ref: db } = useWorkspace();
  const runAction = useRunAction();
  const [editing, setEditing] = useState<FieldDefinition | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const active = db.fields.filter((f) => !f.archived).sort((a, b) => a.order - b.order);
  const archived = db.fields.filter((f) => f.archived);

  const requiredText = (f: FieldDefinition) => {
    if (f.requiredFrom === "never") return "Optional";
    if (f.requiredFrom === "always") return "Always required";
    return `Required from ${db.stages.find((s) => s.systemKey === f.requiredFrom)?.label}`;
  };

  const blank = (): FieldDefinition => ({
    id: `new-${Date.now()}`,
    key: "",
    label: "",
    type: "text",
    importance: "standard",
    requiredFrom: "never",
    programIds: [],
    visibleTo: ["manager", "sales", "support"],
    editableBy: ["manager", "sales"],
    options: [],
    order: 0,
    archived: false,
    core: false,
  });

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="Customer fields"
          subtitle="Importance controls prominence. Required controls validation. Permissions control who can read or change a value."
          action={<Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => setEditing(blank())}>Add field</Button>}
        />
        <ul className="divide-y divide-line">
          {active.map((f, i) => (
            <li key={f.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
              <div className="flex flex-col">
                <IconButton label={`Move ${f.label} up`} icon={<ArrowUp size={14} />} disabled={i === 0} onClick={() => runAction(moveField(f.id, -1), null, { reference: true })} className="h-6 w-7" />
                <IconButton label={`Move ${f.label} down`} icon={<ArrowDown size={14} />} disabled={i === active.length - 1} onClick={() => runAction(moveField(f.id, 1), null, { reference: true })} className="h-6 w-7" />
              </div>
              <div className="min-w-0 flex-1 basis-48">
                <p className="font-medium">{f.label}</p>
                <p className="text-xs text-muted">
                  {TYPE_LABEL[f.type]} · {requiredText(f)} · {f.programIds.length ? f.programIds.map((p) => db.programs.find((x) => x.id === p)?.code).join(", ") : "All programs"}
                </p>
                <p className="text-xs text-muted">Internal ID <code className="rounded bg-navy-50 px-1">{f.id}</code> never changes</p>
              </div>
              <Pill className={IMPORTANCE[f.importance][1]}>{IMPORTANCE[f.importance][0]}</Pill>
              <span className="w-52 text-xs text-muted">
                Sees: {f.visibleTo.map((r) => SHORT_ROLE[r]).join(", ")}
                <span className="block">Edits: {f.editableBy.length ? f.editableBy.map((r) => SHORT_ROLE[r]).join(", ") : "Nobody"}</span>
              </span>
              <div className="flex gap-1">
                <IconButton label={`Edit ${f.label}`} icon={<Pencil size={15} />} onClick={() => setEditing(structuredClone(f))} />
                <IconButton label={`Archive ${f.label}`} icon={<Archive size={15} />} onClick={() => runAction(setFieldArchived(f.id, true), `${f.label} archived. Stored values are kept.`, { reference: true })} />
              </div>
            </li>
          ))}
        </ul>
        {archived.length > 0 && (
          <div className="border-t border-line px-4 py-3">
            <button className="text-sm font-medium text-navy-700" onClick={() => setShowArchived((s) => !s)} aria-expanded={showArchived}>
              {showArchived ? "Hide" : "Show"} archived fields ({archived.length})
            </button>
            {showArchived && (
              <ul className="mt-2 space-y-2">
                {archived.map((f) => (
                  <li key={f.id} className="flex items-center justify-between rounded-lg bg-canvas px-3 py-2 text-sm">
                    <span>
                      {f.label} <span className="text-xs text-muted">· stored values are kept</span>
                    </span>
                    <Button size="sm" icon={<ArchiveRestore size={14} />} onClick={() => runAction(setFieldArchived(f.id, false), `${f.label} restored`, { reference: true })}>Restore</Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Card>

      <Card className="p-4">
        <p className="flex items-center gap-2 text-sm font-medium"><Lock size={14} aria-hidden /> Protected core fields</p>
        <p className="mt-1 text-sm text-muted">These always exist and cannot be deleted or retyped: {CORE.join(", ")}. System IDs, timestamps, payment records and ownership are also protected.</p>
      </Card>

      {editing && <FieldEditor field={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function FieldEditor({ field, onClose }: { field: FieldDefinition; onClose: () => void }) {
  const { ref: db } = useWorkspace();
  const runAction = useRunAction();
  const isNew = !db.fields.some((f) => f.id === field.id);
  const original = db.fields.find((f) => f.id === field.id);
  const [f, setF] = useState<FieldDefinition>(field);
  const [errors, setErrors] = useState<Record<string, string> | null>(null);
  const [newOption, setNewOption] = useState("");
  const [preview, setPreview] = useState<string | number | boolean | null>(null);
  const set = <K extends keyof FieldDefinition>(k: K, v: FieldDefinition[K]) => setF((x) => ({ ...x, [k]: v }));
  const toggleRole = (list: "visibleTo" | "editableBy", r: Role) => {
    const cur = f[list];
    let next = cur.includes(r) ? cur.filter((x) => x !== r) : [...cur, r];
    let editable = list === "editableBy" ? next : f.editableBy;
    // A role that cannot see a field cannot edit it either.
    if (list === "visibleTo") editable = editable.filter((x) => next.includes(x));
    if (list === "editableBy") next = next.filter((x) => f.visibleTo.includes(x));
    setF((x) => ({ ...x, visibleTo: list === "visibleTo" ? next : x.visibleTo, editableBy: list === "editableBy" ? next : editable }));
  };

  const typeChanged = original && original.type !== f.type;

  const save = async () => {
    const e = fieldErrors(fieldDefinitionSchema, f);
    if (f.type === "dropdown" && !f.options.some((o) => !o.archived)) {
      setErrors({ ...(e ?? {}), options: "Add at least one option" });
      return;
    }
    setErrors(e);
    if (e) return;
    const key = f.key || f.label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    if ((await runAction(saveField({ ...f, key }, isNew), isNew ? "Field added" : "Field saved", { reference: true })).ok) onClose();
  };

  const stageOptions: (StageKey | "never" | "always")[] = ["never", "always", ...db.stages.filter((s) => !s.isClosed).map((s) => s.systemKey)];

  return (
    <Dialog
      open
      onClose={onClose}
      title={isNew ? "Add field" : `Edit field · ${original?.label}`}
      description="Renaming or reordering never breaks stored values or Google Sheets mappings; both use the field’s internal ID."
      className="max-w-2xl"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>{isNew ? "Add field" : "Save field"}</Button></>}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Display label" required error={errors?.label}>
          {(p) => <Input value={f.label} onChange={(e) => set("label", e.target.value)} {...p} />}
        </Field>
        <Field label="Type" hint={typeChanged ? "Existing values are checked when you save. If any would not convert, nothing changes." : undefined}>
          {(p) => (
            <Select value={f.type} onChange={(e) => set("type", e.target.value as FieldType)} {...p}>
              {Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          )}
        </Field>
        <Field label="Importance" hint="Essential fields show first and stand out">
          {(p) => (
            <Select value={f.importance} onChange={(e) => set("importance", e.target.value as FieldImportance)} {...p}>
              <option value="essential">Essential</option>
              <option value="standard">Standard</option>
              <option value="additional">Additional (collapsed)</option>
            </Select>
          )}
        </Field>
        <Field label="Required" hint="Checked when creating or moving to that stage. Older records can still be edited.">
          {(p) => (
            <Select value={f.requiredFrom} onChange={(e) => set("requiredFrom", e.target.value as FieldDefinition["requiredFrom"])} {...p}>
              {stageOptions.map((k) => (
                <option key={k} value={k}>
                  {k === "never" ? "Optional" : k === "always" ? "Always required" : `From stage: ${db.stages.find((s) => s.systemKey === k)?.label}`}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <fieldset className="sm:col-span-2">
          <legend className="mb-2 text-[13px] font-medium">Show for programs</legend>
          <div className="flex flex-wrap gap-4">
            <Checkbox label="All programs" checked={f.programIds.length === 0} onChange={() => set("programIds", [])} />
            {db.programs.map((p) => (
              <Checkbox key={p.id} label={`${p.name} only`} checked={f.programIds.includes(p.id)} onChange={(v) => set("programIds", v ? [...f.programIds, p.id] : f.programIds.filter((x) => x !== p.id))} />
            ))}
          </div>
        </fieldset>

        <fieldset className="sm:col-span-2">
          <legend className="mb-2 text-[13px] font-medium">Permissions by role</legend>
          <div className="overflow-hidden rounded-lg border border-line">
            <table className="w-full text-sm">
              <thead><tr className="bg-canvas text-left text-xs text-muted"><th className="px-3 py-2 font-medium">Role</th><th className="px-3 py-2 font-medium">Can see</th><th className="px-3 py-2 font-medium">Can edit</th></tr></thead>
              <tbody>
                {ROLES.map((r) => (
                  <tr key={r} className="border-t border-line">
                    <td className="px-3 py-2">{ROLE_LABEL[r]}</td>
                    <td className="px-3 py-2"><input type="checkbox" aria-label={`${ROLE_LABEL[r]} can see`} checked={f.visibleTo.includes(r)} disabled={r === "manager"} onChange={() => toggleRole("visibleTo", r)} className="h-4 w-4 accent-navy-900" /></td>
                    <td className="px-3 py-2"><input type="checkbox" aria-label={`${ROLE_LABEL[r]} can edit`} checked={f.editableBy.includes(r)} disabled={!f.visibleTo.includes(r)} onChange={() => toggleRole("editableBy", r)} className="h-4 w-4 accent-navy-900" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {errors?.visibleTo && <p className="mt-1 text-xs text-bad">{errors.visibleTo}</p>}
        </fieldset>

        {f.type === "dropdown" && (
          <fieldset className="sm:col-span-2">
            <legend className="mb-2 text-[13px] font-medium">Options</legend>
            <ul className="space-y-1.5">
              {f.options.map((o, i) => (
                <li key={o.id} className="flex items-center gap-2">
                  <Input aria-label={`Option ${i + 1}`} value={o.label} disabled={o.archived} onChange={(e) => set("options", f.options.map((x) => (x.id === o.id ? { ...x, label: e.target.value } : x)))} className={clsx("h-9", o.archived && "line-through")} />
                  <Button size="sm" onClick={() => set("options", f.options.map((x) => (x.id === o.id ? { ...x, archived: !x.archived } : x)))}>
                    {o.archived ? "Restore" : "Archive"}
                  </Button>
                </li>
              ))}
            </ul>
            <div className="mt-2 flex gap-2">
              <Input aria-label="New option" value={newOption} onChange={(e) => setNewOption(e.target.value)} placeholder="New option" className="h-9" />
              <Button size="sm" onClick={() => { if (newOption.trim()) { set("options", [...f.options, { id: `new-${Date.now()}`, label: newOption.trim(), archived: false }]); setNewOption(""); } }}>Add</Button>
            </div>
            <p className="mt-1 text-xs text-muted">Archived options stay readable on older records but cannot be picked.</p>
            {errors?.options && <p className="mt-1 text-xs text-bad">{errors.options}</p>}
          </fieldset>
        )}

        <div className="rounded-lg border border-dashed border-line p-3 sm:col-span-2">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Preview</p>
          <Field label={f.label || "Field label"} required={f.requiredFrom === "always"}>
            {(p) => <FieldInput field={f} value={preview} onChange={setPreview} {...p} />}
          </Field>
        </div>
      </div>
    </Dialog>
  );
}
