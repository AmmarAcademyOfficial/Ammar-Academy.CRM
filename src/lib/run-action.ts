"use client";

import { useRouter } from "next/navigation";
import { useCallback } from "react";
import { useToast } from "@/components/ui/toast";
import { useWorkspace } from "./workspace";

type Result<T> = { ok: true; value: T } | { ok: false; error: string; details?: string[]; code?: string };

/**
 * Runs a server action, shows a toast with the outcome and refreshes data.
 * Returns the value on success, or undefined on failure (the toast already explained why).
 */
export function useRunAction() {
  const toast = useToast();
  const { invalidate } = useWorkspace();
  const router = useRouter();
  return useCallback(
    async <T,>(action: Promise<Result<T>>, success: string | null, opts?: { reference?: boolean; quiet?: boolean }): Promise<{ ok: true; value: T } | { ok: false; code?: string }> => {
      let r: Result<T>;
      try {
        r = await action;
      } catch {
        r = { ok: false, error: "Could not reach the server. Check your connection and try again." };
      }
      if (r.ok) {
        if (success) toast.success(success);
        invalidate(opts);
        return r;
      }
      if (r.code === "unauthenticated") {
        router.replace("/login");
        return { ok: false, code: r.code };
      }
      if (!opts?.quiet || r.code !== "conflict") toast.error(r.error, r.details);
      return { ok: false, code: r.code };
    },
    [toast, invalidate, router],
  );
}
