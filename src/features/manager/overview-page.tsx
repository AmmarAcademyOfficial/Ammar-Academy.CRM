"use client";

import { AlarmClock, CreditCard, FileWarning, Inbox, Play, Sparkles } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { SheetStatusPill } from "@/features/settings/sheets-settings";
import { EligibilityPill } from "@/features/settings/shifts-settings";
import { useRunAction } from "@/lib/run-action";
import { runAssignmentNow } from "@/server/distribution-actions";
import { cn as clsx } from "@/components/ui/cn";
import { Avatar, Card, CardHeader, EmptyState, Name, PageHeader, SkeletonRows, Stat } from "@/components/ui/misc";
import type { Overview } from "@/domain/dto";
import { formatRelative } from "@/domain/rules";
import { hydrate, profileName } from "@/lib/lead-row";
import { useApi, useWorkspace } from "@/lib/workspace";

export function OverviewPage() {
  const { ref, now, openInquiry } = useWorkspace();
  const { data, loading } = useApi<Overview>("/api/overview");
  const queue = useMemo(() => (data?.queue ?? []).map((r) => hydrate(r, ref)), [data, ref]);
  const agents = ref.profiles.filter((p) => p.role === "sales").sort((a, b) => Number(b.active) - Number(a.active) || a.rotationOrder - b.rotationOrder);
  const load = (id: string) => data?.openByAgent.find((a) => a.userId === id);
  const programs = ref.programs.filter((p) => p.active);
  const runAction = useRunAction();
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const runNow = async () => {
    setRunning(true);
    const r = await runAction(runAssignmentNow(), null);
    setRunning(false);
    if (r.ok) {
      runAction(Promise.resolve({ ok: true as const, value: null }), r.value.assigned > 0
        ? `${r.value.assigned} lead${r.value.assigned === 1 ? "" : "s"} assigned.${r.value.waiting ? ` ${r.value.waiting} still waiting: nobody eligible is on shift for them.` : ""}`
        : r.value.waiting ? `Nobody eligible is on shift for the ${r.value.waiting} waiting lead${r.value.waiting === 1 ? "" : "s"}. Assign them by hand, or check shifts.` : "The queue is empty.");
    }
  };

  return (
    <div>
      <PageHeader title="Overview" subtitle="Today across sales. Times in Cairo." />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Stat label="New inquiries today" value={data?.newToday ?? "–"} icon={<Sparkles size={14} />} />
        <Stat label="Unassigned queue" value={data ? queue.length : "–"} icon={<Inbox size={14} />} tone={queue.length ? "warn" : undefined} />
        <Stat label="Overdue follow-ups" value={data?.overdueFollowUps ?? "–"} icon={<AlarmClock size={14} />} tone={data?.overdueFollowUps ? "bad" : undefined} />
        <Stat label="Payments to confirm" value={data?.paymentsPending ?? "–"} icon={<CreditCard size={14} />} tone={data?.paymentsPending ? "warn" : undefined}
          hint={data?.onboardingFlagged ? `${data.onboardingFlagged} customer${data.onboardingFlagged === 1 ? "" : "s"} flagged` : "Waiting for you"} onClick={() => router.push("/payments")} />
        <Stat label="Needs review" value={data?.reviewOpen ?? "–"} icon={<FileWarning size={14} />} tone={data?.reviewOpen ? "warn" : undefined} hint="Sheet rows to check" onClick={() => router.push("/review")} />
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-[1.2fr_1fr]">
        <Card>
          <CardHeader title="Sales team now" subtitle="Who receives new leads right now, by program (Cairo time)." action={<Link href="/settings/shifts" className="text-xs font-semibold text-navy-700 hover:underline">Shifts</Link>} />
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-muted">
                  <th className="px-4 py-2 font-medium">Agent</th>
                  {programs.map((p) => <th key={p.id} className="px-3 py-2 font-medium">{p.code}</th>)}
                  <th className="px-3 py-2 text-right font-medium">Open leads</th>
                  <th className="px-3 py-2 text-right font-medium" title="Open leads with an overdue follow-up">Overdue</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((a) => (
                  <tr key={a.id} className="border-b border-line/70 last:border-0">
                    <td className="px-4 py-2.5">
                      <span className="flex items-center gap-2">
                        <Avatar name={a.fullName} size={26} />
                        <span className={clsx(!a.active && "text-muted line-through")}>{a.fullName}</span>
                      </span>
                    </td>
                    {programs.map((p) => (
                      <td key={p.id} className="px-3 py-2.5 text-xs">
                        {data ? <EligibilityPill row={data.eligibility.find((e) => e.userId === a.id && e.programId === p.id)} /> : "–"}
                      </td>
                    ))}
                    <td className="px-3 py-2.5 text-right tabular-nums">{data ? (load(a.id)?.open ?? 0) : "–"}</td>
                    <td className={clsx("px-3 py-2.5 text-right tabular-nums", (load(a.id)?.overdue ?? 0) > 0 && "font-semibold text-bad")}>{data ? (load(a.id)?.overdue ?? 0) : "–"}</td>
                  </tr>
                ))}
                {agents.length === 0 && (
                  <tr><td colSpan={3 + programs.length} className="px-4 py-6 text-center text-sm text-muted">No sales agents yet. Invite them in Settings → Users and Roles.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Unassigned queue"
            count={queue.length}
            subtitle="Waiting for an eligible agent on shift. Checked automatically every 2 minutes."
            action={queue.length > 0 && <Button size="sm" className="whitespace-nowrap" icon={<Play size={14} />} disabled={running} onClick={runNow}>{running ? "Assigning…" : "Run assignment now"}</Button>}
          />
          {!data && loading ? (
            <SkeletonRows rows={3} />
          ) : queue.length === 0 ? (
            <EmptyState title="Queue is empty">Every open inquiry has an owner.</EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {queue.map((r) => (
                <li key={r.inquiry.id}>
                  <button className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-navy-50/60" onClick={() => openInquiry(r.inquiry.id)}>
                    <span>
                      <Name className="font-medium">{r.contact.name}</Name>
                      <span className="block text-xs text-muted">{r.program.code} · waiting {formatRelative(r.inquiry.createdAt, now).replace(" ago", "")}</span>
                    </span>
                    <span className="text-xs font-medium text-navy-700">Assign</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="xl:col-span-2">
          <CardHeader title="Google Sheets" subtitle="Lead sheets checked every 2 minutes" action={<Link href="/settings/sheets" className="text-xs font-semibold text-navy-700 hover:underline">Connections</Link>} />
          {data && data.sheets.length === 0 ? (
            <EmptyState title="No sheet connected">Connect the SAT and IELTS lead sheets in <Link href="/settings/sheets" className="underline">Settings → Google Sheets Connections</Link>.</EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {(data?.sheets ?? []).map((s) => (
                <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
                  <bdi className="font-medium">{s.name}</bdi>
                  <bdi className="text-xs text-muted">{s.tab}</bdi>
                  <span className="text-xs text-muted">{s.lastSuccessAt ? `synced ${formatRelative(s.lastSuccessAt, now)}` : "not synced yet"}</span>
                  <span className="ml-auto"><SheetStatusPill status={s.status} /></span>
                  {s.status !== "active" && s.statusMessage && <p className="w-full text-xs text-warn">{s.statusMessage}</p>}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="xl:col-span-2">
          <CardHeader title="Recent sensitive changes" subtitle="Audit history" action={<Link href="/settings/audit" className="text-sm font-medium text-navy-700 hover:underline">See all</Link>} />
          {data && data.audit.length === 0 ? (
            <EmptyState title="Nothing yet">Role changes, reassignments, Do Not Contact and settings changes appear here.</EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {(data?.audit ?? []).map((a) => (
                <li key={a.id} className="px-4 py-2.5 text-sm">
                  <p>{a.action} · <Name className="font-medium">{a.target}</Name></p>
                  <p className="text-xs text-muted">{profileName(ref, a.actorId)} · {formatRelative(a.createdAt, now)}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
