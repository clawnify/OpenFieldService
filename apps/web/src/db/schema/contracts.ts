import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { customers } from "./customers";
import { organizations, users } from "./identity";
import { quoteOptions, quotes, quoteVersions } from "./commerce";

export const contractStatus = pgEnum("contract_status", [
  "draft",
  "sent",
  "partially_signed",
  "signed",
  "declined",
  "expired",
  "cancelled",
  "voided",
]);
export const contractSignerRole = pgEnum("contract_signer_role", [
  "customer",
  "co_owner",
  "company_rep",
  "guarantor",
  "other",
]);
export const signatureRequestStatus = pgEnum(
  "contract_signature_request_status",
  ["pending", "viewed", "signed", "declined", "expired", "revoked"],
);
export const signatureMethod = pgEnum("contract_signature_method", [
  "typed",
  "click_to_sign",
  "drawn",
]);

export const contracts = pgTable(
  "contracts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    sequenceNumber: integer("sequence_number").notNull(),
    identifier: text("identifier").notNull(),
    customerId: uuid("customer_id").notNull(),
    quoteId: uuid("quote_id").notNull(),
    acceptedQuoteVersionId: uuid("accepted_quote_version_id").notNull(),
    acceptedOptionId: uuid("accepted_option_id").notNull(),
    acceptedTotalCents: bigint("accepted_total_cents", {
      mode: "number",
    }).notNull(),
    status: contractStatus("status").default("draft").notNull(),
    currentVersionId: uuid("current_version_id"),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidReason: text("void_reason"),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("contracts_org_id_unique").on(t.organizationId, t.id),
    uniqueIndex("contracts_org_sequence_unique").on(
      t.organizationId,
      t.sequenceNumber,
    ),
    uniqueIndex("contracts_org_identifier_unique").on(
      t.organizationId,
      t.identifier,
    ),
    uniqueIndex("contracts_live_quote_unique")
      .on(t.organizationId, t.quoteId)
      .where(
        sql`${t.status} not in ('cancelled','voided') and ${t.archivedAt} is null`,
      ),
    index("contracts_org_status_idx").on(
      t.organizationId,
      t.status,
      t.createdAt,
    ),
    index("contracts_org_customer_idx").on(t.organizationId, t.customerId),
    foreignKey({
      columns: [t.organizationId, t.customerId],
      foreignColumns: [customers.organizationId, customers.id],
      name: "contract_customer_tenant_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.organizationId, t.quoteId],
      foreignColumns: [quotes.organizationId, quotes.id],
      name: "contract_quote_tenant_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.organizationId, t.acceptedQuoteVersionId],
      foreignColumns: [quoteVersions.organizationId, quoteVersions.id],
      name: "contract_quote_version_tenant_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.organizationId, t.acceptedOptionId],
      foreignColumns: [quoteOptions.organizationId, quoteOptions.id],
      name: "contract_option_tenant_fk",
    }).onDelete("restrict"),
    check("contract_total_nonnegative", sql`${t.acceptedTotalCents} >= 0`),
  ],
);

export const contractVersions = pgTable(
  "contract_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    contractId: uuid("contract_id").notNull(),
    versionNumber: integer("version_number").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    commercialSnapshot: text("commercial_snapshot").notNull(),
    customerSnapshot: text("customer_snapshot").notNull(),
    companySnapshot: text("company_snapshot").notNull(),
    effectiveOn: text("effective_on"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    documentHash: text("document_hash"),
    signedDocumentKey: text("signed_document_key"),
    signedDocumentHash: text("signed_document_hash"),
    signedAt: timestamp("signed_at", { withTimezone: true }),
    rowVersion: integer("row_version").default(0).notNull(),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("contract_versions_org_id_unique").on(t.organizationId, t.id),
    uniqueIndex("contract_versions_number_unique").on(
      t.organizationId,
      t.contractId,
      t.versionNumber,
    ),
    foreignKey({
      columns: [t.organizationId, t.contractId],
      foreignColumns: [contracts.organizationId, contracts.id],
      name: "contract_version_contract_tenant_fk",
    }).onDelete("cascade"),
    check("contract_version_row_version_valid", sql`${t.rowVersion} >= 0`),
  ],
);

export const contractSigners = pgTable(
  "contract_signers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    contractId: uuid("contract_id").notNull(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    phone: text("phone"),
    role: contractSignerRole("role").default("customer").notNull(),
    sortOrder: integer("sort_order").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("contract_signers_org_id_unique").on(t.organizationId, t.id),
    uniqueIndex("contract_signers_order_unique").on(
      t.organizationId,
      t.contractId,
      t.sortOrder,
    ),
    foreignKey({
      columns: [t.organizationId, t.contractId],
      foreignColumns: [contracts.organizationId, contracts.id],
      name: "contract_signer_contract_tenant_fk",
    }).onDelete("cascade"),
  ],
);

export const contractSignatureRequests = pgTable(
  "contract_signature_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    contractId: uuid("contract_id").notNull(),
    contractVersionId: uuid("contract_version_id").notNull(),
    signerId: uuid("signer_id").notNull(),
    status: signatureRequestStatus("status").default("pending").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consentTextVersion: text("consent_text_version").default("v1").notNull(),
    consentAt: timestamp("consent_at", { withTimezone: true }),
    signedAt: timestamp("signed_at", { withTimezone: true }),
    method: signatureMethod("signature_method"),
    signerName: text("signer_name"),
    signerIp: text("signer_ip"),
    signerUserAgent: text("signer_user_agent"),
    signatureImageKey: text("signature_image_key"),
    declinedReason: text("declined_reason"),
    rowVersion: integer("row_version").default(0).notNull(),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("contract_signature_requests_token_unique").on(t.tokenHash),
    uniqueIndex("contract_signature_requests_org_id_unique").on(
      t.organizationId,
      t.id,
    ),
    index("contract_signature_requests_contract_idx").on(
      t.organizationId,
      t.contractId,
      t.createdAt,
    ),
    foreignKey({
      columns: [t.organizationId, t.contractId],
      foreignColumns: [contracts.organizationId, contracts.id],
      name: "signature_request_contract_tenant_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.organizationId, t.contractVersionId],
      foreignColumns: [contractVersions.organizationId, contractVersions.id],
      name: "signature_request_version_tenant_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.organizationId, t.signerId],
      foreignColumns: [contractSigners.organizationId, contractSigners.id],
      name: "signature_request_signer_tenant_fk",
    }).onDelete("restrict"),
  ],
);

export const contractSignatureEvents = pgTable(
  "contract_signature_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    signatureRequestId: uuid("signature_request_id").notNull(),
    eventType: text("event_type").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    metadata: text("metadata").default("{}").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("contract_signature_events_request_idx").on(
      t.organizationId,
      t.signatureRequestId,
      t.createdAt,
    ),
    foreignKey({
      columns: [t.organizationId, t.signatureRequestId],
      foreignColumns: [
        contractSignatureRequests.organizationId,
        contractSignatureRequests.id,
      ],
      name: "signature_event_request_tenant_fk",
    }).onDelete("cascade"),
  ],
);

export const contractStatusHistory = pgTable(
  "contract_status_history",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    contractId: uuid("contract_id").notNull(),
    fromStatus: contractStatus("from_status"),
    toStatus: contractStatus("to_status").notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("contract_status_history_contract_idx").on(
      t.organizationId,
      t.contractId,
      t.createdAt,
    ),
    foreignKey({
      columns: [t.organizationId, t.contractId],
      foreignColumns: [contracts.organizationId, contracts.id],
      name: "contract_history_contract_tenant_fk",
    }).onDelete("cascade"),
  ],
);
