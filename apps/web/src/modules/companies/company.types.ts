import type { companies } from "@/db/schema";
export type Company = typeof companies.$inferSelect;
export type NewCompany = typeof companies.$inferInsert;
