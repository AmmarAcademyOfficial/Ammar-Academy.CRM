import "server-only";
import type { SessionAssignment, SessionsData } from "@/domain/dto";
import type { Staff } from "./auth";
import { asUser } from "./db";
import { mapSession } from "./mappers";

type Row = Record<string, unknown>;

/**
 * Sessions between two Cairo dates (managers: all; support: their customers and group courses),
 * past sessions still to record, and the teacher assignments the person may schedule for.
 */
export async function sessionsData(staff: Staff, from: string, to: string): Promise<SessionsData> {
  return asUser(staff.id, async (tx) => {
    const today = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
    const back = new Date(Date.now() + 3 * 3600_000 - 60 * 86_400_000).toISOString().slice(0, 10);
    const [rows, open, assignments] = await Promise.all([
      tx<Row[]>`select * from public.sessions_view(${from}::date, ${to}::date)`,
      tx<Row[]>`select * from public.sessions_view(${back}::date, ${today}::date) where status = 'scheduled' and starts_at < now()`,
      // Row-level security limits these to what the person may see; support can schedule only their own customers.
      tx<Row[]>`
        select a.*, c.name as customer_name, e.inquiry_id, co.name as course_name, t.full_name as teacher_name, o.support_owner_id
        from public.teacher_assignments a
        join public.teachers t on t.id = a.teacher_id
        left join public.enrollments e on e.id = a.enrollment_id
        left join public.inquiries i on i.id = e.inquiry_id
        left join public.contacts c on c.id = i.contact_id
        left join public.onboardings o on o.enrollment_id = a.enrollment_id
        left join public.courses co on co.id = a.course_id
        where a.ended_on is null
          and (${staff.role === "manager"} or a.course_id is not null or o.support_owner_id = ${staff.id})
        order by coalesce(c.name, co.name), t.full_name`,
    ]);
    return {
      range: { from, to },
      sessions: rows.map(mapSession),
      unrecorded: open.map(mapSession),
      assignments: assignments.map((a): SessionAssignment => ({
        id: String(a.id),
        teacherId: String(a.teacher_id),
        rateId: String(a.rate_id),
        enrollmentId: a.enrollment_id ? String(a.enrollment_id) : undefined,
        courseId: a.course_id ? String(a.course_id) : undefined,
        inquiryId: a.inquiry_id ? String(a.inquiry_id) : undefined,
        subject: a.subject ? String(a.subject) : undefined,
        label: `${a.customer_name ? String(a.customer_name) : `Group: ${String(a.course_name)}`} · ${String(a.teacher_name)}${a.subject ? ` (${String(a.subject)})` : ""}`,
      })),
    };
  });
}
