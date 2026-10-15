"use client";

import { cn as clsx } from "./cn";
import { X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { IconButton } from "./button";

interface OverlayProps {
  open: boolean;
  /** Called on Esc, backdrop click or the close button. May refuse (unsaved changes). */
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}

function useNativeDialog(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const cancel = (e: Event) => {
      e.preventDefault();
      onCloseRef.current();
    };
    const click = (e: MouseEvent) => {
      if (e.target === d) onCloseRef.current();
    };
    d.addEventListener("cancel", cancel);
    d.addEventListener("click", click);
    return () => {
      d.removeEventListener("cancel", cancel);
      d.removeEventListener("click", click);
    };
  }, []);
  return ref;
}

/** Centered modal dialog. Native <dialog> keeps focus inside and handles Esc. */
export function Dialog({ open, onClose, title, description, children, footer, className }: OverlayProps) {
  const ref = useNativeDialog(open, onClose);
  const id = useId();
  return (
    <dialog
      ref={ref}
      aria-labelledby={`${id}-title`}
      aria-describedby={description ? `${id}-desc` : undefined}
      className={clsx(
        "m-auto w-[calc(100%-32px)] max-w-lg rounded-2xl bg-white p-0 text-ink shadow-[var(--shadow-panel)]",
        className,
      )}
    >
      {open && (
        <div className="flex max-h-[85vh] flex-col">
          <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div>
              <h2 id={`${id}-title`} className="text-base font-semibold">{title}</h2>
              {description && <p id={`${id}-desc`} className="mt-0.5 text-sm text-muted">{description}</p>}
            </div>
            <IconButton label="Close" icon={<X size={18} />} onClick={onClose} className="-mr-2 -mt-1" />
          </header>
          <div className="overflow-y-auto px-5 py-4">{children}</div>
          {footer && <footer className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">{footer}</footer>}
        </div>
      )}
    </dialog>
  );
}

/** Right-hand side panel on desktop, full screen on phones. */
export function Drawer({ open, onClose, children, label }: { open: boolean; onClose: () => void; children: ReactNode; label: string }) {
  const ref = useNativeDialog(open, onClose);
  return (
    <dialog
      ref={ref}
      aria-label={label}
      className="drawer fixed inset-0 m-0 ml-auto h-dvh max-h-dvh w-full max-w-none bg-white p-0 text-ink shadow-[var(--shadow-panel)] sm:w-[min(640px,92vw)]"
    >
      {open && children}
    </dialog>
  );
}
