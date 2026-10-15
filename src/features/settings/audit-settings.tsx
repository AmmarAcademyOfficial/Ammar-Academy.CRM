"use client";

import { Search, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/form";
import { Card, CardHeader, EmptyState, SkeletonRows } from "@/components/ui/misc";
import { formatCairo } from "@/domain/rules";
import type { AuditEntry } from "@/domain/types";
import { profileName } from "@/lib/lead-row";
import { useApi, useWorkspace } from "@/lib/workspace";

/** Read-only history of sensitive changes: roles, reassignments, prices, payments decisions, settings. */
export function AuditSettings() {
  const { ref } = useWorkspace();
  const [q, setQ] = useState("");
  const [actor, setActor] = useState("");
  const [page, setPage] = useState(0);
  const { data, loading } = useApi<{ items: AuditEntry[]; total: number; pageSize: number }>(`/api/audit?${new URLSearchParams({ q, actor, page: String(page) })}`);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return (
    <Card>
      <CardHeader title="Audit history" subtitle="Every sensitive change, who made it and when. Entries cannot be edited or deleted." count={data?.total} />
      <div className="grid gap-2 border-b border-line p-3 sm:grid-cols-2">
        <label className="relative">
          <span className="sr-only">Search the audit history</span>
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
          <Input className="h-9 pl-8" placeholder="Search action or record" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} />
        </label>
        <Select aria-label="Changed by" className="h-9" value={actor} onChange={(e) => { setActor(e.target.value); setPage(0); }}>
          <option value="">Anyone</option>
          <option value="system">System (automatic)</option>
          {ref.profiles.map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}
        </Select>
      </div>
      {!data && loading ? <SkeletonRows rows={6} /> : data?.items.length === 0 ? (
        <EmptyState icon={<ShieldCheck size={22} />} title="No matching entries" />
      ) : (
        <ul aria-label="Audit entries" className="divide-y divide-line">
          {data?.items.map((a) => (
            <li key={a.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-4 py-2.5 text-sm">
              <p className="min-w-0">{a.action} · <span className="font-medium" dir="auto">{a.target}</span></p>
              <p className="text-xs text-muted">{a.actorId === "system" ? "System" : profileName(ref, a.actorId)} · {formatCairo(a.createdAt)}</p>
            </li>
          ))}
        </ul>
      )}
      {data && pages > 1 && (
        <div className="flex items-center justify-between border-t border-line px-4 py-2 text-sm">
          <Button size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Newer</Button>
          <span className="text-xs text-muted">Page {page + 1} of {pages}</span>
          <Button size="sm" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>Older</Button>
        </div>
      )}
    </Card>
  );
}
