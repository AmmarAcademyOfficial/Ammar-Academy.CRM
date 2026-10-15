"use client";

import { Input, Select } from "@/components/ui/form";
import type { FieldDefinition, FieldValue } from "@/domain/types";

/** Renders the right control for a custom field type. Used by forms and the field settings preview. */
export function FieldInput({ field, value, onChange, id, disabled, ...aria }: { field: FieldDefinition; value: FieldValue | undefined; onChange: (v: FieldValue) => void; id?: string; disabled?: boolean; "aria-invalid"?: boolean; "aria-describedby"?: string }) {
  switch (field.type) {
    case "checkbox":
      return (
        <label className="inline-flex h-10 items-center gap-2 text-sm">
          <input id={id} type="checkbox" disabled={disabled} checked={value === true} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 accent-navy-900" {...aria} />
          {value === true ? "Yes" : "No"}
        </label>
      );
    case "dropdown":
      return (
        <Select id={id} disabled={disabled} value={String(value ?? "")} onChange={(e) => onChange(e.target.value || null)} {...aria}>
          <option value="">Not set</option>
          {field.options
            .filter((o) => !o.archived || o.id === value)
            .map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
                {o.archived ? " (archived)" : ""}
              </option>
            ))}
        </Select>
      );
    case "number":
      return <Input id={id} disabled={disabled} inputMode="decimal" value={value === null || value === undefined ? "" : String(value)} onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} {...aria} />;
    case "date":
      return <Input id={id} disabled={disabled} type="date" value={String(value ?? "")} onChange={(e) => onChange(e.target.value || null)} {...aria} />;
    case "phone":
      return <Input id={id} disabled={disabled} type="tel" dir="ltr" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} {...aria} />;
    default:
      return <Input id={id} disabled={disabled} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} {...aria} />;
  }
}

/** Read-only display of a stored value. Archived options remain readable. */
export function fieldDisplay(field: FieldDefinition, value: FieldValue | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  if (field.type === "checkbox") return value ? "Yes" : "No";
  if (field.type === "dropdown") {
    const o = field.options.find((x) => x.id === value);
    return o ? `${o.label}${o.archived ? " (archived option)" : ""}` : String(value);
  }
  return String(value);
}
