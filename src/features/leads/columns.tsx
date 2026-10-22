"use client";

import { isUnopened } from "@/lib/lead-row";
import { PhoneOff } from "lucide-react";
import type { ReactNode } from "react";
import { StageBadge, TagChip, NewBadge, ReturningBadge } from "@/components/ui/badges";
import { Name, PhoneText } from "@/components/ui/misc";
import { followUpTiming, formatCairo, formatRelative } from "@/domain/rules";
import type { LeadSortKey } from "@/domain/dto";
import { priceText } from "@/lib/courses";
import type { LeadRow } from "@/lib/lead-row";

export interface Column {
  key: string;
  label: string;
  render: (r: LeadRow, now: Date) => ReactNode;
  /** Server-side sort key; columns without one are not sortable. */
  sort?: LeadSortKey;
  /** Always shown and cannot be hidden. */
  locked?: boolean;
  managerOnly?: boolean;
}

export const COLUMNS: Column[] = [
  {
    key: "name",
    label: "Customer",
    locked: true,
    sort: "name",
    render: (r) => (
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 font-medium">
          <Name className="truncate">{r.contact.name}</Name>
          {r.contact.doNotContact && <PhoneOff size={13} className="shrink-0 text-bad" aria-label="Do Not Contact" />}
          {isUnopened(r.inquiry) && <NewBadge />}
          {r.inquiry.returningCustomer && <ReturningBadge />}
        </p>
        {r.inquiry.studentName && (
          <p className="truncate text-xs text-muted">
            Student: <Name>{r.inquiry.studentName}</Name>
          </p>
        )}
      </div>
    ),
  },
  { key: "phone", label: "Phone", render: (r) => <PhoneText value={r.contact.phoneNormalized} className="text-[13px]" /> },
  { key: "program", label: "Program", sort: "program", render: (r) => <span className="text-[13px] font-medium">{r.program.code}</span> },
  {
    key: "course",
    label: "Course",
    render: (r) => r.course
      ? <span className="block max-w-[220px] text-[13px]"><span className="block truncate" title={r.course.name}>{r.course.name}</span><span className="text-xs text-muted">{priceText(r.course)}</span></span>
      : <span className="text-[13px] text-muted">—</span>,
  },
  { key: "stage", label: "Stage", sort: "stage", render: (r) => <StageBadge stage={r.stage} /> },
  { key: "outcome", label: "Last outcome", sort: "outcome", render: (r) => <span className="text-[13px]">{r.outcome?.label ?? <span className="text-muted">Not contacted</span>}</span> },
  {
    key: "followup",
    label: "Next follow-up",
    sort: "followup",
    render: (r, now) => {
      const f = r.nextFollowUp;
      if (!f) return r.stage.isClosed ? <span className="text-muted">—</span> : <span className="text-[13px] text-orange-ink">None set</span>;
      const t = followUpTiming(f, now);
      return (
        <span className={`text-[13px] ${t === "overdue" ? "font-medium text-bad" : ""}`} title={f.note}>
          {t === "overdue" ? "Overdue · " : t === "today" ? "Today · " : ""}
          {formatCairo(f.dueAt, t === "upcoming" ? "datetime" : "time")}
        </span>
      );
    },
  },
  {
    key: "tags",
    label: "Tags",
    render: (r) => (
      <div className="flex max-w-[220px] flex-wrap gap-1">
        {r.tags.map((t) => (
          <TagChip key={t.id} tag={t} primary={t.id === r.inquiry.primaryTagId} />
        ))}
      </div>
    ),
  },
  { key: "owner", label: "Owner", sort: "owner", render: (r) => <span className="text-[13px]">{r.owner?.fullName ?? <span className="font-medium text-orange-ink">Unassigned</span>}</span> },
  { key: "lastContact", label: "Latest contact", sort: "lastContact", render: (r, now) => <span className="text-[13px] text-muted">{r.inquiry.lastContactAt ? formatRelative(r.inquiry.lastContactAt, now) : "—"}</span> },
  { key: "created", label: "Created", sort: "created", render: (r) => <span className="text-[13px] text-muted">{formatCairo(r.inquiry.createdAt)}</span> },
  { key: "source", label: "Source", render: (r) => <span className="text-[13px] text-muted">{r.inquiry.source === "manual" ? "Manual" : "Sheet"}</span> },
];

export const DEFAULT_COLUMNS = ["name", "phone", "program", "course", "stage", "outcome", "followup", "tags", "owner"];
