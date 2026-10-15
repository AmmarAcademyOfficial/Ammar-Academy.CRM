import type { NextRequest } from "next/server";
import { apiRoute } from "@/server/api";
import { paymentsPage, type PaymentTab } from "@/server/payment-queries";
import { forbidden } from "@/server/result";

export async function GET(req: NextRequest) {
  return apiRoute(async (staff) => {
    if (staff.role !== "manager") forbidden("Only managers review payments.");
    const tab = req.nextUrl.searchParams.get("tab");
    return paymentsPage(staff, (["pending", "confirmed", "closed"].includes(tab ?? "") ? tab : "pending") as PaymentTab);
  });
}
