CREATE TYPE "public"."contract_signer_role" AS ENUM('customer', 'co_owner', 'company_rep', 'guarantor', 'other');--> statement-breakpoint
CREATE TYPE "public"."contract_status" AS ENUM('draft', 'sent', 'partially_signed', 'signed', 'declined', 'expired', 'cancelled', 'voided');--> statement-breakpoint
CREATE TYPE "public"."contract_signature_method" AS ENUM('typed', 'click_to_sign', 'drawn');--> statement-breakpoint
CREATE TYPE "public"."contract_signature_request_status" AS ENUM('pending', 'viewed', 'signed', 'declined', 'expired', 'revoked');--> statement-breakpoint
CREATE TABLE "contract_signature_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"signature_request_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"metadata" text DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contract_signature_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"contract_version_id" uuid NOT NULL,
	"signer_id" uuid NOT NULL,
	"status" "contract_signature_request_status" DEFAULT 'pending' NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consent_text_version" text DEFAULT 'v1' NOT NULL,
	"consent_at" timestamp with time zone,
	"signed_at" timestamp with time zone,
	"signature_method" "contract_signature_method",
	"signer_name" text,
	"signer_ip" text,
	"signer_user_agent" text,
	"signature_image_key" text,
	"declined_reason" text,
	"row_version" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contract_signers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"role" "contract_signer_role" DEFAULT 'customer' NOT NULL,
	"sort_order" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contract_status_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"from_status" "contract_status",
	"to_status" "contract_status" NOT NULL,
	"actor_user_id" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contract_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"commercial_snapshot" text NOT NULL,
	"customer_snapshot" text NOT NULL,
	"company_snapshot" text NOT NULL,
	"effective_on" text,
	"expires_at" timestamp with time zone,
	"document_hash" text,
	"signed_document_key" text,
	"signed_document_hash" text,
	"signed_at" timestamp with time zone,
	"row_version" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contract_version_row_version_valid" CHECK ("contract_versions"."row_version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"sequence_number" integer NOT NULL,
	"identifier" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"quote_id" uuid NOT NULL,
	"accepted_quote_version_id" uuid NOT NULL,
	"accepted_option_id" uuid NOT NULL,
	"accepted_total_cents" bigint NOT NULL,
	"status" "contract_status" DEFAULT 'draft' NOT NULL,
	"current_version_id" uuid,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "contract_total_nonnegative" CHECK ("contracts"."accepted_total_cents" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "contract_signature_requests_org_id_unique" ON "contract_signature_requests" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "contract_signers_org_id_unique" ON "contract_signers" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "contract_versions_org_id_unique" ON "contract_versions" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "contracts_org_id_unique" ON "contracts" USING btree ("organization_id","id");--> statement-breakpoint
ALTER TABLE "contract_signature_events" ADD CONSTRAINT "signature_event_request_tenant_fk" FOREIGN KEY ("organization_id","signature_request_id") REFERENCES "public"."contract_signature_requests"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_signature_requests" ADD CONSTRAINT "contract_signature_requests_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_signature_requests" ADD CONSTRAINT "signature_request_contract_tenant_fk" FOREIGN KEY ("organization_id","contract_id") REFERENCES "public"."contracts"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_signature_requests" ADD CONSTRAINT "signature_request_version_tenant_fk" FOREIGN KEY ("organization_id","contract_version_id") REFERENCES "public"."contract_versions"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_signature_requests" ADD CONSTRAINT "signature_request_signer_tenant_fk" FOREIGN KEY ("organization_id","signer_id") REFERENCES "public"."contract_signers"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_signers" ADD CONSTRAINT "contract_signer_contract_tenant_fk" FOREIGN KEY ("organization_id","contract_id") REFERENCES "public"."contracts"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_status_history" ADD CONSTRAINT "contract_history_contract_tenant_fk" FOREIGN KEY ("organization_id","contract_id") REFERENCES "public"."contracts"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_status_history" ADD CONSTRAINT "contract_status_history_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_versions" ADD CONSTRAINT "contract_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_versions" ADD CONSTRAINT "contract_version_contract_tenant_fk" FOREIGN KEY ("organization_id","contract_id") REFERENCES "public"."contracts"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contract_customer_tenant_fk" FOREIGN KEY ("organization_id","customer_id") REFERENCES "public"."customers"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contract_quote_tenant_fk" FOREIGN KEY ("organization_id","quote_id") REFERENCES "public"."quotes"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contract_quote_version_tenant_fk" FOREIGN KEY ("organization_id","accepted_quote_version_id") REFERENCES "public"."quote_versions"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contract_option_tenant_fk" FOREIGN KEY ("organization_id","accepted_option_id") REFERENCES "public"."quote_options"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contract_signature_events_request_idx" ON "contract_signature_events" USING btree ("organization_id","signature_request_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "contract_signature_requests_token_unique" ON "contract_signature_requests" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "contract_signature_requests_org_id_unique" ON "contract_signature_requests" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "contract_signature_requests_contract_idx" ON "contract_signature_requests" USING btree ("organization_id","contract_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "contract_signers_org_id_unique" ON "contract_signers" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "contract_signers_order_unique" ON "contract_signers" USING btree ("organization_id","contract_id","sort_order");--> statement-breakpoint
CREATE INDEX "contract_status_history_contract_idx" ON "contract_status_history" USING btree ("organization_id","contract_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "contract_versions_org_id_unique" ON "contract_versions" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "contract_versions_number_unique" ON "contract_versions" USING btree ("organization_id","contract_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "contracts_org_id_unique" ON "contracts" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "contracts_org_sequence_unique" ON "contracts" USING btree ("organization_id","sequence_number");--> statement-breakpoint
CREATE UNIQUE INDEX "contracts_org_identifier_unique" ON "contracts" USING btree ("organization_id","identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "contracts_live_quote_unique" ON "contracts" USING btree ("organization_id","quote_id") WHERE "contracts"."status" not in ('cancelled','voided') and "contracts"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "contracts_org_status_idx" ON "contracts" USING btree ("organization_id","status","created_at");--> statement-breakpoint
CREATE INDEX "contracts_org_customer_idx" ON "contracts" USING btree ("organization_id","customer_id");
