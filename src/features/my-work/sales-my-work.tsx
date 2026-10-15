"use client";

import { AlarmClock, CalendarClock, CircleDollarSign, PhoneCall, Sparkles, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { AvailabilityControl } from "@/components/layout/app-shell";
import { StageBadge } from "@/components/ui/badges";
import { cn as clsx } from "@/components/ui/cn";
import { Card, CardHeader, EmptyState, Name, PageHeader, SkeletonRows, Stat } from "@/components/ui/misc";
import type { MyWork, WorkBucket } from "@/domain/dto";
import { followUpTiming, formatCairo, formatRelative } from "@/domain/rules";
import { hydrate, type LeadRow } from "@/lib/lead-row";
import { useApi, useWorkspace } from "@/lib/workspace";

const META: Record<WorkBucket, { label: string; icon: React.ReactNode; tone?: "warn" | "bad"; empty: string }> = {
  overdue: { label: "Overdue follow-ups", icon: <AlarmClock size={14} />, tone: "bad", empty: "Nothing overdue. Nice work." },
  today: { label: "Due today", icon: <CalendarClock size={14} />, empty: "No more follow-ups due today." },
  uncontacted: { label: "Not yet contacted", icon: <PhoneCall size={14} />, tone: "warn", empty: "Every lead has at least one contact attempt." },
  new: { label: "New (last 24 h)", icon: <Sparkles size={14} />, empty: "No new leads in the last 24 hours." },
  payment: { label: "Awaiting payment", icon: <CircleDollarSign size={14} />, empty: "No leads are waiting for payment." },
  noaction: { label: "No next action", icon: <TriangleAlert size={14} />, tone: "warn", empty: "Every contacted lead has a next step." },
};
const ORDER: WorkBucket[] = ["overdue", "today", "uncontacted", "new", "payment", "noaction"];

export function SalesMyWork() {
  const { me, ref, now, openInquiry } = useWorkspace();
  const [bucket, setBucket] = useState<WorkBucket>("overdue");
  const { data, loading } = useApi<MyWork>(`/api/my-work?bucket=${bucket}`);
  const rows = useMemo(() => (data?.rows ?? []).map((r) => hydrate(r, ref)), [data, ref]);
  const h = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Cairo", hour: "numeric", hourCycle: "h23" }).format(now));

  return (
    <div>
      <PageHeader title={`Good ${h < 12 ? "morning" : h < 18 ? "afternoon" : "evening"}, ${me.fullName.split(" ")[0]}`} subtitle="Start with overdue follow-ups, then today’s callbacks and new leads." />
      <div className="mb-4 lg:hidden"><AvailabilityControl /></div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {ORDER.map((b) => {
          const n = data?.counts[b];
          return (
            <div key={b} className={clsx("h-full rounded-[var(--radius-card)]", bucket === b && "ring-2 ring-navy-900")}>
              <Stat label={META[b].label} value={n ?? "–"} icon={META[b].icon} tone={n ? META[b].tone : undefined} onClick={() => setBucket(b)} />
            </div>
          );
        })}
      </div>
      <Card className="mt-5">
        <CardHeader title={META[bucket].label} count={data?.counts[bucket]} />
        {!data && loading ? (
          <SkeletonRows rows={4} />
        ) : rows.length === 0 ? (
          <EmptyState title={META[bucket].empty} />
        ) : (
          <ul className={clsx("divide-y divide-line", loading && "opacity-60")}>
            {rows.map((r) => <WorkItem key={r.inquiry.id} r={r} now={now} onOpen={() => openInquiry(r.inquiry.id)} />)}
          </ul>
        )}
      </Card>
    </div>
  );
}

function WorkItem({ r, now, onOpen }: { r: LeadRow; now: Date; onOpen: () => void }) {
  const f = r.nextFollowUp;
  const t = f && followUpTiming(f, now);
  return (
    <li>
      <button onClick={onOpen} className="flex w-full flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-3 text-left hover:bg-navy-50/60">
        <span className="min-w-0 flex-1 basis-56">
          <span className="flex items-center gap-2">
            <Name className="truncate font-medium">{r.contact.name}</Name>
            <span className="text-xs font-semibold text-muted">{r.program.code}</span>
          </span>
          <span dir="auto" className={clsx("block truncate text-sm", t === "overdue" ? "text-bad" : "text-muted")}>
            {f ? f.note : r.inquiry.firstContactAttemptAt ? "No next action set" : `Arrived ${formatRelative(r.inquiry.createdAt, now)}`}
          </span>
        </span>
        <StageBadge stage={r.stage} />
        <span className={clsx("w-36 text-right text-xs", t === "overdue" ? "font-semibold text-bad" : "text-muted")}>
          {f ? `${t === "overdue" ? "Overdue · " : ""}${formatCairo(f.dueAt, t === "upcoming" ? "datetime" : "time")}` : ""}
        </span>
      </button>
    </li>
  );
}
