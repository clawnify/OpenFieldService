import type { attachments } from "@/db/schema";
export type Attachment = typeof attachments.$inferSelect; export type NewAttachment = typeof attachments.$inferInsert;
