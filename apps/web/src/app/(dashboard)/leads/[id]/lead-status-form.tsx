"use client";
import { useActionState } from "react";
import type { LeadStatus } from "@/modules/leads/lead.types";
import { legacyLostReasons } from "@/modules/leads/lead.workflow";
import { changeLeadStatusAction } from "../actions";

const nextStatuses: Record<LeadStatus, LeadStatus[]> = { new: ["contacted", "lost"], contacted: ["qualified", "lost"], qualified: ["estimate", "lost"], estimate: ["won", "lost"], won: [], lost: ["contacted"] };
export function LeadStatusForm({ id, status }: { id: string; status: LeadStatus }) {
  const [state, action, pending] = useActionState(changeLeadStatusAction.bind(null, id), {}); const options = nextStatuses[status]; if (!options.length) return null;
  return <form action={action} className="mt-6 flex flex-wrap items-end gap-3 rounded-xl border bg-card p-4"><label className="text-sm">Next status<select name="status" className="mt-1 block rounded-md border bg-background px-3 py-2">{options.map((value) => <option key={value}>{value}</option>)}</select></label><label className="text-sm">Lost reason<select name="lostReason" className="mt-1 block rounded-md border bg-background px-3 py-2"><option value="">Only required for lost</option>{legacyLostReasons.map((reason) => <option key={reason}>{reason}</option>)}</select></label><button disabled={pending} className="rounded-md border bg-background px-4 py-2 disabled:opacity-50">{pending ? "Updating…" : "Update status"}</button>{state.error ? <p className="w-full text-sm text-destructive">{state.error}</p> : null}</form>;
}
