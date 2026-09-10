import { sql } from "drizzle-orm";
import { bigint, boolean, check, date, foreignKey, index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { contracts, contractVersions } from "./contracts";
import { customers } from "./customers";
import { organizations, users } from "./identity";
import { jobs } from "./jobs";
import { pricebookItems, quoteOptionLines, quoteOptions, quotes, quoteVersions } from "./commerce";

export const invoiceStatus = pgEnum("invoice_status", ["draft", "issued", "partially_paid", "paid", "void"]);
export const invoiceSource = pgEnum("invoice_source", ["manual", "job", "contract"]);
export const invoicePaymentTerms = pgEnum("invoice_payment_terms", ["due_on_receipt", "net_15", "net_30", "net_60", "custom"]);

export const invoices = pgTable("invoices", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  sequenceNumber: integer("sequence_number").notNull(), identifier: text("identifier").notNull(),
  source: invoiceSource("source").notNull(), customerId: uuid("customer_id").notNull(), jobId: uuid("job_id"),
  contractId: uuid("contract_id"), contractVersionId: uuid("contract_version_id"), quoteId: uuid("quote_id"), quoteVersionId: uuid("quote_version_id"), quoteOptionId: uuid("quote_option_id"),
  billingSnapshot: text("billing_snapshot").notNull(), taxSnapshot: text("tax_snapshot").notNull(), currency: text("currency").default("CAD").notNull(),
  status: invoiceStatus("status").default("draft").notNull(), paymentTerms: invoicePaymentTerms("payment_terms").default("due_on_receipt").notNull(),
  issueDate: date("issue_date"), dueDate: date("due_date"),
  subtotalCents: bigint("subtotal_cents", { mode: "number" }).default(0).notNull(), discountCents: bigint("discount_cents", { mode: "number" }).default(0).notNull(), taxCents: bigint("tax_cents", { mode: "number" }).default(0).notNull(), rebateCents: bigint("rebate_cents", { mode: "number" }).default(0).notNull(), totalCents: bigint("total_cents", { mode: "number" }).default(0).notNull(),
  notes: text("notes").default("").notNull(), terms: text("terms").default("").notNull(), rowVersion: integer("row_version").default(0).notNull(),
  issuedAt: timestamp("issued_at", { withTimezone: true }), voidedAt: timestamp("voided_at", { withTimezone: true }), voidReason: text("void_reason"), archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }), updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(), updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, t => [
  uniqueIndex("invoices_org_id_unique").on(t.organizationId, t.id), uniqueIndex("invoices_org_sequence_unique").on(t.organizationId, t.sequenceNumber), uniqueIndex("invoices_org_identifier_unique").on(t.organizationId, t.identifier),
  uniqueIndex("invoices_live_job_unique").on(t.organizationId, t.jobId).where(sql`${t.jobId} is not null and ${t.status} <> 'void' and ${t.archivedAt} is null`),
  uniqueIndex("invoices_live_contract_unique").on(t.organizationId, t.contractId).where(sql`${t.contractId} is not null and ${t.status} <> 'void' and ${t.archivedAt} is null`),
  index("invoices_org_status_idx").on(t.organizationId, t.status, t.createdAt), index("invoices_org_customer_idx").on(t.organizationId, t.customerId), index("invoices_org_due_idx").on(t.organizationId, t.dueDate),
  foreignKey({ columns: [t.organizationId, t.customerId], foreignColumns: [customers.organizationId, customers.id], name: "invoice_customer_tenant_fk" }).onDelete("restrict"),
  foreignKey({ columns: [t.organizationId, t.jobId], foreignColumns: [jobs.organizationId, jobs.id], name: "invoice_job_tenant_fk" }).onDelete("restrict"),
  foreignKey({ columns: [t.organizationId, t.contractId], foreignColumns: [contracts.organizationId, contracts.id], name: "invoice_contract_tenant_fk" }).onDelete("restrict"),
  foreignKey({ columns: [t.organizationId, t.contractVersionId], foreignColumns: [contractVersions.organizationId, contractVersions.id], name: "invoice_contract_version_tenant_fk" }).onDelete("restrict"),
  foreignKey({ columns: [t.organizationId, t.quoteId], foreignColumns: [quotes.organizationId, quotes.id], name: "invoice_quote_tenant_fk" }).onDelete("restrict"),
  foreignKey({ columns: [t.organizationId, t.quoteVersionId], foreignColumns: [quoteVersions.organizationId, quoteVersions.id], name: "invoice_quote_version_tenant_fk" }).onDelete("restrict"),
  foreignKey({ columns: [t.organizationId, t.quoteOptionId], foreignColumns: [quoteOptions.organizationId, quoteOptions.id], name: "invoice_quote_option_tenant_fk" }).onDelete("restrict"),
  check("invoice_money_nonnegative", sql`${t.subtotalCents} >= 0 and ${t.discountCents} >= 0 and ${t.taxCents} >= 0 and ${t.rebateCents} >= 0 and ${t.totalCents} >= 0 and ${t.rebateCents} <= ${t.totalCents}`),
  check("invoice_source_integrity", sql`(${t.source}='manual' and ${t.jobId} is null and ${t.contractId} is null and ${t.contractVersionId} is null and ${t.quoteId} is null and ${t.quoteVersionId} is null and ${t.quoteOptionId} is null) or (${t.source}='job' and ${t.jobId} is not null and ${t.contractId} is null and ${t.contractVersionId} is null and ${t.quoteId} is null and ${t.quoteVersionId} is null and ${t.quoteOptionId} is null) or (${t.source}='contract' and ${t.jobId} is null and ${t.contractId} is not null and ${t.contractVersionId} is not null and ${t.quoteId} is not null and ${t.quoteVersionId} is not null and ${t.quoteOptionId} is not null)`),
  check("invoice_issue_dates_consistent", sql`(${t.status}='draft' and ${t.issuedAt} is null) or ${t.status}='void' or (${t.status} in ('issued','partially_paid','paid') and ${t.issuedAt} is not null)`), check("invoice_row_version_valid", sql`${t.rowVersion} >= 0`),
]);

export const invoiceLines = pgTable("invoice_lines", {
  id: uuid("id").defaultRandom().primaryKey(), organizationId: uuid("organization_id").notNull(), invoiceId: uuid("invoice_id").notNull(),
  pricebookItemId: uuid("pricebook_item_id"), sourceQuoteLineId: uuid("source_quote_line_id"), description: text("description").notNull(), category: text("category").default("other").notNull(), unit: text("unit").default("each").notNull(),
  quantityMilli: integer("quantity_milli").notNull(), unitPriceCents: bigint("unit_price_cents", { mode: "number" }).notNull(), taxable: boolean("taxable").default(true).notNull(), totalCents: bigint("total_cents", { mode: "number" }).notNull(), sortOrder: integer("sort_order").notNull(),
}, t => [uniqueIndex("invoice_lines_org_id_unique").on(t.organizationId, t.id), uniqueIndex("invoice_lines_order_unique").on(t.organizationId, t.invoiceId, t.sortOrder), index("invoice_lines_invoice_idx").on(t.organizationId, t.invoiceId),
  foreignKey({ columns: [t.organizationId, t.invoiceId], foreignColumns: [invoices.organizationId, invoices.id], name: "invoice_line_invoice_tenant_fk" }).onDelete("cascade"), foreignKey({ columns: [t.organizationId, t.pricebookItemId], foreignColumns: [pricebookItems.organizationId, pricebookItems.id], name: "invoice_line_pricebook_tenant_fk" }).onDelete("set null"), foreignKey({ columns: [t.organizationId, t.sourceQuoteLineId], foreignColumns: [quoteOptionLines.organizationId, quoteOptionLines.id], name: "invoice_line_quote_line_tenant_fk" }).onDelete("set null"),
  check("invoice_line_values_valid", sql`${t.quantityMilli} > 0 and ${t.unitPriceCents} >= 0 and ${t.totalCents} >= 0`), check("invoice_line_order_valid", sql`${t.sortOrder} >= 0`)]);

export const invoiceStatusHistory = pgTable("invoice_status_history", { id: uuid("id").defaultRandom().primaryKey(), organizationId: uuid("organization_id").notNull(), invoiceId: uuid("invoice_id").notNull(), fromStatus: invoiceStatus("from_status"), toStatus: invoiceStatus("to_status").notNull(), actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }), reason: text("reason"), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull() }, t => [index("invoice_status_history_idx").on(t.organizationId, t.invoiceId, t.createdAt), foreignKey({ columns: [t.organizationId, t.invoiceId], foreignColumns: [invoices.organizationId, invoices.id], name: "invoice_history_invoice_tenant_fk" }).onDelete("cascade")]);
