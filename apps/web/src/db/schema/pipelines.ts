import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations, users } from "./identity";

export const pipelineStageKind = pgEnum("pipeline_stage_kind", ["open", "won", "lost"]);

export const pipelines = pgTable("pipelines", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(), description: text("description"), isDefault: boolean("is_default").default(false).notNull(),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }), updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(), updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(), archivedAt: timestamp("archived_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("pipelines_organization_id_unique").on(table.organizationId, table.id),
  uniqueIndex("pipelines_active_name_unique").on(table.organizationId, sql`lower(${table.name})`).where(sql`${table.archivedAt} is null`),
  uniqueIndex("pipelines_one_active_default_unique").on(table.organizationId).where(sql`${table.isDefault} = true and ${table.archivedAt} is null`),
  index("pipelines_organization_created_idx").on(table.organizationId, table.createdAt),
  check("pipelines_archived_not_default", sql`${table.archivedAt} is null or ${table.isDefault} = false`),
]);

export const pipelineStages = pgTable("pipeline_stages", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  pipelineId: uuid("pipeline_id").notNull(), name: text("name").notNull(), position: integer("position").notNull(),
  kind: pipelineStageKind("kind").default("open").notNull(), probability: integer("probability").default(0).notNull(), color: text("color"),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }), updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(), updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(), archivedAt: timestamp("archived_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("pipeline_stages_organization_id_unique").on(table.organizationId, table.id),
  uniqueIndex("pipeline_stages_pipeline_id_unique").on(table.organizationId, table.pipelineId, table.id),
  uniqueIndex("pipeline_stages_active_position_unique").on(table.organizationId, table.pipelineId, table.position).where(sql`${table.archivedAt} is null`),
  uniqueIndex("pipeline_stages_active_name_unique").on(table.organizationId, table.pipelineId, sql`lower(${table.name})`).where(sql`${table.archivedAt} is null`),
  index("pipeline_stages_pipeline_idx").on(table.organizationId, table.pipelineId),
  foreignKey({ columns: [table.organizationId, table.pipelineId], foreignColumns: [pipelines.organizationId, pipelines.id], name: "pipeline_stages_pipeline_tenant_fk" }).onDelete("cascade"),
  check("pipeline_stages_position_nonnegative", sql`${table.position} >= 0`),
  check("pipeline_stages_probability_range", sql`${table.probability} between 0 and 100`),
  check("pipeline_stages_terminal_probability", sql`(${table.kind} = 'open') or (${table.kind} = 'won' and ${table.probability} = 100) or (${table.kind} = 'lost' and ${table.probability} = 0)`),
  check("pipeline_stages_color_format", sql`${table.color} is null or ${table.color} ~ '^#[0-9A-Fa-f]{6}$'`),
]);
