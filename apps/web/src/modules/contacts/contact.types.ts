import type { contacts } from "@/db/schema";
export type Contact = typeof contacts.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;
