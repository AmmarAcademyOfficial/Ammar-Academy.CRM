"use client";

import { ArrowRightLeft, BadgeCheck, BookmarkCheck, CalendarCheck, CalendarPlus, CalendarRange, CreditCard, Download, Flag, GraduationCap, Headset, ListChecks, type LucideIcon, MessageSquare, MousePointerClick, PencilLine, Phone, PhoneOff, RefreshCw, Tag } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/form";
import { formatCairo, formatRelative } from "@/domain/rules";
import type { Activity, ActivityType } from "@/domain/types";
import { profileName } from "@/lib/lead-row";
import { useRunAction } from "@/lib/run-action";
import { useWorkspace } from "@/lib/workspace";
import { editNote } from "@/server/actions";

const ICON: Record<ActivityType, LucideIcon> = {
  comment: MessageSquare,
  contact_attempt: Phone,
  stage_change: Flag,
  owner_change: ArrowRightLeft,
  follow_up_created: CalendarPlus,
  follow_up_completed: CalendarCheck,
  payment_submitted: CreditCard,
  payment_decision: BadgeCheck,
  handover: Headset,
  checklist: ListChecks,
  support_status: Headset,
  tag_change: Tag,
  do_not_contact: PhoneOff,
  imported: Download,
  resubmitted: RefreshCw,
  enrollment: GraduationCap,
  support_assignment: Headset,
  support_follow_up: CalendarPlus,
  outreach_shortcut: MousePointerClick,
  field_change: PencilLine,
  reservation: BookmarkCheck,
  payment_plan: CalendarRange,
  teacher: GraduationCap,
};

export function Timeline({ activities, readOnly }: { activities: Activity[]; readOnly?: boolean }) {
  const { me, ref, now } = useWorkspace();
  const runAction = useRunAction();
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);

  const title = (a: Activity): string => {
    const m = a.meta ?? {};
    switch (a.type) {
      case "contact_attempt":
        return `Contact attempt: ${ref.outcomes.find((o) => o.id === m.outcome_id)?.label ?? "Unknown"}`;
      case "stage_change":
        // Stored by fixed meaning, shown with today's label, so renaming a stage never breaks history.
        return `Stage → ${ref.stages.find((s) => s.systemKey === m.to)?.label ?? String(m.to)}`;
      case "owner_change":
        return m.to ? `${a.body ?? "Owner changed"} → ${profileName(ref, String(m.to))}` : (a.body ?? "Owner changed");
      case "follow_up_created":
        return "Follow-up scheduled";
      case "follow_up_completed":
        return "Follow-up completed";
      default:
        return "";
    }
  };

  return (
    <ol className="relative space-y-4 before:absolute before:bottom-2 before:left-[15px] before:top-2 before:w-px before:bg-line">
      {activities.map((a) => {
        const Icon = ICON[a.type] ?? MessageSquare;
        const t = title(a);
        const editable = !readOnly && a.type === "comment" && a.actorId === me.id && (now.getTime() - new Date(a.createdAt).getTime()) / 60000 <= ref.settings.noteEditWindowMinutes;
        return (
          <li key={a.id} className="relative flex gap-3">
            <span className={`relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border ${a.type === "comment" ? "border-navy-100 bg-navy-50 text-navy-700" : "border-line bg-white text-muted"}`}>
              <Icon size={15} aria-hidden />
            </span>
            <div className="min-w-0 flex-1 pt-1">
              <p className="text-xs text-muted">
                <span className="font-medium text-ink">{profileName(ref, a.actorId)}</span> ·{" "}
                <time dateTime={a.createdAt} title={formatCairo(a.createdAt)}>{formatRelative(a.createdAt, now)}</time>
                {a.revisions?.length ? (
                  <span title={a.revisions.map((r) => `Before ${formatCairo(r.editedAt)}: ${r.body}`).join("\n")}> · edited ({a.revisions.length})</span>
                ) : null}
              </p>
              {t && <p className="mt-0.5 text-sm font-medium">{t}</p>}
              {editing?.id === a.id ? (
                <div className="mt-1.5 space-y-2">
                  <Textarea value={editing.body} onChange={(e) => setEditing({ id: a.id, body: e.target.value })} aria-label="Edit note" />
                  <div className="flex gap-2">
                    <Button size="sm" variant="navy" onClick={async () => (await runAction(editNote(a.id, editing.body), "Note updated. The earlier version is kept.")).ok && setEditing(null)}>Save</Button>
                    <Button size="sm" onClick={() => setEditing(null)}>Cancel</Button>
                  </div>
                </div>
              ) : (
                a.body && a.type !== "owner_change" && (
                  <p dir="auto" className={`mt-0.5 whitespace-pre-wrap break-words text-sm leading-relaxed ${a.type === "comment" ? "rounded-lg bg-navy-50/60 px-3 py-2" : a.type === "outreach_shortcut" ? "italic text-muted" : "text-ink/90"}`}>
                    {a.body}
                  </p>
                )
              )}
              {editable && editing?.id !== a.id && (
                <button className="mt-1 text-xs font-medium text-navy-700 hover:underline" onClick={() => setEditing({ id: a.id, body: a.body ?? "" })}>Edit</button>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
