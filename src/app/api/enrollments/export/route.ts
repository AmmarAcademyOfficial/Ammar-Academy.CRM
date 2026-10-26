import { enrollmentExportQuerySchema } from "@/server/enrollment-filter-schema";
import { enrollmentsWorkbook, exportRoute } from "@/server/exports";
import { forbidden } from "@/server/result";

/**
 * Download the Enrollments list as Excel (Enrollments, Payments and Payment plan sheets): exactly what
 * the filters show, up to 20,000 rows. Managers and accountants (no phone numbers); logged.
 */
export async function POST(req: Request) {
  return exportRoute(async (staff) => {
    if (staff.role !== "manager" && staff.role !== "accountant") forbidden("Only managers and the accountant can download customers.");
    const parsed = enrollmentExportQuerySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw Object.assign(new Error("Invalid filters"), { code: "CRM01", message: "Those filters are not valid." });
    return enrollmentsWorkbook(staff, parsed.data);
  });
}
