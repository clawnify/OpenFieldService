import type { leads, leadStatusHistory } from "@/db/schema";

export type Lead = typeof leads.$inferSelect;
export type NewLead = typeof leads.$inferInsert;
export type LeadStatus = Lead["status"];
export type LeadStatusHistory = typeof leadStatusHistory.$inferSelect;
