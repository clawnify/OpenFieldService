CREATE TYPE "public"."invoice_payment_terms" AS ENUM('due_on_receipt', 'net_15', 'net_30', 'net_60', 'custom');--> statement-breakpoint
CREATE TYPE "public"."invoice_source" AS ENUM('manual', 'job', 'contract');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('draft', 'issued', 'partially_paid', 'paid', 'void');--> statement-breakpoint
CREATE TABLE "invoice_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"pricebook_item_id" uuid,
	"source_quote_line_id" uuid,
	"description" text NOT NULL,
	"category" text DEFAULT 'other' NOT NULL,
	"unit" text DEFAULT 'each' NOT NULL,
	"quantity_milli" integer NOT NULL,
	"unit_price_cents" bigint NOT NULL,
	"taxable" boolean DEFAULT true NOT NULL,
	"total_cents" bigint NOT NULL,
	"sort_order" integer NOT NULL,
	CONSTRAINT "invoice_line_values_valid" CHECK ("invoice_lines"."quantity_milli" > 0 and "invoice_lines"."unit_price_cents" >= 0 and "invoice_lines"."total_cents" >= 0),
	CONSTRAINT "invoice_line_order_valid" CHECK ("invoice_lines"."sort_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "invoice_status_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"from_status" "invoice_status",
	"to_status" "invoice_status" NOT NULL,
	"actor_user_id" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"sequence_number" integer NOT NULL,
	"identifier" text NOT NULL,
	"source" "invoice_source" NOT NULL,
	"customer_id" uuid NOT NULL,
	"job_id" uuid,
	"contract_id" uuid,
	"contract_version_id" uuid,
	"quote_id" uuid,
	"quote_version_id" uuid,
	"quote_option_id" uuid,
	"billing_snapshot" text NOT NULL,
	"tax_snapshot" text NOT NULL,
	"currency" text DEFAULT 'CAD' NOT NULL,
	"status" "invoice_status" DEFAULT 'draft' NOT NULL,
	"payment_terms" "invoice_payment_terms" DEFAULT 'due_on_receipt' NOT NULL,
	"issue_date" date,
	"due_date" date,
	"subtotal_cents" bigint DEFAULT 0 NOT NULL,
	"discount_cents" bigint DEFAULT 0 NOT NULL,
	"tax_cents" bigint DEFAULT 0 NOT NULL,
	"rebate_cents" bigint DEFAULT 0 NOT NULL,
	"total_cents" bigint DEFAULT 0 NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"terms" text DEFAULT '' NOT NULL,
	"row_version" integer DEFAULT 0 NOT NULL,
	"issued_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"archived_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_money_nonnegative" CHECK ("invoices"."subtotal_cents" >= 0 and "invoices"."discount_cents" >= 0 and "invoices"."tax_cents" >= 0 and "invoices"."rebate_cents" >= 0 and "invoices"."total_cents" >= 0 and "invoices"."rebate_cents" <= "invoices"."total_cents"),
	CONSTRAINT "invoice_source_integrity" CHECK (("invoices"."source"='manual' and "invoices"."job_id" is null and "invoices"."contract_id" is null and "invoices"."contract_version_id" is null and "invoices"."quote_id" is null and "invoices"."quote_version_id" is null and "invoices"."quote_option_id" is null) or ("invoices"."source"='job' and "invoices"."job_id" is not null and "invoices"."contract_id" is null and "invoices"."contract_version_id" is null) or ("invoices"."source"='contract' and "invoices"."job_id" is null and "invoices"."contract_id" is not null and "invoices"."contract_version_id" is not null and "invoices"."quote_id" is not null and "invoices"."quote_version_id" is not null and "invoices"."quote_option_id" is not null)),
	CONSTRAINT "invoice_issue_dates_consistent" CHECK (("invoices"."status"='draft' and "invoices"."issued_at" is null) or "invoices"."status"='void' or ("invoices"."status" in ('issued','partially_paid','paid') and "invoices"."issued_at" is not null)),
	CONSTRAINT "invoice_row_version_valid" CHECK ("invoices"."row_version" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_org_id_unique" ON "invoices" USING btree ("organization_id","id");--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_line_invoice_tenant_fk" FOREIGN KEY ("organization_id","invoice_id") REFERENCES "public"."invoices"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_line_pricebook_tenant_fk" FOREIGN KEY ("organization_id","pricebook_item_id") REFERENCES "public"."pricebook_items"("organization_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_line_quote_line_tenant_fk" FOREIGN KEY ("organization_id","source_quote_line_id") REFERENCES "public"."quote_option_lines"("organization_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_status_history" ADD CONSTRAINT "invoice_status_history_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_status_history" ADD CONSTRAINT "invoice_history_invoice_tenant_fk" FOREIGN KEY ("organization_id","invoice_id") REFERENCES "public"."invoices"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoice_customer_tenant_fk" FOREIGN KEY ("organization_id","customer_id") REFERENCES "public"."customers"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoice_job_tenant_fk" FOREIGN KEY ("organization_id","job_id") REFERENCES "public"."jobs"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoice_contract_tenant_fk" FOREIGN KEY ("organization_id","contract_id") REFERENCES "public"."contracts"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoice_contract_version_tenant_fk" FOREIGN KEY ("organization_id","contract_version_id") REFERENCES "public"."contract_versions"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoice_quote_tenant_fk" FOREIGN KEY ("organization_id","quote_id") REFERENCES "public"."quotes"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoice_quote_version_tenant_fk" FOREIGN KEY ("organization_id","quote_version_id") REFERENCES "public"."quote_versions"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoice_quote_option_tenant_fk" FOREIGN KEY ("organization_id","quote_option_id") REFERENCES "public"."quote_options"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_lines_org_id_unique" ON "invoice_lines" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_lines_order_unique" ON "invoice_lines" USING btree ("organization_id","invoice_id","sort_order");--> statement-breakpoint
CREATE INDEX "invoice_lines_invoice_idx" ON "invoice_lines" USING btree ("organization_id","invoice_id");--> statement-breakpoint
CREATE INDEX "invoice_status_history_idx" ON "invoice_status_history" USING btree ("organization_id","invoice_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_org_sequence_unique" ON "invoices" USING btree ("organization_id","sequence_number");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_org_identifier_unique" ON "invoices" USING btree ("organization_id","identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_live_job_unique" ON "invoices" USING btree ("organization_id","job_id") WHERE "invoices"."job_id" is not null and "invoices"."status" <> 'void' and "invoices"."archived_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_live_contract_unique" ON "invoices" USING btree ("organization_id","contract_id") WHERE "invoices"."contract_id" is not null and "invoices"."status" <> 'void' and "invoices"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "invoices_org_status_idx" ON "invoices" USING btree ("organization_id","status","created_at");--> statement-breakpoint
CREATE INDEX "invoices_org_customer_idx" ON "invoices" USING btree ("organization_id","customer_id");--> statement-breakpoint
CREATE INDEX "invoices_org_due_idx" ON "invoices" USING btree ("organization_id","due_date");
