import type { customers } from "@/db/schema";

export type Customer = typeof customers.$inferSelect;
export type NewCustomer = typeof customers.$inferInsert;
