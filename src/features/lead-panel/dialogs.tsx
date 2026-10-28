"use client";

import { useState } from "react";
import { TAG_COLORS, TagChip } from "@/components/ui/badges";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/form";
import { matches, SEARCH_FROM } from "@/components/ui/search-text";
import { Dialog } from "@/components/ui/overlay";
import { useToast } from "@/components/ui/toast";
import { can } from "@/domain/permissions";
import { CAIRO_TZ } from "@/domain/rules";
import type { ID, Inquiry, TagColor } from "@/domain/types";
import { fieldErrors, followUpSchema } from "@/domain/validation";
import { useRunAction } from "@/lib/run-action";
import { useWorkspace } from "@/lib/workspace";
import { createFollowUp, createTag, reassign, recordAttempt, setDoNotContact, setTags } from "@/server/actions";

/** "YYYY-MM-DDTHH:MM" for a datetime-local input, in Cairo time. */
export function cairoLocalInput(d: Date): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: CAIRO_TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** Interprets a datetime-local value as Cairo wall-clock time and returns UTC ISO. */
export function fromCairoLocal(value: string): string {
  const guess = new Date(value + "Z");
  const shown = cairoLocalInput(guess);
  const offsetMs = new Date(shown + "Z").getTime() - guess.getTime();
  return new Date(guess.getTime() - offsetMs).toISOString();
}

export function FollowUpDialog({ onClose, inquiryId }: { onClose: () => void; inquiryId: ID }) {
  const runAction = useRunAction();
  const [when, setWhen] = useState(() => cairoLocalInput(new Date(Date.now() + 2 * 3600_000)));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string> | null>(null);
  const quick = (hours: number, label: string) => (
    <button type="button" className="rounded-md border border-line px-2.5 py-1 text-xs hover:bg-navy-50" onClick={() => setWhen(cairoLocalInput(new Date(Date.now() + hours * 3600_000)))}>
      {label}
    </button>
  );
  const submit = async () => {
    const e = fieldErrors(followUpSchema, { dueAt: when, note });
    setErrors(e);
    if (e) return;
    setBusy(true);
    const r = await runAction(createFollowUp(inquiryId, fromCairoLocal(when), note), "Follow-up scheduled");
    setBusy(false);
    if (r.ok) onClose();
  };
  return (
    <Dialog open onClose={onClose} title="Set follow-up" description="Times are in Cairo time." footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy} onClick={submit}>Save follow-up</Button></>}>
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {quick(1, "In 1 hour")}
          {quick(3, "In 3 hours")}
          {quick(24, "Tomorrow")}
          {quick(72, "In 3 days")}
        </div>
        <Field label="Date and time" required error={errors?.dueAt}>
          {(p) => <Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} {...p} />}
        </Field>
        <Field label="What to do" required error={errors?.note}>
          {(p) => <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Call back after school" {...p} />}
        </Field>
      </div>
    </Dialog>
  );
}

export function RecordOutcomeDialog({ onClose, inquiryId, channel }: { onClose: () => void; inquiryId: ID; channel?: "call" | "whatsapp" }) {
  const { ref } = useWorkspace();
  const toast = useToast();
  const runAction = useRunAction();
  const [outcomeId, setOutcomeId] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!outcomeId) return toast.error("Choose what happened.");
    setBusy(true);
    const r = await runAction(recordAttempt(inquiryId, outcomeId, note), "Contact attempt recorded");
    setBusy(false);
    if (r.ok) onClose();
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="Record contact attempt"
      description={channel ? `You opened ${channel === "call" ? "the call" : "WhatsApp"}. What actually happened?` : "Record what happened when you contacted this customer."}
      footer={<><Button onClick={onClose}>Not now</Button><Button variant="primary" disabled={busy} onClick={submit}>Save outcome</Button></>}
    >
      <fieldset>
        <legend className="mb-2 text-[13px] font-medium">Outcome <span className="text-bad">*</span></legend>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {ref.outcomes.map((o) => (
            <label key={o.id} className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2.5 text-sm ${outcomeId === o.id ? "border-navy-900 bg-navy-50 font-medium" : "border-line hover:bg-navy-50"}`}>
              <input type="radio" name="outcome" value={o.id} checked={outcomeId === o.id} onChange={() => setOutcomeId(o.id)} className="accent-navy-900" />
              {o.label}
            </label>
          ))}
        </div>
      </fieldset>
      <Field label="Comment (optional)" className="mt-4">
        {(p) => <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Arabic or English" {...p} />}
      </Field>
    </Dialog>
  );
}

export function LostDialog({ onClose, onConfirm }: { onClose: () => void; onConfirm: (reason: string) => void }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string>();
  const presets = ["Budget", "Chose another provider", "Not interested now", "Timing does not fit", "No response after several attempts"];
  return (
    <Dialog
      open
      onClose={onClose}
      title="Close as Lost"
      description="A reason is required. It appears in the Lost reasons report."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="danger" onClick={() => (reason.trim() ? onConfirm(reason) : setError("Add a reason"))}>Close as Lost</Button></>}
    >
      <div className="mb-3 flex flex-wrap gap-2">
        {presets.map((p) => (
          <button key={p} type="button" onClick={() => setReason(p)} className={`rounded-md border px-2.5 py-1 text-xs ${reason === p ? "border-navy-900 bg-navy-50" : "border-line hover:bg-navy-50"}`}>{p}</button>
        ))}
      </div>
      <Field label="Reason" required error={error}>
        {(p) => <Input value={reason} onChange={(e) => setReason(e.target.value)} {...p} />}
      </Field>
    </Dialog>
  );
}

export function TagsDialog({ onClose, inquiry }: { onClose: () => void; inquiry: Inquiry }) {
  const { me, ref } = useWorkspace();
  const runAction = useRunAction();
  const [selected, setSelected] = useState<ID[]>(inquiry.tagIds);
  const [primary, setPrimary] = useState<ID | undefined>(inquiry.primaryTagId);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState<TagColor>("green");
  const [tagQ, setTagQ] = useState("");
  const canCreate = can(me.role, "tag.create", { agentsCanCreateTags: ref.settings.agentsCanCreateTags });
  const toggle = (id: ID) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const usable = ref.tags.filter((t) => !t.archived || inquiry.tagIds.includes(t.id));
  const save = async () => {
    const r = await runAction(setTags(inquiry.id, selected, primary && selected.includes(primary) ? primary : undefined), "Tags updated");
    if (r.ok) onClose();
  };
  return (
    <Dialog open onClose={onClose} title="Tags" description="Pick any tags. One can be the primary label, shown as a colored accent on the row." footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>Save tags</Button></>}>
      {usable.length >= SEARCH_FROM && (
        <Input type="search" aria-label="Search Tags" placeholder="Search tags" value={tagQ} onChange={(e) => setTagQ(e.target.value)} className="mb-2 h-9" />
      )}
      <ul className="divide-y divide-line rounded-lg border border-line">
        {usable.filter((t) => selected.includes(t.id) || matches(t.name, tagQ)).map((t) => (
          <li key={t.id} className="flex items-center gap-3 px-3 py-2">
            <Checkbox label={<TagChip tag={t} />} checked={selected.includes(t.id)} onChange={() => toggle(t.id)} />
            <label className="ml-auto flex items-center gap-1.5 text-xs text-muted">
              <input type="radio" name="primary" disabled={!selected.includes(t.id)} checked={primary === t.id} onChange={() => setPrimary(t.id)} className="accent-navy-900" />
              Primary
            </label>
          </li>
        ))}
      </ul>
      {primary && <button className="mt-2 text-xs font-medium text-navy-700 hover:underline" onClick={() => setPrimary(undefined)}>Remove primary label</button>}
      <p className="mt-3 text-xs text-muted">A tag or color never confirms a payment. Payments are verified only by a manager.</p>
      {canCreate ? (
        <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-line pt-4">
          <Field label="New tag" className="flex-1">{(p) => <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Tag name" {...p} />}</Field>
          <Field label="Color">
            {(p) => (
              <Select value={newColor} onChange={(e) => setNewColor(e.target.value as TagColor)} {...p}>
                {Object.entries(TAG_COLORS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </Select>
            )}
          </Field>
          <Button
            onClick={async () => {
              const r = await runAction(createTag(newName, newColor), "Tag created", { reference: true });
              if (r.ok) {
                setSelected((s) => [...s, r.value]);
                setNewName("");
              }
            }}
          >
            Add
          </Button>
        </div>
      ) : (
        <p className="mt-3 text-xs text-muted">Only managers can create new tags.</p>
      )}
    </Dialog>
  );
}

export function DncDialog({ onClose, inquiryId }: { onClose: () => void; inquiryId: ID }) {
  const runAction = useRunAction();
  const [reason, setReason] = useState("");
  return (
    <Dialog
      open
      onClose={onClose}
      title="Mark as Do Not Contact"
      description="Call and WhatsApp shortcuts are disabled, open follow-ups are cancelled, and the customer leaves outreach lists. Only a manager can remove this."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="danger" onClick={async () => (await runAction(setDoNotContact(inquiryId, true, reason), "Marked Do Not Contact")).ok && onClose()}>Mark Do Not Contact</Button></>}
    >
      <Field label="Reason" required>{(p) => <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Asked not to be called" {...p} />}</Field>
    </Dialog>
  );
}

export function ReassignDialog({ onClose, inquiryId, currentOwner }: { onClose: () => void; inquiryId: ID; currentOwner: ID | null }) {
  const { ref } = useWorkspace();
  const runAction = useRunAction();
  const people = ref.profiles.filter((p) => p.active && p.role === "sales" && p.id !== currentOwner);
  const [to, setTo] = useState(people[0]?.id ?? "");
  const [reason, setReason] = useState("");
  return (
    <Dialog
      open
      onClose={onClose}
      title={currentOwner ? "Reassign sales owner" : "Assign sales owner"}
      description="The change and reason are saved in the timeline and audit history. Open follow-ups move with the lead."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!to} onClick={async () => (await runAction(reassign(inquiryId, to, reason), "Owner changed")).ok && onClose()}>{currentOwner ? "Reassign" : "Assign"}</Button></>}
    >
      {people.length === 0 ? (
        <p className="text-sm text-muted">There is no other active sales agent. Invite one in Settings → Users and Roles.</p>
      ) : (
        <div className="space-y-4">
          <Field label="New owner" required>
            {(p) => (
              <Select value={to} onChange={(e) => setTo(e.target.value)} {...p}>
                {people.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Reason" required>{(p) => <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Agent on leave" {...p} />}</Field>
        </div>
      )}
    </Dialog>
  );
}
