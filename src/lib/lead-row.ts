import type { LeadRowDTO, Reference } from "@/domain/dto";
import type { Contact, ContactOutcome, Course, FollowUp, Inquiry, Profile, Program, Stage, Tag } from "@/domain/types";

/** A lead row with its reference data resolved, ready for display. */
export interface LeadRow {
  inquiry: Inquiry;
  contact: Contact;
  program: Program;
  stage: Stage;
  outcome?: ContactOutcome;
  owner?: Profile;
  tags: Tag[];
  primaryTag?: Tag;
  nextFollowUp?: FollowUp;
  course?: Course;
}

const unknownStage: Stage = { id: "", systemKey: "new", label: "Unknown", order: 0, isClosed: false, agentSelectable: false };

export function hydrate(dto: LeadRowDTO, ref: Reference): LeadRow {
  const q = dto.inquiry;
  return {
    inquiry: q,
    contact: dto.contact,
    program: ref.programs.find((p) => p.id === q.programId) ?? { id: q.programId, code: "?", name: "Unknown", active: false },
    stage: ref.stages.find((s) => s.id === q.stageId) ?? unknownStage,
    outcome: ref.outcomes.find((o) => o.id === q.lastOutcomeId),
    owner: ref.profiles.find((p) => p.id === q.salesOwnerId),
    tags: q.tagIds.map((id) => ref.tags.find((t) => t.id === id)).filter((t): t is Tag => !!t),
    primaryTag: ref.tags.find((t) => t.id === q.primaryTagId),
    nextFollowUp: dto.nextFollowUp,
    course: q.courseId ? ref.courses.find((c) => c.id === q.courseId) : undefined,
  };
}

export function profileName(ref: Reference, id: string | null | undefined): string {
  if (!id) return "Unassigned";
  if (id === "system") return "System";
  return ref.profiles.find((p) => p.id === id)?.fullName ?? "Former staff";
}
