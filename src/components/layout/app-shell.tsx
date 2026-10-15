"use client";

import { Bell, LogOut, MoreHorizontal, Pause, Play } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { NotificationList } from "@/domain/dto";
import { ROLE_LABEL } from "@/domain/permissions";
import { CAIRO_TZ, formatRelative } from "@/domain/rules";
import { useRunAction } from "@/lib/run-action";
import { useApi, useWorkspace } from "@/lib/workspace";
import { markNotificationsRead, setUserPaused } from "@/server/actions";
import { signOut } from "@/server/auth-actions";
import { cn as clsx } from "../ui/cn";
import { Avatar } from "../ui/misc";
import { NAV } from "./nav";

export function BrandMark() {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-orange-500 text-[17px] font-bold text-navy-900" aria-hidden>A</span>
      <span className="leading-tight">
        <span className="block text-[15px] font-semibold text-white">Ammar Academy</span>
        <span className="block text-[11px] font-medium uppercase tracking-[0.14em] text-orange-400">CRM</span>
      </span>
    </div>
  );
}

function CairoClock() {
  const { now } = useWorkspace();
  const t = new Intl.DateTimeFormat("en-GB", { timeZone: CAIRO_TZ, weekday: "short", hour: "numeric", minute: "2-digit" }).format(now);
  return <span className="text-xs text-navy-100/70">Cairo · {t}</span>;
}

/** Sales agents: take a break from new leads. A pause ends automatically when the shift ends. */
export function AvailabilityControl({ dark }: { dark?: boolean }) {
  const { me, ref } = useWorkspace();
  const runAction = useRunAction();
  if (me.role !== "sales") return null;
  const paused = ref.profiles.find((p) => p.id === me.id)?.paused ?? me.paused;
  return (
    <div className={clsx("rounded-xl p-3", dark ? "bg-white/5" : "border border-line bg-white")}>
      <p className={clsx("flex items-center gap-2 text-[13px] font-medium", dark ? "text-white" : "text-ink")}>
        <span className={clsx("h-2.5 w-2.5 rounded-full", paused ? "bg-[#8a8da3]" : "bg-[#3ccf7e]")} aria-hidden />
        {paused ? "Paused for new leads" : "Available for new leads"}
      </p>
      {ref.settings.agentsCanPause && (
        <button
          onClick={() => runAction(setUserPaused(me.id, !paused), paused ? "You are available for new leads again" : "Paused until you resume or your shift ends. Your current leads stay with you.", { reference: true })}
          className={clsx("mt-2 inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-lg text-[13px] font-medium", dark ? "bg-white/10 text-white hover:bg-white/15" : "border border-line hover:bg-navy-50")}
        >
          {paused ? <Play size={14} aria-hidden /> : <Pause size={14} aria-hidden />}
          {paused ? "Resume new leads" : "Pause new leads"}
        </button>
      )}
    </div>
  );
}

function NotificationsMenu() {
  const { now, openInquiry } = useWorkspace();
  const runAction = useRunAction();
  const { data } = useApi<NotificationList>("/api/notifications");
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const items = data?.items ?? [];
  const unread = data?.unread ?? 0;

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="relative inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted hover:bg-navy-50 hover:text-ink"
      >
        <Bell size={19} />
        {unread > 0 && (
          <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-orange-500 px-1 text-[10px] font-bold text-navy-900">{unread}</span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-2 w-[min(360px,calc(100vw-24px))] overflow-hidden rounded-xl border border-line bg-white shadow-[var(--shadow-panel)]">
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <p className="text-sm font-semibold">Notifications</p>
            {unread > 0 && (
              <button className="text-xs font-medium text-navy-700 hover:underline" onClick={() => runAction(markNotificationsRead(), null)}>Mark all read</button>
            )}
          </div>
          <ul className="max-h-96 overflow-y-auto">
            {items.length === 0 && <li className="px-4 py-8 text-center text-sm text-muted">You are all caught up.</li>}
            {items.map((n) => (
              <li key={n.id}>
                <button
                  className={clsx("flex w-full gap-3 px-4 py-3 text-left text-sm hover:bg-navy-50", !n.read && "bg-orange-50/60")}
                  onClick={() => {
                    if (n.inquiryId) openInquiry(n.inquiryId);
                    setOpen(false);
                  }}
                >
                  <span className={clsx("mt-1.5 h-2 w-2 shrink-0 rounded-full", n.read ? "bg-transparent" : "bg-orange-500")} aria-hidden />
                  <span className="min-w-0">
                    <bdi dir="auto" className="block">{n.text}</bdi>
                    <span className="text-xs text-muted">{formatRelative(n.createdAt, now)}{!n.read && <span className="sr-only"> · unread</span>}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { me } = useWorkspace();
  const path = usePathname();
  const items = NAV[me.role];
  const isActive = (p: string) => path === p || path.startsWith(p + "/");
  const mobileItems = items.slice(0, items.length > 5 ? 4 : 5);

  return (
    <div className="flex min-h-dvh flex-col">
      <div className="flex flex-1">
        <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col bg-navy-900 px-3 py-4 lg:flex">
          <div className="px-2"><BrandMark /></div>
          <nav aria-label="Main" className="mt-7 flex flex-col gap-0.5">
            {items.map(({ path: p, label, icon: Icon }) => (
              <Link
                key={p}
                href={p}
                aria-current={isActive(p) ? "page" : undefined}
                className={clsx("flex h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors", isActive(p) ? "bg-white/10 text-white" : "text-navy-100/75 hover:bg-white/5 hover:text-white")}
              >
                <Icon size={18} aria-hidden className={isActive(p) ? "text-orange-400" : ""} />
                {label}
              </Link>
            ))}
          </nav>
          <div className="mt-auto space-y-3">
            <AvailabilityControl dark />
            <div className="flex items-center gap-2.5 rounded-xl px-2 py-1.5">
              <Avatar name={me.fullName} size={32} className="bg-white/10 text-white" />
              <div className="min-w-0 flex-1 leading-tight">
                <p className="truncate text-sm font-medium text-white">{me.fullName}</p>
                <p className="text-xs text-navy-100/70">{ROLE_LABEL[me.role]}</p>
              </div>
              <form action={signOut}>
                <button type="submit" aria-label="Sign out" title="Sign out" className="rounded-lg p-2 text-navy-100/70 hover:bg-white/10 hover:text-white">
                  <LogOut size={16} />
                </button>
              </form>
            </div>
            <div className="px-2"><CairoClock /></div>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-line bg-white/95 px-4 backdrop-blur lg:px-8">
            <span className="flex items-center gap-2 lg:hidden">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-navy-900 text-sm font-bold text-orange-400" aria-hidden>A</span>
              <span className="text-sm font-semibold text-navy-900">Ammar Academy CRM</span>
            </span>
            <div className="ml-auto flex items-center gap-1">
              <NotificationsMenu />
              <form action={signOut} className="lg:hidden">
                <button type="submit" aria-label={`Sign out ${me.fullName}`} className="rounded-lg p-1">
                  <Avatar name={me.fullName} size={30} />
                </button>
              </form>
            </div>
          </header>
          <main id="main" className="mx-auto w-full max-w-[1400px] flex-1 px-4 pb-28 pt-6 lg:px-8 lg:pb-12">{children}</main>
        </div>
      </div>

      <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-30 flex border-t border-line bg-white pb-[env(safe-area-inset-bottom)] lg:hidden">
        {mobileItems.map(({ path: p, label, icon: Icon }) => (
          <Link key={p} href={p} aria-current={isActive(p) ? "page" : undefined} className={clsx("flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] font-medium", isActive(p) ? "text-navy-900" : "text-muted")}>
            <span className={clsx("rounded-full px-3 py-1", isActive(p) && "bg-orange-100")}><Icon size={19} aria-hidden /></span>
            {label}
          </Link>
        ))}
        {items.length > 5 && (
          <Link href="/settings" aria-current={isActive("/settings") ? "page" : undefined} className={clsx("flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] font-medium", isActive("/settings") ? "text-navy-900" : "text-muted")}>
            <span className={clsx("rounded-full px-3 py-1", isActive("/settings") && "bg-orange-100")}><MoreHorizontal size={19} aria-hidden /></span>
            More
          </Link>
        )}
      </nav>
    </div>
  );
}
