import type { LeadFilters, SavedView } from "./types";

export const EMPTY_FILTERS: LeadFilters = {
  search: "",
  programIds: [],
  stageKeys: [],
  outcomeIds: [],
  tagIds: [],
  primaryColors: [],
  ownerIds: [],
  courseIds: [],
  courseTypeIds: [],
  followUp: "any",
  uncontactedOnly: false,
  unopenedOnly: false,
  dateField: "created",
  dateFrom: "",
  dateTo: "",
};

/** Built-in views everyone gets. Sales see only their own leads anyway, so no owner filter is needed. */
export const BUILT_IN_VIEWS: SavedView[] = [
  { id: "builtin-new", name: "My New Leads", builtIn: true, filters: { ...EMPTY_FILTERS, stageKeys: ["new"] } },
  { id: "builtin-unopened", name: "Not Opened Yet", builtIn: true, filters: { ...EMPTY_FILTERS, unopenedOnly: true } },
  { id: "builtin-callbacks", name: "Callbacks Today", builtIn: true, filters: { ...EMPTY_FILTERS, followUp: "today" } },
  { id: "builtin-overdue", name: "Overdue", builtIn: true, filters: { ...EMPTY_FILTERS, followUp: "overdue" } },
  { id: "builtin-payment", name: "Awaiting Payment", builtIn: true, filters: { ...EMPTY_FILTERS, stageKeys: ["awaiting_payment"] } },
];

export function activeFilterCount(f: LeadFilters): number {
  return (
    f.programIds.length +
    f.stageKeys.length +
    f.outcomeIds.length +
    f.tagIds.length +
    f.primaryColors.length +
    f.ownerIds.length +
    (f.courseIds?.length ?? 0) +
    (f.courseTypeIds?.length ?? 0) +
    (f.followUp !== "any" ? 1 : 0) +
    (f.uncontactedOnly ? 1 : 0) +
    (f.unopenedOnly ? 1 : 0) +
    (f.dateFrom || f.dateTo ? 1 : 0)
  );
}

/** Saved views created before a filter existed get its empty value. */
export function withDefaults(f: Partial<LeadFilters>): LeadFilters {
  return { ...EMPTY_FILTERS, ...f };
}
