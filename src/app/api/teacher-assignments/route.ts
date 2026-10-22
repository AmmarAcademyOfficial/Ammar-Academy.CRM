import { apiRoute } from "@/server/api";
import { asUser } from "@/server/db";
import { mapTeacherAssignment } from "@/server/mappers";
import { forbidden } from "@/server/result";

/** Every teacher assignment with the customer's name (managers and accountants; no phone numbers). */
export async function GET() {
  return apiRoute(async (staff) => {
    if (staff.role !== "manager" && staff.role !== "accountant") forbidden("Teacher assignments are for managers and accountants.");
    const rows = await asUser(staff.id, (tx) => tx<Record<string, unknown>[]>`select * from public.teacher_assignments_view()`);
    return rows.map(mapTeacherAssignment);
  });
}
