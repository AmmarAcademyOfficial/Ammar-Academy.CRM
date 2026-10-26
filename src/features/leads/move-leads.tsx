"use client";

import { AlertTriangle, ArrowRightLeft } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn as clsx } from "@/components/ui/cn";
import { Checkbox, Field, Input, Select } from "@/components/ui/form";
import { Dialog } from "@/components/ui/overlay";
import type { LeadPage } from "@/domain/dto";
import { EMPTY_FILTERS } from "@/domain/filters";
import type { LeadFilters, StageKey } from "@/domain/types";
import { useToast } from "@/components/ui/toast";
import { useRunAction } from "@/lib/run-action";
import { useApi, useWorkspace } from "@/lib/workspace";
import { moveLeads, swapLeads, type MoveResult } from "@/server/move-actions";

export const OPEN_STAGES: StageKey[] = ["new", "contacting", "qualified", "awaiting_payment"];
export const MAX_MOVE = 500;
type Mode = "to" | "share" | "queue" | "swap";

const leadsUrl = (f: LeadFilters, pageSize = 5) =>
  `/api/leads?q=${encodeURIComponent(JSON.stringify({ filters: f, sort: { key: "created", dir: "asc" }, page: 0, pageSize }))}`;
export const idsUrl = (f: LeadFilters) => `/api/leads/ids?f=${encodeURIComponent(JSON.stringify(f))}`;

function useSalesAgents() {
  const { ref } = useWorkspace();
  return ref.profiles.filter((p) => p.role === "sales" && p.active).sort((a, b) => a.fullName.localeCompare(b.fullName));
}

/** "Youssef has 18 open leads (cap 20)": warns when the move takes an agent over their cap. */
function AgentLoad({ agentId, adding }: { agentId: string; adding: number }) {
  const { ref } = useWorkspace();
  const agent = ref.profiles.find((p) => p.id === agentId);
  const { data } = useApi<LeadPage>(leadsUrl({ ...EMPTY_FILTERS, ownerIds: [agentId], stageKeys: OPEN_STAGES }));
  if (!agent || !data) return null;
  const after = data.total + adding;
  const over = agent.maxOpenLeads !== null && after > agent.maxOpenLeads;
  return (
    <li className={clsx("flex items-center gap-1.5", over && "text-warn")} data-agent-load={agent.fullName}>
      {over && <AlertTriangle size={13} aria-hidden />}
      <span>{agent.fullName}: {data.total} open now{adding ? `, about ${after} after` : ""}{agent.maxOpenLeads !== null ? ` (cap ${agent.maxOpenLeads})` : ""}{over ? " — over the cap" : ""}</span>
    </li>
  );
}

const overCapText = (r: MoveResult) => {
  const over = r.agents.filter((a) => a.cap !== null && a.open > a.cap);
  return over.length ? `. ${over.map((a) => `${a.name} now has ${a.open} open leads (cap ${a.cap})`).join("; ")}` : "";
};
export const resultText = (r: MoveResult) => {
  const parts = [r.moved ? `${r.moved} lead${r.moved === 1 ? "" : "s"} moved` : "", r.queued ? `${r.queued} returned to the queue` : "", r.skipped ? `${r.skipped} already with that agent` : ""].filter(Boolean);
  return (parts.join(", ") || "Nothing to move") + overCapText(r);
};

/** Where chosen leads go: one agent, several in turn, or back to the queue. */
function Destination({ mode, setMode, to, setTo, count, allowSwap, swapWith, setSwapWith, exclude }: {
  mode: Mode; setMode: (m: Mode) => void; to: string[]; setTo: (t: string[]) => void; count: number;
  allowSwap?: boolean; swapWith?: string; setSwapWith?: (v: string) => void; exclude?: string;
}) {
  const agents = useSalesAgents().filter((a) => a.id !== exclude);
  const options: [Mode, string][] = [["to", "Give them to one agent"], ["share", "Share across several agents"], ...(allowSwap ? [["swap", "Swap with another agent"] as [Mode, string]] : []), ["queue", "Return them to the queue"]];
  return (
    <div className="space-y-3">
      <div role="radiogroup" aria-label="Where the leads go" className="grid gap-2 sm:grid-cols-2">
        {options.map(([m, label]) => (
          <label key={m} className={clsx("flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm", mode === m ? "border-navy-900 bg-navy-50 font-medium" : "border-line hover:bg-navy-50/60")}>
            <input type="radio" name="move-mode" value={m} checked={mode === m} onChange={() => { setMode(m); setTo([]); }} className="accent-navy-900" />
            {label}
          </label>
        ))}
      </div>
      {mode === "to" && (
        <Field label="Sales agent" required>
          {(p) => <Select value={to[0] ?? ""} onChange={(e) => setTo(e.target.value ? [e.target.value] : [])} {...p}>
            <option value="">Choose an agent</option>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.fullName}</option>)}
          </Select>}
        </Field>
      )}
      {mode === "share" && (
        <fieldset className="space-y-1.5">
          <legend className="mb-1 text-sm font-medium">Agents (handed out in turn, oldest lead first)</legend>
          {agents.map((a) => <Checkbox key={a.id} label={a.fullName} checked={to.includes(a.id)} onChange={(v) => setTo(v ? [...to, a.id] : to.filter((x) => x !== a.id))} />)}
        </fieldset>
      )}
      {mode === "swap" && setSwapWith && (
        <Field label="Swap with" required hint="Their leads matching the same choices come back the other way.">
          {(p) => <Select value={swapWith ?? ""} onChange={(e) => setSwapWith(e.target.value)} {...p}>
            <option value="">Choose an agent</option>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.fullName}</option>)}
          </Select>}
        </Field>
      )}
      {mode === "queue" && <p className="text-sm text-muted">Round-robin hands them to whoever is on shift. Enrolled, lost or invalid leads cannot go back to the queue.</p>}
      {(mode === "to" || mode === "share") && to.length > 0 && (
        <ul className="space-y-0.5 rounded-lg bg-canvas px-3 py-2 text-xs" aria-label="Agents' open leads">
          {to.map((id) => <AgentLoad key={id} agentId={id} adding={mode === "to" ? count : Math.ceil(count / to.length)} />)}
        </ul>
      )}
    </div>
  );
}

/** Move the leads picked on the Leads list. */
export function MoveSelectedDialog({ ids, owners, onClose, onDone }: { ids: string[]; owners: Record<string, string | null>; onClose: () => void; onDone: () => void }) {
  const { ref } = useWorkspace();
  const runAction = useRunAction();
  const [mode, setMode] = useState<Mode>("to");
  const [to, setTo] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const from = useMemo(() => {
    const m = new Map<string, number>();
    for (const id of ids) {
      const o = owners[id];
      const name = o ? ref.profiles.find((p) => p.id === o)?.fullName ?? "Someone" : "Unassigned";
      m.set(name, (m.get(name) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [ids, owners, ref.profiles]);
  const ready = reason.trim() && (mode === "queue" || (mode === "to" && to.length === 1) || (mode === "share" && to.length >= 2));
  const toastResult = useResultToast();
  const save = async () => {
    setBusy(true);
    const r = await runAction(moveLeads({ ids, mode: mode as "to" | "share" | "queue", to, reason }), null);
    setBusy(false);
    if (r.ok) { onDone(); onClose(); toastResult(r.value); }
  };
  return (
    <Dialog open onClose={onClose} title={`Move ${ids.length} lead${ids.length === 1 ? "" : "s"}`}
      description={`Now with: ${from.map(([n, c]) => `${n} ${c}`).join(" · ")}`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" icon={<ArrowRightLeft size={14} />} disabled={busy || !ready} onClick={save}>{busy ? "Moving…" : "Move"}</Button></>}>
      <div className="space-y-4">
        <Destination mode={mode} setMode={setMode} to={to} setTo={setTo} count={ids.length} />
        <Field label="Reason" required hint="Shown on each lead's timeline and to the agents.">
          {(p) => <Input value={reason} maxLength={300} placeholder="e.g. Nour is on leave this week" onChange={(e) => setReason(e.target.value)} {...p} />}
        </Field>
        <p className="text-xs text-muted">Open follow-ups move with each lead. Who is credited for a past sale does not change.</p>
      </div>
    </Dialog>
  );
}

function useResultToast() {
  const toast = useToast();
  return (r: MoveResult) => toast.success(resultText(r));
}

/** Move one agent's leads: to another agent, shared across several, swapped, or back to the queue. */
export function MoveAgentLeadsDialog({ onClose }: { onClose: () => void }) {
  const { ref } = useWorkspace();
  const agents = useSalesAgents();
  const runAction = useRunAction();
  const toastResult = useResultToast();
  const [fromId, setFromId] = useState("");
  const [openOnly, setOpenOnly] = useState(true);
  const [programId, setProgramId] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [mode, setMode] = useState<Mode>("to");
  const [to, setTo] = useState<string[]>([]);
  const [swapWith, setSwapWith] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const scope = (owner: string): LeadFilters => ({
    ...EMPTY_FILTERS, ownerIds: [owner], stageKeys: openOnly ? OPEN_STAGES : [], programIds: programId ? [programId] : [],
    dateField: "created", dateFrom, dateTo,
  });
  const a = useApi<{ ids: string[]; total: number }>(fromId ? idsUrl(scope(fromId)) : null);
  const b = useApi<{ ids: string[]; total: number }>(mode === "swap" && swapWith ? idsUrl(scope(swapWith)) : null);
  const sample = useApi<LeadPage>(fromId ? leadsUrl(scope(fromId), 5) : null);
  const total = a.data?.total ?? 0;
  const tooMany = total > MAX_MOVE || (mode === "swap" && total + (b.data?.total ?? 0) > MAX_MOVE);
  const ready = !!fromId && !!a.data && total + (mode === "swap" ? b.data?.total ?? 0 : 0) > 0 && !tooMany && reason.trim() &&
    (mode === "queue" || (mode === "to" && to.length === 1) || (mode === "share" && to.length >= 2) || (mode === "swap" && !!swapWith && !!b.data));

  const save = async () => {
    if (!a.data) return;
    setBusy(true);
    const r = mode === "swap"
      ? await runAction(swapLeads({ agentA: fromId, agentB: swapWith, aIds: a.data.ids, bIds: b.data?.ids ?? [], reason }), null)
      : await runAction(moveLeads({ ids: a.data.ids, mode, to, reason }), null);
    setBusy(false);
    if (r.ok) { onClose(); toastResult(r.value); }
  };
  const fromName = agents.find((x) => x.id === fromId)?.fullName ?? "";
  return (
    <Dialog open onClose={onClose} title="Move leads" description="Move an agent's leads in one step, for example when someone is on leave or leaving." className="max-w-2xl"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" icon={<ArrowRightLeft size={14} />} disabled={busy || !ready} onClick={save}>{busy ? "Moving…" : mode === "swap" ? "Swap" : "Move"}</Button></>}>
      <div className="space-y-5">
        <fieldset className="grid gap-3 rounded-xl border border-line p-4 sm:grid-cols-2 [&>*]:min-w-0">
          <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-muted">Which leads</legend>
          <Field label="From agent" required>
            {(p) => <Select value={fromId} onChange={(e) => { setFromId(e.target.value); setTo([]); setSwapWith(""); }} {...p}>
              <option value="">Choose an agent</option>
              {ref.profiles.filter((x) => x.role === "sales").sort((x, y) => x.fullName.localeCompare(y.fullName)).map((x) => <option key={x.id} value={x.id}>{x.fullName}{x.active ? "" : " (inactive)"}</option>)}
            </Select>}
          </Field>
          <Field label="Program">
            {(p) => <Select value={programId} onChange={(e) => setProgramId(e.target.value)} {...p}>
              <option value="">All programs</option>
              {ref.programs.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </Select>}
          </Field>
          <Field label="Created from">{(p) => <Input type="date" value={dateFrom} max={dateTo || undefined} onChange={(e) => setDateFrom(e.target.value)} {...p} />}</Field>
          <Field label="Created to (inclusive)">{(p) => <Input type="date" value={dateTo} min={dateFrom || undefined} onChange={(e) => setDateTo(e.target.value)} {...p} />}</Field>
          <div className="sm:col-span-2"><Checkbox label="Open leads only" description="Untick to include enrolled, lost and invalid leads (they can go to an agent, not to the queue)." checked={openOnly} onChange={setOpenOnly} /></div>
          {fromId && (
            <p className="text-sm sm:col-span-2" data-testid="move-count" aria-live="polite">
              {a.data ? <><b className="font-semibold">{total} lead{total === 1 ? "" : "s"}</b> from {fromName}{sample.data?.rows.length ? `: ${sample.data.rows.map((r) => r.contact.name).slice(0, 5).join(", ")}${total > 5 ? "…" : ""}` : ""}</> : "Counting…"}
              {tooMany && <span className="block text-bad">More than {MAX_MOVE}. Narrow it by program or dates and move them in parts.</span>}
            </p>
          )}
        </fieldset>
        {fromId && <Destination mode={mode} setMode={setMode} to={to} setTo={setTo} count={total} allowSwap swapWith={swapWith} setSwapWith={setSwapWith} exclude={fromId} />}
        {mode === "swap" && swapWith && b.data && <p className="text-sm" data-testid="swap-count">{total} go to {agents.find((x) => x.id === swapWith)?.fullName}, {b.data.total} come back to {fromName}.</p>}
        <Field label="Reason" required hint="Shown on each lead's timeline and to the agents.">
          {(p) => <Input value={reason} maxLength={300} placeholder="e.g. Nour is on leave this week" onChange={(e) => setReason(e.target.value)} {...p} />}
        </Field>
      </div>
    </Dialog>
  );
}
