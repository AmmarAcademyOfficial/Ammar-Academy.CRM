import {
  BarChart3,
  Calculator,
  CalendarClock,
  CalendarDays,
  CreditCard,
  Headset,
  LayoutDashboard,
  ListChecks,
  Settings,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { Role } from "@/domain/types";

export interface NavItem {
  path: string;
  label: string;
  icon: LucideIcon;
}

/** Role-appropriate navigation, as approved in Phase 0. */
export const NAV: Record<Role, NavItem[]> = {
  sales: [
    { path: "/my-work", label: "My Work", icon: ListChecks },
    { path: "/leads", label: "Leads", icon: Users },
    { path: "/follow-ups", label: "Follow-ups", icon: CalendarClock },
  ],
  support: [
    { path: "/my-work", label: "My Work", icon: ListChecks },
    { path: "/customers", label: "Customers", icon: Headset },
    { path: "/sessions", label: "Sessions", icon: CalendarDays },
    { path: "/follow-ups", label: "Follow-ups", icon: CalendarClock },
  ],
  manager: [
    { path: "/overview", label: "Overview", icon: LayoutDashboard },
    { path: "/leads", label: "Leads", icon: Users },
    { path: "/customers", label: "Support", icon: Headset },
    { path: "/sessions", label: "Sessions", icon: CalendarDays },
    { path: "/payments", label: "Payments", icon: CreditCard },
    { path: "/accounting", label: "Accounting", icon: Calculator },
    { path: "/reports", label: "Reports", icon: BarChart3 },
    { path: "/settings", label: "Settings", icon: Settings },
  ],
  // Phase 1: the accountant sees everything (read-only) and reviews it.
  accountant: [
    { path: "/accounting", label: "Accounting", icon: Calculator },
    { path: "/leads", label: "Leads", icon: Users },
    { path: "/customers", label: "Customers", icon: Headset },
    { path: "/sessions", label: "Sessions", icon: CalendarDays },
    { path: "/payments", label: "Payments", icon: CreditCard },
    { path: "/reports", label: "Reports", icon: BarChart3 },
  ],
};

export const HOME: Record<Role, string> = {
  sales: "/my-work",
  support: "/my-work",
  manager: "/overview",
  accountant: "/accounting",
};
