"use client";

import { cn as clsx } from "@/components/ui/cn";
import { CheckCircle2, AlertTriangle, X } from "lucide-react";
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

type Tone = "success" | "error";
interface Toast {
  id: number;
  tone: Tone;
  text: string;
  details?: string[];
}

const Ctx = createContext<(tone: Tone, text: string, details?: string[]) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((tone: Tone, text: string, details?: string[]) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, tone, text, details }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "error" ? 7000 : 3500);
  }, []);

  return (
    <Ctx.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex flex-col items-center gap-2 px-4 sm:bottom-6 sm:items-end sm:pr-6">
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.tone === "error" ? "alert" : "status"}
            className={clsx(
              "pointer-events-auto flex w-full max-w-sm items-start gap-2.5 rounded-xl border px-3.5 py-3 text-sm shadow-lg",
              t.tone === "success" ? "border-ok/30 bg-white" : "border-bad/30 bg-white",
            )}
          >
            {t.tone === "success" ? <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-ok" aria-hidden /> : <AlertTriangle size={18} className="mt-0.5 shrink-0 text-bad" aria-hidden />}
            <div className="min-w-0 flex-1">
              <p className="font-medium">{t.text}</p>
              {t.details && (
                <ul className="mt-1 list-disc pl-4 text-muted">
                  {t.details.map((d) => (
                    <li key={d}>{d}</li>
                  ))}
                </ul>
              )}
            </div>
            <button aria-label="Dismiss" className="text-muted hover:text-ink" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>
              <X size={16} />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast() {
  const push = useContext(Ctx);
  return {
    success: (text: string) => push("success", text),
    error: (text: string, details?: string[]) => push("error", text, details),
    /** Shows the result of a store action: success text, or the action's error. */
    result: (r: { ok: boolean; error?: string; details?: string[] }, successText: string) => {
      if (r.ok) push("success", successText);
      else push("error", r.error ?? "Something went wrong", r.details);
      return r.ok;
    },
  };
}
