"use client";

import { CalendarCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn as clsx } from "@/components/ui/cn";
import { Card, CardHeader, EmptyState, Name, PageHeader, SkeletonRows } from "@/components/ui/misc";
import type { FollowUpItem } from "@/domain/dto";
import { followUpTiming, formatCairo, formatRelative } from "@/domain/rules";
import { profileName } from "@/lib/lead-row";
import { useRunAction } from "@/lib/run-action";
import { useApi, useWorkspace } from "@/lib/workspace";
import { completeFollowUp } from "@/server/actions";

export function FollowUpsPage() {
  const { me, ref, now, openInquiry } = useWorkspace();
  const runAction = useRunAction();
  const { data, loading } = useApi<FollowUpItem[]>("/api/follow-ups");
  const all = data ?? [];
  const groups = (["overdue", "today", "upcoming"] as const).map((k) => ({ k, items: all.filter((f) => followUpTiming(f.followUp, now) === k) }));
  const titles = { overdue: "Overdue", today: "Today", upcoming: "Upcoming" };

  return (
    <div>
      <PageHeader title="Follow-ups" subtitle={me.role === "manager" ? "All open follow-ups across the team, in Cairo time" : "Your open follow-ups, in Cairo time"} />
      {!data && loading ? (
        <Card><SkeletonRows rows={5} /></Card>
      ) : all.length === 0 ? (
        <Card><EmptyState icon={<CalendarCheck size={22} />} title="No open follow-ups">Set a follow-up from any customer panel.</EmptyState></Card>
      ) : (
        <div className="space-y-5">
          {groups.map(({ k, items }) =>
            items.length ? (
              <Card key={k}>
                <CardHeader title={<span className={k === "overdue" ? "text-bad" : ""}>{titles[k]}</span>} count={items.length} />
                <ul className="divide-y divide-line">
                  {items.map(({ followUp: f, lead }) => (
                    <li key={f.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                      <button className="min-w-0 flex-1 basis-56 text-left" onClick={() => openInquiry(f.inquiryId)}>
                        <span dir="auto" className="block font-medium">{f.note}</span>
                        <span className="text-xs text-muted">
                          <Name>{lead.contact.name}</Name> · {ref.programs.find((p) => p.id === lead.inquiry.programId)?.code}
                          {me.role === "manager" ? ` · ${profileName(ref, f.ownerId)}` : ""}
                        </span>
                      </button>
                      <span className={clsx("text-xs", k === "overdue" ? "font-semibold text-bad" : "text-muted")}>{formatCairo(f.dueAt)} · {formatRelative(f.dueAt, now)}</span>
                      <Button size="sm" onClick={() => runAction(completeFollowUp(f.id), "Follow-up completed. Set the next step if needed.")}>Done</Button>
                    </li>
                  ))}
                </ul>
              </Card>
            ) : null,
          )}
        </div>
      )}
    </div>
  );
}
