import { cn as clsx } from "./cn";
import type { ComponentProps, ReactNode } from "react";
import { formatPhone } from "@/domain/rules";

export function Card({ children, className, as: Tag = "section", ...rest }: { children: ReactNode; className?: string; as?: "section" | "div" | "article" } & Omit<ComponentProps<"section">, "className" | "children" | "ref">) {
  // Extra attributes (data-*, aria-*) are passed through, so tests and assistive tech can find a card.
  return <Tag {...rest} className={clsx("rounded-[var(--radius-card)] border border-line bg-white", className)}>{children}</Tag>;
}

export function CardHeader({ title, action, subtitle, count }: { title: ReactNode; action?: ReactNode; subtitle?: ReactNode; count?: number }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
      <div className="min-w-0">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          {title}
          {count !== undefined && (
            <span className="rounded-full bg-navy-100 px-2 py-0.5 text-xs font-semibold text-navy-800">{count}</span>
          )}
        </h2>
        {subtitle && <p className="text-xs text-muted">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-navy-900 sm:text-2xl">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-10 text-center">
      {icon && <div className="mb-3 rounded-full bg-navy-50 p-3 text-navy-700">{icon}</div>}
      <p className="font-medium">{title}</p>
      {children && <div className="mt-1 max-w-sm text-sm text-muted">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function PhoneText({ value, className }: { value: string; className?: string }) {
  return (
    <bdi className={clsx("phone", className)} dir="ltr">
      {formatPhone(value)}
    </bdi>
  );
}

/** Customer names may be Arabic or English; let the browser pick direction. */
export function Name({ children, className }: { children: string; className?: string }) {
  return (
    <bdi dir="auto" className={className}>
      {children}
    </bdi>
  );
}

export function Avatar({ name, size = 28, className }: { name: string; size?: number; className?: string }) {
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0])
    .join("")
    .toUpperCase();
  return (
    <span
      aria-hidden
      className={clsx("inline-flex shrink-0 items-center justify-center rounded-full bg-navy-100 font-semibold text-navy-800", className)}
      style={{ width: size, height: size, fontSize: size * 0.38 }}
    >
      {initials}
    </span>
  );
}

export function Stat({ label, value, hint, tone = "default", onClick, icon }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "default" | "warn" | "bad" | "ok"; onClick?: () => void; icon?: ReactNode }) {
  const Comp = onClick ? "button" : "div";
  return (
    <Comp
      onClick={onClick}
      className={clsx(
        "flex h-full w-full flex-col items-start rounded-[var(--radius-card)] border bg-white p-4 text-left",
        onClick && "transition hover:border-navy-600/40 hover:shadow-sm",
        tone === "bad" ? "border-bad/30" : tone === "warn" ? "border-orange-500/40" : "border-line",
      )}
    >
      <span className="flex items-center gap-1.5 text-xs font-medium text-muted">
        {icon}
        {label}
      </span>
      <span className={clsx("mt-1 text-2xl font-semibold tabular-nums", tone === "bad" ? "text-bad" : tone === "warn" ? "text-orange-ink" : tone === "ok" ? "text-ok" : "text-navy-900")}>{value}</span>
      {hint && <span className="mt-0.5 text-xs text-muted">{hint}</span>}
    </Comp>
  );
}

export function SkeletonRows({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2 p-4" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-10 animate-pulse rounded-lg bg-navy-50" />
      ))}
    </div>
  );
}
