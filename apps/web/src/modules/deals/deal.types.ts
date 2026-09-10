import type { deals, dealStageHistory } from "@/db/schema";
export type Deal = typeof deals.$inferSelect;
export type NewDeal = typeof deals.$inferInsert;
export type DealStageHistory = typeof dealStageHistory.$inferSelect;
