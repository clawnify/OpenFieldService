import type { LeadStatus } from "./lead.types";

export const leadStatuses = ["new", "contacted", "qualified", "estimate", "won", "lost"] as const;
export const legacyLostReasons = ["Price Too High", "Chose Competitor", "Not Ready", "Unreachable", "Outside Service Area", "Not Eligible", "Duplicate Lead", "No Longer Needed", "Other"] as const;

const transitions: Record<LeadStatus, readonly LeadStatus[]> = {
  new: ["contacted", "lost"], contacted: ["qualified", "lost"], qualified: ["estimate", "lost"], estimate: ["won", "lost"], won: [], lost: ["contacted"],
};

export function canTransitionLead(from: LeadStatus, to: LeadStatus): boolean { return transitions[from].includes(to); }
