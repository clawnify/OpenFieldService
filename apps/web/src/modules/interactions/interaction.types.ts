import type { activities, notes, tasks } from "@/db/schema";
export type Task = typeof tasks.$inferSelect; export type NewTask = typeof tasks.$inferInsert;
export type Activity = typeof activities.$inferSelect; export type NewActivity = typeof activities.$inferInsert;
export type Note = typeof notes.$inferSelect; export type NewNote = typeof notes.$inferInsert;
export type TimelineItem = { kind: "activity" | "note"; id: string; timestamp: Date; title: string; details: string | null; actorUserId: string };
