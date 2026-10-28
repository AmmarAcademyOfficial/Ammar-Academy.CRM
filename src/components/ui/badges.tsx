import { cn as clsx } from "./cn";
import {
  Ban,
  CheckCircle2,
  CircleDashed,
  FlaskConical,
  Hourglass,
  PhoneOff,
  PhoneOutgoing,
  Sparkles,
  Star,
  XCircle,
} from "lucide-react";
import type { ReactNode } from "react";
import { PAYMENT_STATUS_LABEL } from "@/domain/rules";
import type { PaymentDueStatus, PaymentStatus, Stage, StageKey, SubmissionStatus, SupportStatus, Tag, TagColor } from "@/domain/types";

/** Every status shows an icon and words, never color alone. */
export function Pill({ children, className, icon }: { children: ReactNode; className?: string; icon?: ReactNode }) {
  return (
    <span className={clsx("inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-full px-2 text-xs font-medium", className)}>
      {icon}
      {children}
    </span>
  );
}

const STAGE_STYLE: Record<StageKey, { cls: string; icon: ReactNode }> = {
  new: { cls: "bg-info-bg text-info", icon: <Sparkles size={12} aria-hidden /> },
  contacting: { cls: "bg-navy-100 text-navy-800", icon: <PhoneOutgoing size={12} aria-hidden /> },
  qualified: { cls: "bg-[#efe8fb] text-[#5b3696]", icon: <Star size={12} aria-hidden /> },
  awaiting_payment: { cls: "bg-warn-bg text-warn", icon: <Hourglass size={12} aria-hidden /> },
  enrolled: { cls: "bg-ok-bg text-ok", icon: <CheckCircle2 size={12} aria-hidden /> },
  lost: { cls: "bg-[#eeeff3] text-[#4b4e66]", icon: <XCircle size={12} aria-hidden /> },
  invalid: { cls: "bg-bad-bg text-bad", icon: <Ban size={12} aria-hidden /> },
};

export function StageBadge({ stage }: { stage: Stage }) {
  const s = STAGE_STYLE[stage.systemKey];
  return (
    <Pill className={s.cls} icon={s.icon}>
      {stage.label}
    </Pill>
  );
}

export const TAG_COLORS: Record<TagColor, { label: string; bg: string; fg: string; dot: string }> = {
  orange: { label: "Orange", bg: "#fdebd3", fg: "#8a4b00", dot: "#f7931e" },
  blue: { label: "Blue", bg: "#e3edfb", fg: "#1f4f8f", dot: "#2f6fd0" },
  purple: { label: "Purple", bg: "#efe8fb", fg: "#5b3696", dot: "#7c4dd6" },
  red: { label: "Red", bg: "#fde8e6", fg: "#a3261b", dot: "#d63c2f" },
  green: { label: "Green", bg: "#e5f4ec", fg: "#17633f", dot: "#22995c" },
  teal: { label: "Teal", bg: "#e0f4f3", fg: "#0f5f5b", dot: "#14918a" },
  gray: { label: "Gray", bg: "#eeeff3", fg: "#4b4e66", dot: "#8a8da3" },
};

export function TagChip({ tag, primary, onRemove }: { tag: Tag; primary?: boolean; onRemove?: () => void }) {
  const c = TAG_COLORS[tag.color];
  return (
    <span
      className="inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-xs font-medium"
      style={{ background: c.bg, color: c.fg }}
    >
      <span className="h-2 w-2 rounded-full" style={{ background: c.dot }} aria-hidden />
      {tag.name}
      {primary && (
        <>
          <Star size={11} aria-hidden className="fill-current" />
          <span className="sr-only">(primary label)</span>
        </>
      )}
      {tag.archived && <span className="opacity-70">(archived)</span>}
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={`Remove ${tag.name}`} className="-mr-1 rounded px-0.5 hover:bg-black/10">
          ×
        </button>
      )}
    </span>
  );
}

export function DncBadge() {
  return (
    <Pill className="bg-bad text-white" icon={<PhoneOff size={12} aria-hidden />}>
      Do Not Contact
    </Pill>
  );
}

const PAY_STYLE: Record<PaymentStatus, string> = {
  unpaid: "bg-[#eeeff3] text-[#4b4e66]",
  partially_paid: "bg-warn-bg text-warn",
  fully_paid: "bg-ok-bg text-ok",
};

export function PaymentBadge({ status }: { status: PaymentStatus }) {
  return (
    <Pill className={PAY_STYLE[status]} icon={status === "fully_paid" ? <CheckCircle2 size={12} aria-hidden /> : <CircleDashed size={12} aria-hidden />}>
      {PAYMENT_STATUS_LABEL[status]}
    </Pill>
  );
}

const SUB_STYLE: Record<SubmissionStatus, [string, string]> = {
  pending: ["bg-warn-bg text-warn", "Pending"],
  confirmed: ["bg-ok-bg text-ok", "Confirmed"],
  rejected: ["bg-bad-bg text-bad", "Rejected"],
  reversed: ["bg-[#eeeff3] text-[#4b4e66]", "Reversed"],
};

export function SubmissionBadge({ status }: { status: SubmissionStatus }) {
  const [cls, label] = SUB_STYLE[status];
  return <Pill className={cls}>{label}</Pill>;
}

const DUE_STYLE: Record<PaymentDueStatus, [string, string]> = {
  paid: ["bg-ok-bg text-ok", "Paid"],
  partly_paid: ["bg-info-bg text-info", "Partly paid"],
  upcoming: ["bg-[#eeeff3] text-[#4b4e66]", "Upcoming"],
  due_today: ["bg-warn-bg text-warn", "Due today"],
  overdue: ["bg-bad-bg text-bad", "Overdue"],
};

/** Status of one planned payment. */
export function DueBadge({ status }: { status: PaymentDueStatus }) {
  const [cls, label] = DUE_STYLE[status];
  return <Pill className={cls}>{label}</Pill>;
}

const SUPPORT_LABEL: Record<SupportStatus, [string, string]> = {
  new_customer: ["bg-info-bg text-info", "New Customer"],
  onboarding: ["bg-warn-bg text-warn", "Onboarding"],
  active: ["bg-ok-bg text-ok", "Active"],
  withdrawn: ["bg-[#eeeff3] text-[#4b4e66]", "Withdrawn"],
};

export function SupportStatusBadge({ status }: { status: SupportStatus }) {
  const [cls, label] = SUPPORT_LABEL[status];
  return <Pill className={cls}>{label}</Pill>;
}

export const SUPPORT_STATUS_LABEL: Record<SupportStatus, string> = {
  new_customer: "New Customer",
  onboarding: "Onboarding",
  active: "Active",
  withdrawn: "Withdrawn",
};

/** Marks behavior that is simulated in the Phase 1 prototype. */
export function SimulatedTag({ children = "Simulated" }: { children?: ReactNode }) {
  return (
    <Pill className="border border-dashed border-orange-ink/40 bg-orange-50 text-orange-ink" icon={<FlaskConical size={12} aria-hidden />}>
      {children}
    </Pill>
  );
}

/** "New": assigned but not opened yet by its owner. Shown with the yellow row highlight. */
export function NewBadge() {
  return <span data-badge="new" className="inline-flex h-5 shrink-0 items-center whitespace-nowrap rounded-full bg-new-badge px-1.5 text-[11px] font-semibold text-new-ink">New</span>;
}

/** The customer had an earlier inquiry. */
export function ReturningBadge() {
  return <span data-badge="returning" className="inline-flex h-5 shrink-0 items-center whitespace-nowrap rounded-full bg-info-bg px-1.5 text-[11px] font-semibold text-info">Returning customer</span>;
}
