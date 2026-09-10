import { sql } from "drizzle-orm";
import { bigint, check, date, foreignKey, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { contacts, customers } from "./customers";
import { organizationMembers, organizations, users } from "./identity";
import { pipelines, pipelineStages } from "./pipelines";

export const deals = pgTable("deals", {
  id: uuid("id").defaultRandom().primaryKey(), organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  identifier: text("identifier").notNull(), name: text("name").notNull(), pipelineId: uuid("pipeline_id").notNull(), stageId: uuid("stage_id").notNull(),
  customerId: uuid("customer_id").notNull(), contactId: uuid("contact_id"), ownerUserId: uuid("owner_user_id"),
  amountCents: bigint("amount_cents", { mode: "number" }).default(0).notNull(), currency: text("currency").default("CAD").notNull(), expectedCloseDate: date("expected_close_date"),
  closedAt: timestamp("closed_at", { withTimezone: true }), lostReason: text("lost_reason"), lostReasonNote: text("lost_reason_note"), source: text("source"),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }), updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(), updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(), archivedAt: timestamp("archived_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("deals_organization_id_unique").on(table.organizationId, table.id), uniqueIndex("deals_organization_identifier_unique").on(table.organizationId, table.identifier),
  index("deals_organization_stage_idx").on(table.organizationId, table.pipelineId, table.stageId), index("deals_organization_owner_idx").on(table.organizationId, table.ownerUserId),
  index("deals_organization_customer_idx").on(table.organizationId, table.customerId), index("deals_organization_close_idx").on(table.organizationId, table.expectedCloseDate), index("deals_organization_created_idx").on(table.organizationId, table.createdAt),
  foreignKey({ columns: [table.organizationId, table.pipelineId], foreignColumns: [pipelines.organizationId, pipelines.id], name: "deals_pipeline_tenant_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.organizationId, table.pipelineId, table.stageId], foreignColumns: [pipelineStages.organizationId, pipelineStages.pipelineId, pipelineStages.id], name: "deals_stage_pipeline_tenant_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.organizationId, table.customerId], foreignColumns: [customers.organizationId, customers.id], name: "deals_customer_tenant_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.organizationId, table.contactId], foreignColumns: [contacts.organizationId, contacts.id], name: "deals_contact_tenant_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.organizationId, table.ownerUserId], foreignColumns: [organizationMembers.organizationId, organizationMembers.userId], name: "deals_owner_tenant_fk" }).onDelete("restrict"),
  check("deals_amount_nonnegative", sql`${table.amountCents} >= 0`), check("deals_currency_format", sql`${table.currency} ~ '^[A-Z]{3}$'`),
  check("deals_lost_reason_complete", sql`${table.lostReason} is null or ${table.closedAt} is not null`),
]);

export const dealStageHistory = pgTable("deal_stage_history", {
  id: uuid("id").defaultRandom().primaryKey(), organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }), dealId: uuid("deal_id").notNull(),
  previousPipelineId: uuid("previous_pipeline_id"), previousStageId: uuid("previous_stage_id"), newPipelineId: uuid("new_pipeline_id").notNull(), newStageId: uuid("new_stage_id").notNull(),
  actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }), reason: text("reason"), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("deal_stage_history_deal_idx").on(table.organizationId, table.dealId, table.createdAt),
  foreignKey({ columns: [table.organizationId, table.dealId], foreignColumns: [deals.organizationId, deals.id], name: "deal_stage_history_deal_tenant_fk" }).onDelete("cascade"),
]);
