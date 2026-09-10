import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { customers } from "./customers";
import { organizationMembers, organizations, users } from "./identity";

export const leadStatus = pgEnum("lead_status", ["new", "contacted", "qualified", "estimate", "won", "lost"]);

export const leads = pgTable("leads", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  identifier: text("identifier").notNull(),
  name: text("name").notNull(),
  email: text("email"), phone: text("phone"),
  addressLine1: text("address_line_1"), addressLine2: text("address_line_2"), city: text("city"), region: text("region"), postalCode: text("postal_code"),
  source: text("source"), notes: text("notes"),
  status: leadStatus("status").default("new").notNull(),
  assignedUserId: uuid("assigned_user_id"),
  estimatedValueCents: integer("estimated_value_cents"), estimateNotes: text("estimate_notes"),
  lostReason: text("lost_reason"), lostReasonNote: text("lost_reason_note"),
  convertedCustomerId: uuid("converted_customer_id"), convertedAt: timestamp("converted_at", { withTimezone: true }), convertedBy: uuid("converted_by").references(() => users.id, { onDelete: "set null" }),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }), updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(), updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(), archivedAt: timestamp("archived_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("leads_organization_identifier_unique").on(table.organizationId, table.identifier),
  uniqueIndex("leads_organization_id_unique").on(table.organizationId, table.id),
  index("leads_organization_status_idx").on(table.organizationId, table.status),
  index("leads_organization_assignee_idx").on(table.organizationId, table.assignedUserId),
  index("leads_organization_created_idx").on(table.organizationId, table.createdAt),
  index("leads_organization_email_idx").on(table.organizationId, table.email),
  index("leads_organization_phone_idx").on(table.organizationId, table.phone),
  foreignKey({ columns: [table.organizationId, table.assignedUserId], foreignColumns: [organizationMembers.organizationId, organizationMembers.userId], name: "leads_assignee_tenant_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.organizationId, table.convertedCustomerId], foreignColumns: [customers.organizationId, customers.id], name: "leads_customer_tenant_fk" }).onDelete("restrict"),
  check("leads_conversion_complete", sql`(${table.convertedCustomerId} is null and ${table.convertedAt} is null and ${table.convertedBy} is null) or (${table.convertedCustomerId} is not null and ${table.convertedAt} is not null and ${table.convertedBy} is not null and ${table.status} = 'won')`),
]);

export const leadStatusHistory = pgTable("lead_status_history", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  leadId: uuid("lead_id").notNull(),
  oldStatus: leadStatus("old_status"), newStatus: leadStatus("new_status").notNull(),
  reason: text("reason"), actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("lead_status_history_tenant_lead_idx").on(table.organizationId, table.leadId, table.createdAt),
  foreignKey({ columns: [table.organizationId, table.leadId], foreignColumns: [leads.organizationId, leads.id], name: "lead_status_history_tenant_fk" }).onDelete("cascade"),
]);
