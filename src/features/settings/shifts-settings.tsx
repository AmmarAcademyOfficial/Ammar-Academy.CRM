"use client";

import { ArrowDown, ArrowUp, CalendarOff, Copy, Moon, Plus, Trash2, Users } from "lucide-react";
import { useState } from "react";
import { Pill } from "@/components/ui/badges";
import { Button, IconButton } from "@/components/ui/button";
import { cn as clsx } from "@/components/ui/cn";
import { Checkbox, Field, Input, Select, Toggle } from "@/components/ui/form";
import { Avatar, Card, CardHeader, SkeletonRows } from "@/components/ui/misc";
import { Dialog } from "@/components/ui/overlay";
import type { DistributionData, EligibilityRow, ShiftDTO } from "@/domain/dto";
import { INELIGIBLE_LABEL, formatCairo } from "@/domain/rules";
import type { Profile, Settings } from "@/domain/types";
import { useRunAction } from "@/lib/run-action";
import { useApi, useWorkspace } from "@/lib/workspace";
import { updateSettings } from "@/server/actions";
import { addTimeOff, copyShifts, deleteShift, removeTimeOff, saveShifts, setRotationOrder } from "@/server/distribution-actions";

export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function shiftLabel(s: Pick<ShiftDTO, "start" | "end">): string {
  if (s.start === "00:00" && s.end === "00:00") return "All day";
  if (s.end === "00:00") return `${s.start}–midnight`;
  return s.end <= s.start ? `${s.start}–${s.end} (+1 day)` : `${s.start}–${s.end}`;
}

/** One agent's status for one program, in words (never color alone). */
export function EligibilityPill({ row }: { row: EligibilityRow | undefined }) {
  if (!row) return <span className="text-muted">—</span>;
  if (!row.reason) return <Pill className="bg-ok-bg text-ok">Receiving{row.onShiftUntil ? ` · until ${row.onShiftUntil === "00:00" ? "midnight" : row.onShiftUntil}` : ""}</Pill>;
  const tone = row.reason === "paused" || row.reason === "at_capacity" ? "bg-warn-bg text-warn" : "bg-[#eeeff3] text-[#4b4e66]";
  return <Pill className={tone}>{INELIGIBLE_LABEL[row.reason]}</Pill>;
}

export function ShiftsSettings() {
  const { ref } = useWorkspace();
  const runAction = useRunAction();
  const { data } = useApi<DistributionData>("/api/distribution");
  const set = (patch: Partial<Settings>) => runAction(updateSettings(patch), "Setting saved", { reference: true });
  const agents = ref.profiles.filter((p) => p.role === "sales" && p.active).sort((a, b) => a.rotationOrder - b.rotationOrder);

  return (
    <div className="space-y-5">
      <Card className="p-4">
        <div className="flex flex-col gap-3">
          <label className="flex items-center justify-between gap-4 text-sm">
            <span>Agents can pause themselves<span className="block text-xs text-muted">A pause is logged and ends automatically when the agent&apos;s shift ends. Their current leads stay with them.</span></span>
            <Toggle label="Agents can pause themselves" checked={ref.settings.agentsCanPause} onChange={(v) => set({ agentsCanPause: v })} />
          </label>
          <label className="flex items-center justify-between gap-4 text-sm">
            <span>Limit open leads per agent<span className="block text-xs text-muted">Set each agent&apos;s limit in Users and Roles. Agents at their limit are skipped until they close leads.</span></span>
            <Toggle label="Limit open leads per agent" checked={ref.settings.perAgentLeadCapEnabled} onChange={(v) => set({ perAgentLeadCapEnabled: v })} />
          </label>
        </div>
      </Card>

      {!data ? <Card><SkeletonRows rows={4} /></Card> : (
        <>
          <EligibleNow data={data} agents={agents} />
          <WeeklyShifts data={data} agents={agents} />
          <RotationOrder data={data} agents={agents} />
          <Leave data={data} agents={agents} />
        </>
      )}
    </div>
  );
}

function EligibleNow({ data, agents }: { data: DistributionData; agents: Profile[] }) {
  const { ref, now } = useWorkspace();
  const programs = ref.programs.filter((p) => p.active);
  return (
    <Card>
      <CardHeader title="Who receives new leads right now" subtitle={`Cairo time ${formatCairo(now.toISOString(), "time")}. Updates every minute.`} />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-muted">
              <th className="px-4 py-2 font-medium">Agent</th>
              {programs.map((p) => <th key={p.id} className="px-3 py-2 font-medium">{p.code}</th>)}
              <th className="px-3 py-2 text-right font-medium">Open leads</th>
            </tr>
          </thead>
          <tbody>
            {agents.map((a) => {
              const rows = data.eligibility.filter((e) => e.userId === a.id);
              return (
                <tr key={a.id} className="border-b border-line/70 last:border-0">
                  <td className="px-4 py-2.5"><span className="flex items-center gap-2"><Avatar name={a.fullName} size={24} />{a.fullName}</span></td>
                  {programs.map((p) => <td key={p.id} className="px-3 py-2.5"><EligibilityPill row={rows.find((r) => r.programId === p.id)} /></td>)}
                  <td className="px-3 py-2.5 text-right tabular-nums">{rows[0]?.openLeads ?? 0}{a.maxOpenLeads && ref.settings.perAgentLeadCapEnabled ? <span className="text-muted"> / {a.maxOpenLeads}</span> : null}</td>
                </tr>
              );
            })}
            {agents.length === 0 && <tr><td className="px-4 py-4 text-muted" colSpan={programs.length + 2}>No active sales agents.</td></tr>}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function WeeklyShifts({ data, agents }: { data: DistributionData; agents: Profile[] }) {
  const { ref } = useWorkspace();
  const [editing, setEditing] = useState<Partial<ShiftDTO> & { userId: string } | null>(null);
  const [copyFrom, setCopyFrom] = useState<Profile | null>(null);
  const code = (id: string) => ref.programs.find((p) => p.id === id)?.code ?? "?";
  return (
    <Card>
      <CardHeader
        title="Weekly shifts"
        subtitle="Cairo time. A shift that ends at or before its start time runs past midnight. Only agents on shift for a program receive its leads."
        action={agents[0] && <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => setEditing({ userId: agents[0].id })}>Add shift</Button>}
      />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-muted">
              <th className="px-4 py-2 font-medium">Agent</th>
              {WEEKDAYS.map((d) => <th key={d} className="px-2 py-2 font-medium">{d}</th>)}
              <th className="px-2 py-2"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {agents.map((a) => (
              <tr key={a.id} className="border-b border-line/70 align-top last:border-0">
                <td className="px-4 py-2.5 font-medium">{a.fullName}</td>
                {WEEKDAYS.map((_, day) => (
                  <td key={day} className="px-1.5 py-2">
                    <div className="flex flex-col gap-1">
                      {data.shifts.filter((s) => s.userId === a.id && s.weekday === day).map((s) => (
                        <button
                          key={s.id}
                          onClick={() => setEditing(s)}
                          className="rounded-md border border-navy-100 bg-navy-50 px-1.5 py-1 text-left text-[11px] leading-tight hover:border-navy-600/40"
                        >
                          <span className="sr-only">Edit {a.fullName}&apos;s {WEEKDAYS[day]} shift: </span>
                          <span className="flex items-center gap-1 font-medium">{s.end <= s.start && s.end !== "00:00" && <Moon size={10} aria-hidden />}{shiftLabel(s)}</span>
                          <span className="text-muted">{s.programIds.map(code).join(" · ")}</span>
                        </button>
                      ))}
                    </div>
                  </td>
                ))}
                <td className="px-2 py-2">
                  <div className="flex gap-1">
                    <IconButton label={`Add shift for ${a.fullName}`} icon={<Plus size={14} />} onClick={() => setEditing({ userId: a.id })} />
                    <IconButton label={`Copy ${a.fullName}'s shifts to others`} icon={<Copy size={14} />} onClick={() => setCopyFrom(a)} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && <ShiftDialog shift={editing} agents={agents} onClose={() => setEditing(null)} />}
      {copyFrom && <CopyDialog from={copyFrom} agents={agents} onClose={() => setCopyFrom(null)} />}
    </Card>
  );
}

function ShiftDialog({ shift, agents, onClose }: { shift: Partial<ShiftDTO> & { userId: string }; agents: Profile[]; onClose: () => void }) {
  const { ref } = useWorkspace();
  const runAction = useRunAction();
  const programs = ref.programs.filter((p) => p.active);
  const [form, setForm] = useState({
    userId: shift.userId,
    weekdays: shift.weekday !== undefined ? [shift.weekday] : [0, 1, 2, 3, 4],
    start: shift.start ?? "09:00",
    end: shift.end ?? "17:00",
    programIds: shift.programIds ?? programs.map((p) => p.id),
  });
  const isEdit = Boolean(shift.id);
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const save = async () => {
    const r = await runAction(saveShifts({ id: shift.id, ...form }), isEdit ? "Shift saved" : form.weekdays.length > 1 ? `${form.weekdays.length} shifts added` : "Shift added");
    if (r.ok) onClose();
  };
  const overnight = form.end <= form.start && !(form.start === "00:00" && form.end === "00:00");
  return (
    <Dialog
      open
      onClose={onClose}
      title={isEdit ? "Edit shift" : "Add shifts"}
      description="Cairo time, daylight saving included."
      footer={
        <>
          {isEdit && <Button variant="danger" className="mr-auto" icon={<Trash2 size={14} />} onClick={async () => { const r = await runAction(deleteShift(shift.id!), "Shift deleted"); if (r.ok) onClose(); }}>Delete</Button>}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save}>Save</Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Agent" required>
          {(p) => <Select value={form.userId} onChange={(e) => setForm({ ...form, userId: e.target.value })} {...p}>{agents.map((a) => <option key={a.id} value={a.id}>{a.fullName}</option>)}</Select>}
        </Field>
        <fieldset>
          <legend className="mb-1.5 text-[13px] font-medium">{isEdit ? "Day" : "Days"}</legend>
          <div className="flex flex-wrap gap-1.5">
            {WEEKDAYS.map((d, i) => {
              const on = form.weekdays.includes(i);
              return (
                <button key={d} type="button" aria-pressed={on}
                  onClick={() => setForm({ ...form, weekdays: isEdit ? [i] : toggle(form.weekdays, i) })}
                  className={clsx("h-9 w-12 rounded-lg border text-sm", on ? "border-navy-900 bg-navy-900 text-white" : "border-line hover:bg-navy-50")}>{d}</button>
              );
            })}
          </div>
        </fieldset>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Starts" required>{(p) => <Input type="time" step={900} value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} {...p} />}</Field>
          <Field label="Ends" required hint={overnight ? (form.end === "00:00" ? "Ends at midnight." : "Runs past midnight into the next day.") : undefined}>
            {(p) => <Input type="time" step={900} value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} {...p} />}
          </Field>
        </div>
        <fieldset>
          <legend className="mb-1.5 text-[13px] font-medium">Programs during this shift</legend>
          <div className="flex flex-wrap gap-4">
            {programs.map((p) => <Checkbox key={p.id} label={`${p.code} · ${p.name}`} checked={form.programIds.includes(p.id)} onChange={() => setForm({ ...form, programIds: toggle(form.programIds, p.id) })} />)}
          </div>
        </fieldset>
      </div>
    </Dialog>
  );
}

function CopyDialog({ from, agents, onClose }: { from: Profile; agents: Profile[]; onClose: () => void }) {
  const runAction = useRunAction();
  const [to, setTo] = useState<string[]>([]);
  return (
    <Dialog open onClose={onClose} title={`Copy ${from.fullName}'s shifts`} description="The chosen agents' current shifts are replaced by this schedule."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={to.length === 0} onClick={async () => { const r = await runAction(copyShifts(from.id, to), "Shifts copied"); if (r.ok) onClose(); }}>Copy shifts</Button></>}>
      <div className="space-y-2">
        {agents.filter((a) => a.id !== from.id).map((a) => (
          <Checkbox key={a.id} label={a.fullName} checked={to.includes(a.id)} onChange={(v) => setTo(v ? [...to, a.id] : to.filter((x) => x !== a.id))} />
        ))}
      </div>
    </Dialog>
  );
}

function RotationOrder({ data, agents }: { data: DistributionData; agents: Profile[] }) {
  const { ref } = useWorkspace();
  const runAction = useRunAction();
  const allSales = ref.profiles.filter((p) => p.role === "sales").sort((a, b) => a.rotationOrder - b.rotationOrder);
  const move = (id: string, dir: -1 | 1) => {
    const ids = allSales.map((p) => p.id);
    const i = ids.indexOf(id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    runAction(setRotationOrder(ids), "Rotation order saved", { reference: true });
  };
  return (
    <Card>
      <CardHeader title="Round-robin order" subtitle="Each program's next lead goes to the next agent in this order who is eligible. Skipped agents keep their place; manual reassignments don't change the turn." />
      <ol className="divide-y divide-line">
        {agents.map((a, i) => (
          <li key={a.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
            <span className="w-5 text-xs tabular-nums text-muted">{i + 1}.</span>
            <Avatar name={a.fullName} size={24} />
            <span className="mr-auto">{a.fullName}</span>
            {data.rotation.filter((r) => r.lastUserId === a.id).map((r) => (
              <span key={r.programId} className="text-xs text-muted">Last {ref.programs.find((p) => p.id === r.programId)?.code} lead</span>
            ))}
            <IconButton label={`Move ${a.fullName} up`} icon={<ArrowUp size={14} />} disabled={i === 0} onClick={() => move(a.id, -1)} />
            <IconButton label={`Move ${a.fullName} down`} icon={<ArrowDown size={14} />} disabled={i === agents.length - 1} onClick={() => move(a.id, 1)} />
          </li>
        ))}
      </ol>
    </Card>
  );
}

function Leave({ data, agents }: { data: DistributionData; agents: Profile[] }) {
  const { ref } = useWorkspace();
  const runAction = useRunAction();
  const [adding, setAdding] = useState(false);
  const name = (id: string) => ref.profiles.find((p) => p.id === id)?.fullName ?? "—";
  return (
    <Card>
      <CardHeader title="Leave and days off" subtitle="Agents on leave receive no new leads on those Cairo calendar days." action={<Button size="sm" icon={<CalendarOff size={14} />} onClick={() => setAdding(true)}>Add leave</Button>} />
      <ul className="divide-y divide-line">
        {data.timeOff.map((t) => (
          <li key={t.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
            <Users size={14} className="text-muted" aria-hidden />
            <span className="font-medium">{name(t.userId)}</span>
            <span className="text-muted">{t.startsOn === t.endsOn ? formatCairo(t.startsOn, "date") : `${formatCairo(t.startsOn, "date")} – ${formatCairo(t.endsOn, "date")}`}</span>
            {t.reason && <span className="truncate text-muted">· {t.reason}</span>}
            <IconButton className="ml-auto" label={`Remove leave for ${name(t.userId)}`} icon={<Trash2 size={14} />} onClick={() => runAction(removeTimeOff(t.id), "Leave removed")} />
          </li>
        ))}
        {data.timeOff.length === 0 && <li className="px-4 py-4 text-sm text-muted">No leave planned.</li>}
      </ul>
      {adding && <LeaveDialog agents={agents} onClose={() => setAdding(false)} />}
    </Card>
  );
}

function LeaveDialog({ agents, onClose }: { agents: Profile[]; onClose: () => void }) {
  const runAction = useRunAction();
  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({ userId: agents[0]?.id ?? "", startsOn: today, endsOn: today, reason: "" });
  return (
    <Dialog open onClose={onClose} title="Add leave"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={async () => { const r = await runAction(addTimeOff(form.userId, form.startsOn, form.endsOn, form.reason), "Leave added"); if (r.ok) onClose(); }}>Save</Button></>}>
      <div className="space-y-4">
        <Field label="Agent" required>{(p) => <Select value={form.userId} onChange={(e) => setForm({ ...form, userId: e.target.value })} {...p}>{agents.map((a) => <option key={a.id} value={a.id}>{a.fullName}</option>)}</Select>}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="From" required>{(p) => <Input type="date" value={form.startsOn} onChange={(e) => setForm({ ...form, startsOn: e.target.value, endsOn: e.target.value > form.endsOn ? e.target.value : form.endsOn })} {...p} />}</Field>
          <Field label="To (inclusive)" required>{(p) => <Input type="date" min={form.startsOn} value={form.endsOn} onChange={(e) => setForm({ ...form, endsOn: e.target.value })} {...p} />}</Field>
        </div>
        <Field label="Reason (optional)">{(p) => <Input value={form.reason} maxLength={200} onChange={(e) => setForm({ ...form, reason: e.target.value })} {...p} />}</Field>
      </div>
    </Dialog>
  );
}
