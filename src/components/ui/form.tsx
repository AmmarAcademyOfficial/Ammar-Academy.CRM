import { cn as clsx } from "./cn";
import { useId, type ComponentProps, type ReactNode } from "react";
import { SearchSelect } from "./search-select";
import { optionsOf, SEARCH_FROM } from "./search-text";

const control =
  "w-full rounded-lg border border-line bg-white px-3 text-sm text-ink placeholder:text-muted/70 focus:border-navy-600 focus:outline-none focus:ring-2 focus:ring-navy-600/20 disabled:bg-canvas disabled:text-muted aria-[invalid=true]:border-bad";

interface FieldProps {
  label: string;
  error?: string;
  hint?: string;
  required?: boolean;
  children: (props: { id: string; "aria-invalid"?: boolean; "aria-describedby"?: string }) => ReactNode;
  className?: string;
}

/** Label + control + hint/error, wired with ids for screen readers. */
export function Field({ label, error, hint, required, children, className }: FieldProps) {
  const id = useId();
  const msgId = `${id}-msg`;
  return (
    <div className={clsx("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-[13px] font-medium text-ink">
        {label}
        {required && <span className="ml-0.5 text-bad" aria-hidden>*</span>}
        {required && <span className="sr-only"> (required)</span>}
      </label>
      {children({ id, "aria-invalid": error ? true : undefined, "aria-describedby": error || hint ? msgId : undefined })}
      {(error || hint) && (
        <p id={msgId} className={clsx("text-xs", error ? "text-bad" : "text-muted")}>
          {error ?? hint}
        </p>
      )}
    </div>
  );
}

export function Input({ className, ...rest }: ComponentProps<"input">) {
  return <input dir="auto" className={clsx(control, "h-10", className)} {...rest} />;
}

export function Textarea({ className, ...rest }: ComponentProps<"textarea">) {
  return <textarea dir="auto" className={clsx(control, "min-h-[84px] py-2 leading-relaxed", className)} {...rest} />;
}

/**
 * A dropdown. With more than 7 choices it also gets a search button (see SearchSelect), on every
 * screen at once; shorter lists stay a plain select. searchable={false} turns the button off.
 */
export function Select({ className, children, searchable, ...rest }: ComponentProps<"select"> & { searchable?: boolean }) {
  if (searchable !== false && !rest.multiple && optionsOf(children).length >= SEARCH_FROM) {
    return <SearchSelect className={className} controlClass={control} {...rest}>{children}</SearchSelect>;
  }
  return (
    <select className={clsx(control, "h-10 pr-8", className)} {...rest}>
      {children}
    </select>
  );
}

export function Checkbox({ label, checked, onChange, disabled, description }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; description?: string }) {
  const id = useId();
  return (
    <div className="flex items-start gap-2.5">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 rounded border-line accent-navy-900"
      />
      <label htmlFor={id} className="text-sm leading-snug">
        {label}
        {description && <span className="block text-xs text-muted">{description}</span>}
      </label>
    </div>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50",
        checked ? "bg-navy-900" : "bg-line",
      )}
    >
      <span className={clsx("inline-block h-5 w-5 rounded-full bg-white shadow transition-transform", checked ? "translate-x-5" : "translate-x-0.5")} />
    </button>
  );
}
