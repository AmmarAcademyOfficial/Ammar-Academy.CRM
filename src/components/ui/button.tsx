import { cn as clsx } from "./cn";
import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "navy";
type Size = "sm" | "md";

const VARIANTS: Record<Variant, string> = {
  // Orange fill with navy text: ~7.9:1 contrast.
  primary: "bg-orange-500 text-navy-900 hover:bg-orange-400 font-semibold shadow-sm",
  navy: "bg-navy-900 text-white hover:bg-navy-800 font-semibold shadow-sm",
  secondary: "bg-white text-ink border border-line hover:bg-navy-50",
  ghost: "text-ink hover:bg-navy-50",
  danger: "bg-white text-bad border border-bad/40 hover:bg-bad-bg",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
}

export function Button({ variant = "secondary", size = "md", icon, className, children, type = "button", ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={clsx(
        "inline-flex items-center justify-center gap-1.5 rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "h-8 px-2.5 text-[13px]" : "h-10 px-3.5 text-sm",
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}

/** Square icon-only button. `label` is required for screen readers. */
export function IconButton({ label, icon, className, ...rest }: Omit<ButtonProps, "children"> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={clsx("inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted hover:bg-navy-50 hover:text-ink disabled:opacity-40", className)}
      {...rest}
    >
      {icon}
    </button>
  );
}
