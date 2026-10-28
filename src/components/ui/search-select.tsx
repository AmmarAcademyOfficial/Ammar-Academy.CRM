"use client";

import { Search, X } from "lucide-react";
import { Children, isValidElement, useEffect, useId, useMemo, useRef, useState, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { cn as clsx } from "./cn";
import { matches, optionsOf, SEARCH_FROM, textOf } from "./search-text";

export { matches, searchText, SEARCH_FROM } from "./search-text";

/**
 * A native select plus a search button: the button opens a search box with the matching choices;
 * picking one sets the select exactly as choosing it in the list would (the screen's onChange runs).
 * The select itself stays, so keyboards, phones and screen readers keep the native behaviour.
 */
export function SearchSelect({ className, children, controlClass, ...rest }: ComponentProps<"select"> & { controlClass: string }) {
  const options = useMemo(() => optionsOf(children), [children]);
  const selectRef = useRef<HTMLSelectElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  // The list's own name (its aria-label, or the label of its Field), for the search box.
  const [label, setLabel] = useState(rest["aria-label"] ?? "the list");
  useEffect(() => {
    const own = rest["aria-label"] ?? selectRef.current?.labels?.[0]?.textContent?.replace(/\*|\(required\)/g, "").trim();
    if (own) setLabel(own);
  }, [rest]);
  const found = options.filter((o) => !o.disabled && matches(`${o.label} ${o.group ?? ""}`, q));

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!boxRef.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const choose = (value: string) => {
    const el = selectRef.current;
    if (el) {
      // Set the value the way the browser does, then let React see a normal change event.
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(el, value);
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.focus();
    }
    setOpen(false);
    setQ("");
  };

  return (
    <div ref={boxRef} className={clsx("relative flex min-w-0 items-stretch gap-1.5", className?.includes("w-auto") ? "inline-flex" : "w-full")}>
      <select ref={selectRef} className={clsx(controlClass, "h-10 min-w-0 flex-1 pr-8", className)} {...rest}>
        {children}
      </select>
      <button
        type="button"
        aria-label="Search this list"
        title={`Search ${label}`}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        disabled={rest.disabled}
        onClick={() => { setOpen((o) => !o); setActive(0); }}
        className={clsx("inline-flex shrink-0 items-center justify-center rounded-lg border border-line bg-white text-muted hover:bg-navy-50 hover:text-ink disabled:opacity-40",
          /\bh-(8|9)\b/.test(className ?? "") ? "h-8 w-8" : "h-10 w-10")}
      >
        <Search size={16} aria-hidden />
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-full z-40 mt-1 rounded-lg border border-line bg-white p-2 shadow-[var(--shadow-panel)]">
          <div className="relative">
            <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
            <input
              autoFocus
              dir="auto"
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-label={`Search ${label}`}
              aria-activedescendant={found[active] ? `${listId}-${active}` : undefined}
              placeholder="Type to search"
              value={q}
              onChange={(e) => { setQ(e.target.value); setActive(0); }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, found.length - 1)); }
                else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
                else if (e.key === "Enter") { e.preventDefault(); if (found[active]) choose(found[active].value); }
                else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setOpen(false); selectRef.current?.focus(); }
              }}
              className="h-9 w-full rounded-md border border-line pl-8 pr-8 text-sm focus:border-navy-600 focus:outline-none focus:ring-2 focus:ring-navy-600/20"
            />
            {q && (
              <button type="button" aria-label="Clear the search" onClick={() => setQ("")} className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted hover:text-ink">
                <X size={13} aria-hidden />
              </button>
            )}
          </div>
          <ul id={listId} role="listbox" aria-label={`Matches in ${label}`} className="scrollbar-thin mt-1.5 max-h-64 overflow-y-auto">
            {found.length === 0 ? (
              <li className="px-2 py-2 text-sm text-muted">No match. Try fewer letters.</li>
            ) : found.map((o, i) => (
              <li
                key={`${o.group ?? ""}|${o.value}`}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={String(rest.value ?? "") === o.value}
                onMouseDown={(e) => { e.preventDefault(); choose(o.value); }}
                onMouseEnter={() => setActive(i)}
                className={clsx("cursor-pointer rounded-md px-2 py-1.5 text-sm", i === active ? "bg-navy-50" : "", String(rest.value ?? "") === o.value && "font-semibold")}
              >
                <bdi dir="auto">{o.label}</bdi>
                {o.group && <span className="ml-2 text-xs text-muted">{o.group}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * A tick list (filters, a teacher's programs) with a search box once it has more than 7 items.
 * Ticked items always stay visible, so a search never hides what is chosen.
 */
export function SearchChecklist({ label, children }: { label: string; children: ReactNode }) {
  const items = Children.toArray(children).filter(isValidElement) as ReactElement<{ label?: ReactNode; checked?: boolean }>[];
  const [q, setQ] = useState("");
  if (items.length < SEARCH_FROM) return <>{children}</>;
  const shown = items.filter((el) => el.props.checked || matches(textOf(el.props.label), q));
  return (
    <div className="space-y-2">
      <div className="relative">
        <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
        <input
          type="search"
          dir="auto"
          aria-label={`Search ${label}`}
          placeholder={`Search ${label.toLowerCase()}`}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="h-9 w-full rounded-md border border-line pl-8 pr-2 text-sm focus:border-navy-600 focus:outline-none focus:ring-2 focus:ring-navy-600/20"
        />
      </div>
      <div className="scrollbar-thin max-h-56 space-y-1.5 overflow-y-auto pr-1">
        {shown}
        {shown.length === 0 && <p className="text-sm text-muted">No match. Try fewer letters.</p>}
      </div>
    </div>
  );
}
