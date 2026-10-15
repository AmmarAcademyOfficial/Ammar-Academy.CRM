import { redirect } from "next/navigation";
import { requireStaffPage } from "@/server/auth";
import { HOME } from "@/server/pages";

export default async function Home() {
  const staff = await requireStaffPage();
  redirect(HOME[staff.role]);
}
