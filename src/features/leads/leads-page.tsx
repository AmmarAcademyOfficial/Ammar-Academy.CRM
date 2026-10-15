"use client";

import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Columns3, Inbox, Plus, Save, Search, SlidersHorizontal, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { StageBadge, TAG_COLORS } from "@/components/ui/badges";
import { Button, IconButton } from "@/components/ui/button";
import { cn as clsx } from "@/components/ui/cn";
import { Checkbox, Field, Input } from "@/components/ui/form";
import { Card, EmptyState, Name, PageHeader, PhoneText, SkeletonRows } from "@/components/ui/misc";
import { Dialog } from "@/components/ui/overlay";
import type { LeadPage, LeadQuery, LeadSortKey } from "@/domain/dto";
import { activeFilterCount, BUILT_IN_VIEWS, EMPTY_FILTERS } from "@/domain/filters";
import { followUpTiming, formatCairo } from "@/domain/rules";
import type { LeadFilters } from "@/domain/types";
import { hydrate } from "@/lib/lead-row";
import { useRunAction } from "@/lib/run-action";
import { useApi, useWorkspace } from "@/lib/workspace";
import { deleteView, saveView, setColumns } from "@/server/actions";
import { AddCustomerDialog } from "./add-customer";
import { COLUMNS, DEFAULT_COLUMNS } from "./columns";
import { FilterChips, FilterDialog } from "./filters";

const PAGE_SIZE = 25;

/** Waits until typing pauses before searching. */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function LeadsPage() {
  const { me, ref, now, openInquiry } = useWorkspace();
  const runAction = useRunAction();
  const [filters, setFilters] = useState<LeadFilters>(EMPTY_FILTERS);
  const [viewId, setViewId] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: LeadSortKey; dir: "asc" | "desc" }>({ key: "created", dir: "desc" });
  const [page, setPage] = useState(0);
  const [modal, setModal] = useState<null | "filters" | "columns" | "save" | "add">(null);
  const [viewName, setViewName] = useState("");

  const search = useDebounced(filters.search, 300);
  const query: LeadQuery = useMemo(() => ({ filters: { ...filters, search }, sort, page, pageSize: PAGE_SIZE }), [filters, search, sort, page]);
  const { data, loading, error } = useApi<LeadPage>(`/api/leads?q=${encodeURIComponent(JSON.stringify(query))}`);
  const queueUrl = me.role === "manager" ? `/api/leads?q=${encodeURIComponent(JSON.stringify({ filters: { ...EMPTY_FILTERS, ownerIds: ["unassigned"], stageKeys: ["new", "contacting", "qualified", "awaiting_payment"] }, sort: { key: "created", dir: "asc" }, page: 0, pageSize: 5 }))}` : null;
  const queue = useApi<LeadPage>(queueUrl);

  const views = [...BUILT_IN_VIEWS, ...ref.savedViews];
  const columnKeys = (ref.leadColumns ?? DEFAULT_COLUMNS).filter((k) => COLUMNS.some((c) => c.key === k));
  const columns = columnKeys.map((k) => COLUMNS.find((c) => c.key === k)!);
  const rows = useMemo(() => (data?.rows ?? []).map((r) => hydrate(r, ref)), [data, ref]);
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const apply = (f: LeadFilters, view: string | null = null) => {
    setFilters(f);
    setViewId(view);
    setPage(0);
  };
  const toggleSort = (key: LeadSortKey) => {
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));
    setPage(0);
  };
  const hasFilters = activeFilterCount(filters) > 0 || !!filters.search;

  return (
    <div>
      <PageHeader
        title={me.role === "manager" ? "All leads" : "My leads"}
        subtitle={data ? `${total} ${hasFilters ? "matching " : ""}inquir${total === 1 ? "y" : "ies"}${me.role === "manager" ? "" : " assigned to you"}` : " "}
        actions={<Button variant="primary" icon={<Plus size={16} />} onClick={() => setModal("add")}>Add customer</Button>}
      />

      <div className="scrollbar-thin -mx-4 mb-4 flex gap-2 overflow-x-auto px-4 pb-1 lg:mx-0 lg:px-0" role="tablist" aria-label="Saved views">
        <ViewTab active={viewId === null && !hasFilters} onClick={() => apply(EMPTY_FILTERS)}>All</ViewTab>
        {views.map((v) => (
          <ViewTab key={v.id} active={viewId === v.id} onClick={() => apply({ ...EMPTY_FILTERS, ...v.filters }, v.id)}>
            {v.name}
            {!v.builtIn && viewId === v.id && (
              <span
                role="button"
                tabIndex={0}
                aria-label={`Delete view ${v.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  void runAction(deleteView(v.id), "View deleted", { reference: true });
                  apply(EMPTY_FILTERS);
                }}
                className="ml-1 rounded p-0.5 hover:bg-white/20"
              >
                <Trash2 size={12} />
              </span>
            )}
          </ViewTab>
        ))}
        {me.role === "manager" && (queue.data?.total ?? 0) > 0 && (
          <ViewTab active={viewId === "unassigned"} warn onClick={() => apply({ ...EMPTY_FILTERS, ownerIds: ["unassigned"] }, "unassigned")}>
            Unassigned queue · {queue.data?.total}
          </ViewTab>
        )}
      </div>

      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
          <div className="relative min-w-[220px] flex-1">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
            <Input
              type="search"
              aria-label="Search by name or phone"
              placeholder="Search name or phone (e.g. 0100 555, +20 100…)"
              value={filters.search}
              onChange={(e) => {
                setFilters({ ...filters, search: e.target.value });
                setPage(0);
              }}
              className="pl-9"
            />
          </div>
          <Button icon={<SlidersHorizontal size={16} />} onClick={() => setModal("filters")}>
            Filters{activeFilterCount(filters) ? ` · ${activeFilterCount(filters)}` : ""}
          </Button>
          <Button icon={<Columns3 size={16} />} onClick={() => setModal("columns")} className="hidden md:inline-flex">Columns</Button>
          <Button icon={<Save size={16} />} onClick={() => setModal("save")} disabled={!hasFilters}>Save view</Button>
        </div>
        {activeFilterCount(filters) > 0 && (
          <div className="border-b border-line px-3 py-2.5"><FilterChips value={filters} onChange={(f) => apply(f, null)} /></div>
        )}
        <p className="sr-only" aria-live="polite">{data ? `${total} results` : ""}</p>
        {error && <p role="alert" className="border-b border-line bg-bad-bg px-4 py-2 text-sm text-bad">{error}</p>}

        {!data && loading ? (
          <SkeletonRows rows={8} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Inbox size={22} />}
            title={hasFilters ? "No leads match these filters" : "No leads yet"}
            action={hasFilters ? <Button onClick={() => apply(EMPTY_FILTERS)}>Clear Filters</Button> : <Button variant="primary" onClick={() => setModal("add")}>Add customer</Button>}
          >
            {hasFilters ? "Try removing a filter or searching by part of the phone number." : me.role === "manager" ? "Add a customer, or connect Google Sheets in Settings." : "New inquiries appear here as soon as they are assigned to you."}
          </EmptyState>
        ) : (
          <div className={clsx(loading && "opacity-60 transition-opacity")}>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-line text-xs text-muted">
                    {columns.map((c) => (
                      <th key={c.key} scope="col" className="whitespace-nowrap px-3 py-2.5 font-medium first:pl-5" aria-sort={c.sort && sort.key === c.sort ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}>
                        {c.sort ? (
                          <button className="inline-flex items-center gap-1 hover:text-ink" onClick={() => toggleSort(c.sort!)}>
                            {c.label}
                            {sort.key === c.sort && (sort.dir === "asc" ? <ArrowUp size={12} aria-hidden /> : <ArrowDown size={12} aria-hidden />)}
                          </button>
                        ) : (
                          c.label
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr
                      key={r.inquiry.id}
                      onClick={() => openInquiry(r.inquiry.id)}
                      className="cursor-pointer border-b border-line/70 last:border-0 hover:bg-navy-50/60"
                      style={{ boxShadow: r.primaryTag ? `inset 4px 0 0 ${TAG_COLORS[r.primaryTag.color].dot}` : undefined }}
                    >
                      {columns.map((c, i) => (
                        <td key={c.key} className={clsx("px-3 py-2.5 align-middle", i === 0 && "max-w-[260px] pl-5")}>
                          {i === 0 ? (
                            <button className="w-full text-left focus-visible:outline-offset-4" onClick={(e) => { e.stopPropagation(); openInquiry(r.inquiry.id); }}>
                              {c.render(r, now)}
                            </button>
                          ) : (
                            c.render(r, now)
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <ul className="divide-y divide-line md:hidden">
              {rows.map((r) => {
                const f = r.nextFollowUp;
                const t = f && followUpTiming(f, now);
                return (
                  <li key={r.inquiry.id} style={{ boxShadow: r.primaryTag ? `inset 4px 0 0 ${TAG_COLORS[r.primaryTag.color].dot}` : undefined }}>
                    <button className="flex w-full flex-col gap-1.5 px-4 py-3 text-left" onClick={() => openInquiry(r.inquiry.id)}>
                      <span className="flex w-full items-center justify-between gap-2">
                        <Name className="truncate font-medium">{r.contact.name}</Name>
                        <span className="text-xs font-semibold text-muted">{r.program.code}</span>
                      </span>
                      <span className="flex flex-wrap items-center gap-2 text-xs">
                        <StageBadge stage={r.stage} />
                        <PhoneText value={r.contact.phoneNormalized} className="text-muted" />
                      </span>
                      <span className={clsx("text-xs", t === "overdue" ? "font-medium text-bad" : "text-muted")}>
                        {f ? `${t === "overdue" ? "Overdue" : "Next"}: ${f.note} · ${formatCairo(f.dueAt)}` : r.stage.isClosed ? "Closed" : "No next action set"}
                        {me.role === "manager" && ` · ${r.owner?.fullName ?? "Unassigned"}`}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>

            <div className="flex items-center justify-between border-t border-line px-4 py-2.5 text-sm text-muted">
              <span>{page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}</span>
              <div className="flex items-center gap-1">
                <IconButton label="Previous page" icon={<ChevronLeft size={18} />} disabled={page === 0} onClick={() => setPage(page - 1)} />
                <span className="px-1 text-xs">Page {page + 1} of {pages}</span>
                <IconButton label="Next page" icon={<ChevronRight size={18} />} disabled={page >= pages - 1} onClick={() => setPage(page + 1)} />
              </div>
            </div>
          </div>
        )}
      </Card>

      {modal === "add" && <AddCustomerDialog onClose={() => setModal(null)} />}
      {modal === "filters" && <FilterDialog value={filters} onClose={() => setModal(null)} onApply={(f) => { apply(f); setModal(null); }} />}
      {modal === "columns" && (
        <ColumnsDialog current={columnKeys} onClose={() => setModal(null)} onSave={async (keys) => (await runAction(setColumns(keys), "Columns saved for you", { reference: true })).ok && setModal(null)} />
      )}
      {modal === "save" && (
        <Dialog
          open
          onClose={() => setModal(null)}
          title="Save view"
          description="Saves the current search and filters for you only."
          footer={<><Button onClick={() => setModal(null)}>Cancel</Button><Button variant="primary" onClick={async () => { if ((await runAction(saveView(viewName, filters), "View saved", { reference: true })).ok) { setModal(null); setViewName(""); } }}>Save</Button></>}
        >
          <Field label="View name" required>{(p) => <Input value={viewName} onChange={(e) => setViewName(e.target.value)} placeholder="e.g. IELTS callbacks" {...p} />}</Field>
        </Dialog>
      )}
    </div>
  );
}

function ViewTab({ active, onClick, children, warn }: { active: boolean; onClick: () => void; children: React.ReactNode; warn?: boolean }) {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={clsx(
        "inline-flex h-9 shrink-0 items-center whitespace-nowrap rounded-full px-3.5 text-[13px] font-medium transition-colors",
        active ? "bg-navy-900 text-white" : warn ? "border border-orange-500/60 bg-orange-50 text-orange-ink hover:bg-orange-100" : "border border-line bg-white text-ink hover:bg-navy-50",
      )}
    >
      {children}
    </button>
  );
}

function ColumnsDialog({ current, onClose, onSave }: { current: string[]; onClose: () => void; onSave: (keys: string[]) => void }) {
  const [keys, setKeys] = useState(current);
  const ordered = [...keys, ...COLUMNS.map((c) => c.key).filter((k) => !keys.includes(k))];
  const move = (k: string, dir: -1 | 1) => {
    const i = keys.indexOf(k);
    const j = i + dir;
    if (i < 1 || j < 1 || j >= keys.length) return;
    const next = [...keys];
    [next[i], next[j]] = [next[j], next[i]];
    setKeys(next);
  };
  return (
    <Dialog open onClose={onClose} title="Columns" description="Choose and order the columns you see. Only you see this layout." footer={<><Button variant="ghost" className="mr-auto" onClick={() => setKeys(DEFAULT_COLUMNS)}>Reset</Button><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => onSave(keys)}>Save</Button></>}>
      <ul className="divide-y divide-line rounded-lg border border-line">
        {ordered.map((k) => {
          const c = COLUMNS.find((x) => x.key === k)!;
          const on = keys.includes(k);
          return (
            <li key={k} className="flex items-center gap-2 px-3 py-2">
              <Checkbox label={c.label} checked={on} disabled={c.locked} onChange={(v) => setKeys(v ? [...keys, k] : keys.filter((x) => x !== k))} />
              {on && !c.locked && (
                <span className="ml-auto flex">
                  <IconButton label={`Move ${c.label} up`} icon={<ArrowUp size={14} />} onClick={() => move(k, -1)} />
                  <IconButton label={`Move ${c.label} down`} icon={<ArrowDown size={14} />} onClick={() => move(k, 1)} />
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </Dialog>
  );
}
