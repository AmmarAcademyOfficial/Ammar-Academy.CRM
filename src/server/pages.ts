import "server-only";
import { redirect } from "next/navigation";
import type { Role } from "@/domain/types";
import { requireStaffPage, type Staff } from "./auth";

export const HOME: Record<Role, string> = { manager: "/overview", sales: "/my-work", support: "/my-work", accountant: "/accounting" };

/** Page guard: signed-in active staff with one of the given roles, else their home page. */
export async function pageFor(...roles: Role[]): Promise<Staff> {
  const staff = await requireStaffPage();
  if (!roles.includes(staff.role)) redirect(HOME[staff.role]);
  return staff;
}
