import "server-only";
import type { ReportData } from "@/domain/dto";
import type { Staff } from "./auth";
import { asUser } from "./db";

export interface ReportParams { from: string; to: string; programId?: string; courseTypeId?: string }

/** All report figures come from one checked database function (manager-only, definitions in the migration). */
export async function getReport(staff: Staff, p: ReportParams): Promise<ReportData> {
  return asUser(staff.id, async (tx) => {
    const [row] = await tx<{ r: ReportData }[]>`select public.report(${tx.json({ from: p.from, to: p.to, program_id: p.programId ?? null, course_type_id: p.courseTypeId ?? null })}) as r`;
    return normalize(row.r);
  });
}

/** numeric values arrive from jsonb as numbers already; medians may be null. */
function normalize(r: ReportData): ReportData {
  const money = (m: { currency: string; amount: number | string }[]) => m.map((x) => ({ ...x, amount: Number(x.amount) }));
  return {
    ...r,
    confirmed: r.confirmed.map((c) => ({ ...c, amount: Number(c.amount) })),
    agents: r.agents.map((a) => ({ ...a, confirmed: money(a.confirmed), medianWorkingMinutes: a.medianWorkingMinutes == null ? null : Number(a.medianWorkingMinutes) })),
    courses: r.courses.map((c) => ({ ...c, price: c.price == null ? null : Number(c.price), confirmed: money(c.confirmed) })),
    courseTypes: r.courseTypes.map((c) => ({ ...c, confirmed: money(c.confirmed) })),
  };
}
