import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations, users } from "./identity";

export const crmRecordStatus = pgEnum("crm_record_status", ["active", "archived"]);

export const companies = pgTable("companies", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(), legalName: text("legal_name"), email: text("email"), phone: text("phone"), website: text("website"),
  addressLine1: text("address_line_1"), addressLine2: text("address_line_2"), city: text("city"), region: text("region"), postalCode: text("postal_code"), notes: text("notes"),
  status: crmRecordStatus("status").default("active").notNull(),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(), updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(), archivedAt: timestamp("archived_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("companies_organization_id_unique").on(table.organizationId, table.id),
  index("companies_organization_name_idx").on(table.organizationId, table.name),
  index("companies_organization_status_idx").on(table.organizationId, table.status),
]);

export const customers = pgTable("customers", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  companyId: uuid("company_id"),
  name: text("name").notNull(), email: text("email"), phone: text("phone"),
  addressLine1: text("address_line_1"), addressLine2: text("address_line_2"), city: text("city"), region: text("region"), postalCode: text("postal_code"), notes: text("notes"),
  status: crmRecordStatus("status").default("active").notNull(),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(), updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  archivedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("customers_organization_id_unique").on(table.organizationId, table.id),
  index("customers_organization_name_idx").on(table.organizationId, table.name),
  index("customers_organization_email_idx").on(table.organizationId, table.email),
  index("customers_organization_phone_match_idx").on(table.organizationId, sql`(case when length(regexp_replace(${table.phone}, '[^0-9]', '', 'g')) = 11 and regexp_replace(${table.phone}, '[^0-9]', '', 'g') like '1%' then substring(regexp_replace(${table.phone}, '[^0-9]', '', 'g') from 2) else regexp_replace(${table.phone}, '[^0-9]', '', 'g') end)`),
  index("customers_organization_company_idx").on(table.organizationId, table.companyId),
  index("customers_organization_status_idx").on(table.organizationId, table.status),
  foreignKey({ columns: [table.organizationId, table.companyId], foreignColumns: [companies.organizationId, companies.id], name: "customers_company_tenant_fk" }).onDelete("restrict"),
]);

export const contacts = pgTable("contacts", {
  id: uuid("id").defaultRandom().primaryKey(), organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  customerId: uuid("customer_id"), companyId: uuid("company_id"), firstName: text("first_name").notNull(), lastName: text("last_name").notNull(),
  email: text("email"), phone: text("phone"), title: text("title"), isPrimary: boolean("is_primary").default(false).notNull(), active: boolean("active").default(true).notNull(),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }), updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(), updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(), removedAt: timestamp("removed_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("contacts_organization_id_unique").on(table.organizationId, table.id),
  index("contacts_organization_name_idx").on(table.organizationId, table.lastName, table.firstName),
  index("contacts_organization_customer_idx").on(table.organizationId, table.customerId),
  index("contacts_organization_company_idx").on(table.organizationId, table.companyId),
  uniqueIndex("contacts_primary_customer_unique").on(table.organizationId, table.customerId).where(sql`${table.isPrimary} = true and ${table.active} = true and ${table.customerId} is not null`),
  uniqueIndex("contacts_primary_company_unique").on(table.organizationId, table.companyId).where(sql`${table.isPrimary} = true and ${table.active} = true and ${table.companyId} is not null`),
  foreignKey({ columns: [table.organizationId, table.customerId], foreignColumns: [customers.organizationId, customers.id], name: "contacts_customer_tenant_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.organizationId, table.companyId], foreignColumns: [companies.organizationId, companies.id], name: "contacts_company_tenant_fk" }).onDelete("restrict"),
  check("contacts_parent_required", sql`${table.customerId} is not null or ${table.companyId} is not null`),
]);
