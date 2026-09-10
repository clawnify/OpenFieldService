import { sql } from "drizzle-orm";
import { bigint, check, date, foreignKey, index, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { invoices } from "./invoices";
import { organizations, users } from "./identity";

export const paymentEntryType = pgEnum("payment_entry_type", ["payment", "reversal"]);
export const paymentPayerType = pgEnum("payment_payer_type", ["customer", "government", "third_party"]);
export const paymentMethod = pgEnum("payment_method", ["cash", "check", "credit_card", "debit_card", "e_transfer", "bank_transfer", "financing", "other"]);
export const paymentSource = pgEnum("payment_source", ["manual", "online_provider"]);

export const payments = pgTable("payments", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  invoiceId: uuid("invoice_id").notNull(),
  entryType: paymentEntryType("entry_type").default("payment").notNull(),
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
  currency: text("currency").notNull(),
  payerType: paymentPayerType("payer_type").notNull(),
  payerSnapshot: text("payer_snapshot").default("{}").notNull(),
  method: paymentMethod("method").notNull(),
  source: paymentSource("source").default("manual").notNull(),
  externalReference: text("external_reference"),
  idempotencyKey: text("idempotency_key"),
  receivedBy: text("received_by").default("").notNull(),
  notes: text("notes").default("").notNull(),
  postedAt: timestamp("posted_at", { withTimezone: true }).defaultNow().notNull(),
  businessDate: date("business_date").notNull(),
  recordedBy: uuid("recorded_by").references(() => users.id, { onDelete: "set null" }),
  reversesPaymentId: uuid("reverses_payment_id"),
  reversalReason: text("reversal_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, t => [
  uniqueIndex("payments_org_id_unique").on(t.organizationId, t.id),
  uniqueIndex("payments_org_invoice_id_unique").on(t.organizationId, t.invoiceId, t.id),
  uniqueIndex("payments_reversal_unique").on(t.organizationId, t.reversesPaymentId).where(sql`${t.reversesPaymentId} is not null`),
  uniqueIndex("payments_idempotency_unique").on(t.organizationId, t.source, t.idempotencyKey).where(sql`${t.idempotencyKey} is not null`),
  index("payments_invoice_posted_idx").on(t.organizationId, t.invoiceId, t.postedAt),
  index("payments_reference_idx").on(t.organizationId, t.externalReference),
  foreignKey({ columns: [t.organizationId, t.invoiceId], foreignColumns: [invoices.organizationId, invoices.id], name: "payment_invoice_tenant_fk" }).onDelete("restrict"),
  foreignKey({ columns: [t.organizationId, t.invoiceId, t.reversesPaymentId], foreignColumns: [t.organizationId, t.invoiceId, t.id], name: "payment_reversal_tenant_invoice_fk" }).onDelete("restrict"),
  check("payment_amount_positive", sql`${t.amountCents} > 0`),
  check("payment_currency_format", sql`${t.currency} ~ '^[A-Z]{3}$'`),
  check("payment_event_integrity", sql`(${t.entryType}='payment' and ${t.reversesPaymentId} is null and ${t.reversalReason} is null) or (${t.entryType}='reversal' and ${t.reversesPaymentId} is not null and length(trim(${t.reversalReason})) > 0)`),
]);
