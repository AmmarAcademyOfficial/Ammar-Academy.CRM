"use client";

/**
 * Client-side context for the signed-in workspace:
 *   - who is signed in and the reference data (from the server layout),
 *   - which customer panel is open,
 *   - a "data version" that screens watch to refetch after any change.
 * It holds no business data of its own; every list comes from the server.
 */
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Me, Reference } from "@/domain/dto";
import type { ID } from "@/domain/types";

interface Workspace {
  me: Me;
  ref: Reference;
  now: Date;
  openInquiryId: ID | null;
  openInquiry: (id: ID | null) => void;
  /** Bumps after every successful change so open lists refetch. */
  dataVersion: number;
  /** Call after a change. Pass reference=true when settings or users changed. */
  invalidate: (opts?: { reference?: boolean }) => void;
}

const Ctx = createContext<Workspace | null>(null);

export function WorkspaceProvider({ me, reference, serverNow, children }: { me: Me; reference: Reference; serverNow: number; children: ReactNode }) {
  const router = useRouter();
  // The first render uses the server's clock so the HTML from the server and the browser's first
  // render are identical (no hydration mismatch at a minute boundary); the live clock takes over
  // straight after.
  const [now, setNow] = useState(() => new Date(serverNow));
  const [openInquiryId, setOpenInquiryId] = useState<ID | null>(null);
  const [dataVersion, setDataVersion] = useState(0);

  useEffect(() => {
    const first = setTimeout(() => setNow(new Date()), 0);
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, []);

  const invalidate = useCallback(
    (opts?: { reference?: boolean }) => {
      setDataVersion((v) => v + 1);
      if (opts?.reference) router.refresh();
    },
    [router],
  );

  const value = useMemo<Workspace>(
    () => ({ me, ref: reference, now, openInquiryId, openInquiry: setOpenInquiryId, dataVersion, invalidate }),
    [me, reference, now, openInquiryId, dataVersion, invalidate],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWorkspace(): Workspace {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWorkspace must be used inside WorkspaceProvider");
  return v;
}

export interface ApiState<T> {
  data: T | undefined;
  error: string | undefined;
  loading: boolean;
  reload: () => void;
}

/**
 * Loads JSON from one of the app's API routes.
 * Refetches when the URL changes, after any successful change (dataVersion),
 * when the window regains focus, and every 60 seconds, so changes made by
 * other staff appear without a manual refresh.
 */
export function useApi<T>(url: string | null): ApiState<T> {
  const { dataVersion } = useWorkspace();
  const router = useRouter();
  const [tick, setTick] = useState(0);
  const key = url ? `${url}#${dataVersion}#${tick}` : null;
  // Results are stored with the key they answer, so "loading" is derived instead of set in the effect.
  const [state, setState] = useState<{ key: string | null; data?: T; error?: string }>({ key: null });

  useEffect(() => {
    if (!url || !key) return;
    const ctrl = new AbortController();
    fetch(url, { signal: ctrl.signal, cache: "no-store" })
      .then(async (r) => {
        if (r.status === 401) {
          router.replace("/login");
          return;
        }
        const body = await r.json().catch(() => ({}));
        if (!r.ok) setState((s) => ({ key, data: s.data, error: body.error ?? "Could not load data." }));
        else setState({ key, data: body as T });
      })
      .catch((e) => {
        if (e?.name !== "AbortError") setState((s) => ({ key, data: s.data, error: "You appear to be offline. Retrying shortly." }));
      });
    return () => ctrl.abort();
  }, [url, key, router]);

  useEffect(() => {
    if (!url) return;
    const onFocus = () => setTick((t) => t + 1);
    window.addEventListener("focus", onFocus);
    const t = setInterval(() => document.visibilityState === "visible" && setTick((x) => x + 1), 60_000);
    return () => {
      window.removeEventListener("focus", onFocus);
      clearInterval(t);
    };
  }, [url]);

  // "loading" only when the question changed (new URL); background refreshes keep showing current data.
  const answeredUrl = state.key?.split("#")[0] ?? null;
  return { data: state.data, error: state.key === key ? state.error : undefined, loading: !!url && answeredUrl !== url, reload: () => setTick((t) => t + 1) };
}
