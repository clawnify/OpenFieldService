CREATE TYPE "public"."payment_entry_type" AS ENUM('payment', 'reversal');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('cash', 'check', 'credit_card', 'debit_card', 'e_transfer', 'bank_transfer', 'financing', 'other');--> statement-breakpoint
CREATE TYPE "public"."payment_payer_type" AS ENUM('customer', 'government', 'third_party');--> statement-breakpoint
CREATE TYPE "public"."payment_source" AS ENUM('manual', 'online_provider');--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"entry_type" "payment_entry_type" DEFAULT 'payment' NOT NULL,
	"amount_cents" bigint NOT NULL,
	"currency" text NOT NULL,
	"payer_type" "payment_payer_type" NOT NULL,
	"payer_snapshot" text DEFAULT '{}' NOT NULL,
	"method" "payment_method" NOT NULL,
	"source" "payment_source" DEFAULT 'manual' NOT NULL,
	"external_reference" text,
	"idempotency_key" text,
	"received_by" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"business_date" date NOT NULL,
	"recorded_by" uuid,
	"reverses_payment_id" uuid,
	"reversal_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_amount_positive" CHECK ("payments"."amount_cents" > 0),
	CONSTRAINT "payment_currency_format" CHECK ("payments"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "payment_event_integrity" CHECK (("payments"."entry_type"='payment' and "payments"."reverses_payment_id" is null and "payments"."reversal_reason" is null) or ("payments"."entry_type"='reversal' and "payments"."reverses_payment_id" is not null and length(trim("payments"."reversal_reason")) > 0))
);
--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payment_invoice_tenant_fk" FOREIGN KEY ("organization_id","invoice_id") REFERENCES "public"."invoices"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_org_id_unique" ON "payments" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_org_invoice_id_unique" ON "payments" USING btree ("organization_id","invoice_id","id");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payment_reversal_tenant_invoice_fk" FOREIGN KEY ("organization_id","invoice_id","reverses_payment_id") REFERENCES "public"."payments"("organization_id","invoice_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_reversal_unique" ON "payments" USING btree ("organization_id","reverses_payment_id") WHERE "payments"."reverses_payment_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_idempotency_unique" ON "payments" USING btree ("organization_id","source","idempotency_key") WHERE "payments"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "payments_invoice_posted_idx" ON "payments" USING btree ("organization_id","invoice_id","posted_at");--> statement-breakpoint
CREATE INDEX "payments_reference_idx" ON "payments" USING btree ("organization_id","external_reference");
