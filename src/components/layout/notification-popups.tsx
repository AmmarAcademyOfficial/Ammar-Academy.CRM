"use client";

import { BellRing, X } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { NotificationList } from "@/domain/dto";
import type { AppNotification } from "@/domain/types";
import { bindChimeUnlock, desktopAlertState, playChime, soundEnabled, subscribeAlertSettings } from "@/lib/chime";
import { useWorkspace } from "@/lib/workspace";

const MAX_SHOWN = 3;
const SHOW_MS = 15_000;

export function useSoundOn() {
  return useSyncExternalStore(subscribeAlertSettings, soundEnabled, () => true);
}
export function useDesktopAlertState() {
  return useSyncExternalStore(subscribeAlertSettings, desktopAlertState, () => "unsupported" as const);
}

interface PopupState {
  data?: NotificationList;
  /** Ids already known. null until the first load: what is there on arrival never pops up. */
  seen: Set<string> | null;
  shown: AppNotification[];
  extra: number;
  batch: { n: number; items: AppNotification[] };
}

/**
 * New notifications whose rule says "pop-up and sound" appear at the bottom of the screen with a
 * chime. When the tab is in the background and desktop alerts are allowed, a desktop alert is shown.
 */
export function NotificationPopups({ data }: { data: NotificationList | undefined }) {
  const { openInquiry } = useWorkspace();
  const sound = useSoundOn();
  const [st, setSt] = useState<PopupState>({ seen: null, shown: [], extra: 0, batch: { n: 0, items: [] } });

  // New data: work out what is new (adjusting state while rendering, React's documented pattern).
  if (data && data !== st.data) {
    const ids = data.items.map((n) => n.id);
    if (st.seen === null) {
      setSt({ ...st, data, seen: new Set(ids) });
    } else {
      const fresh = data.items.filter((n) => !st.seen!.has(n.id) && !n.read && n.popup);
      const all = [...fresh, ...st.shown];
      setSt({
        data,
        seen: new Set([...st.seen, ...ids]),
        shown: all.slice(0, MAX_SHOWN),
        extra: fresh.length ? st.extra + Math.max(0, all.length - MAX_SHOWN) : st.extra,
        batch: fresh.length ? { n: st.batch.n + 1, items: fresh } : st.batch,
      });
    }
  }

  useEffect(() => bindChimeUnlock(), []);

  // Sound and desktop alert once per batch of new pop-ups.
  useEffect(() => {
    if (st.batch.n === 0) return;
    if (sound) playChime();
    if (document.visibilityState === "hidden" && desktopAlertState() === "granted") {
      const items = st.batch.items;
      try {
        const alert = new window.Notification(items.length === 1 ? "Ammar Academy CRM" : `Ammar Academy CRM · ${items.length} new`, {
          body: items[0].text,
          tag: items[0].id,
          icon: "/icon.png",
        });
        alert.onclick = () => {
          window.focus();
          if (items[0].inquiryId) openInquiry(items[0].inquiryId);
          alert.close();
        };
      } catch {
        /* some phones only allow desktop alerts from a service worker */
      }
    }
    // Only when a new batch arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st.batch.n]);

  const dismiss = (id: string) => setSt((s) => ({ ...s, shown: s.shown.filter((n) => n.id !== id), extra: s.shown.length <= 1 ? 0 : s.extra }));

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="New notifications"
      className="pointer-events-none fixed inset-x-3 bottom-20 z-50 flex flex-col items-end gap-2 lg:inset-x-auto lg:bottom-5 lg:right-5"
    >
      {st.shown.map((n) => (
        <PopupCard
          key={n.id}
          n={n}
          onOpen={() => {
            if (n.inquiryId) openInquiry(n.inquiryId);
            dismiss(n.id);
          }}
          onClose={() => dismiss(n.id)}
        />
      ))}
      {st.shown.length > 0 && st.extra > 0 && (
        <p className="pointer-events-auto rounded-lg bg-navy-900 px-3 py-1.5 text-xs font-medium text-white shadow">
          +{st.extra} more in the bell
        </p>
      )}
    </div>
  );
}

function PopupCard({ n, onOpen, onClose }: { n: AppNotification; onOpen: () => void; onClose: () => void }) {
  const [hover, setHover] = useState(false);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  // Closes by itself after a while; hovering or focusing it keeps it open.
  useEffect(() => {
    if (hover) return;
    const t = setTimeout(() => close.current(), SHOW_MS);
    return () => clearTimeout(t);
  }, [hover]);

  return (
    <div
      data-popup={n.kind ?? "other"}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      className="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border border-line bg-white p-3 shadow-[var(--shadow-panel)] motion-safe:animate-[popup-in_180ms_ease-out]"
    >
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-orange-100 text-orange-700" aria-hidden>
        <BellRing size={16} />
      </span>
      <div className="min-w-0 flex-1 text-sm">
        <bdi dir="auto" className="block">{n.text}</bdi>
        {n.inquiryId && (
          <button onClick={onOpen} className="mt-1.5 text-xs font-semibold text-navy-700 hover:underline">
            Open
          </button>
        )}
      </div>
      <button onClick={onClose} aria-label="Dismiss notification" className="-m-1 rounded-md p-1 text-muted hover:bg-navy-50 hover:text-ink">
        <X size={15} />
      </button>
    </div>
  );
}
