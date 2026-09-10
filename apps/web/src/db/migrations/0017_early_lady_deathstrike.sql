CREATE TYPE "public"."asset_status" AS ENUM('active', 'inactive', 'retired');--> statement-breakpoint
CREATE TYPE "public"."maintenance_outbox_status" AS ENUM('pending', 'processing', 'delivered', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."maintenance_service_report_status" AS ENUM('draft', 'submitted');--> statement-breakpoint
CREATE TYPE "public"."maintenance_template_version_status" AS ENUM('draft', 'published', 'superseded');--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"type" text NOT NULL,
	"display_name" text DEFAULT '' NOT NULL,
	"manufacturer" text DEFAULT '' NOT NULL,
	"model" text DEFAULT '' NOT NULL,
	"serial_number" text DEFAULT '' NOT NULL,
	"installation_date" date,
	"service_location" text NOT NULL,
	"status" "asset_status" DEFAULT 'active' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"row_version" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assets_row_version_valid" CHECK ("assets"."row_version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "maintenance_agreement_coverage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"agreement_id" uuid NOT NULL,
	"agreement_version_id" uuid NOT NULL,
	"asset_id" uuid,
	"asset_snapshot" jsonb NOT NULL,
	"coverage_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_benefit_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"quote_id" uuid,
	"quote_option_id" uuid,
	"benefit_snapshot" jsonb NOT NULL,
	"discount_cents" bigint NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "maintenance_benefit_discount_valid" CHECK ("maintenance_benefit_applications"."discount_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "maintenance_checklist_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"applicability" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"current_published_version_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_checklist_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"status" "maintenance_template_version_status" DEFAULT 'draft' NOT NULL,
	"sections" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"published_at" timestamp with time zone,
	"published_by" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_legal_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"title" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"current_published_version_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_legal_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"status" "maintenance_template_version_status" DEFAULT 'draft' NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"effective_from" date,
	"published_at" timestamp with time zone,
	"published_by" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"reminder_intent_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"event_type" text NOT NULL,
	"recipient_snapshot" jsonb NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "maintenance_outbox_status" DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "maintenance_outbox_attempt_valid" CHECK ("maintenance_outbox"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "maintenance_service_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"agreement_id" uuid NOT NULL,
	"agreement_version_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"occurrence_id" uuid NOT NULL,
	"asset_id" uuid,
	"checklist_version_id" uuid NOT NULL,
	"status" "maintenance_service_report_status" DEFAULT 'draft' NOT NULL,
	"checklist_snapshot" jsonb NOT NULL,
	"responses" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"findings" text DEFAULT '' NOT NULL,
	"deficiencies" text DEFAULT '' NOT NULL,
	"recommendations" text DEFAULT '' NOT NULL,
	"pre_work_attachment_id" uuid,
	"post_work_attachment_id" uuid,
	"customer_signer_name" text,
	"customer_signature_hash" text,
	"customer_acknowledged_at" timestamp with time zone,
	"technician_user_id" uuid NOT NULL,
	"submitted_at" timestamp with time zone,
	"submitted_by" uuid,
	"row_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "maintenance_report_submission_valid" CHECK (("maintenance_service_reports"."status" = 'draft' and "maintenance_service_reports"."submitted_at" is null) or ("maintenance_service_reports"."status" = 'submitted' and "maintenance_service_reports"."submitted_at" is not null and "maintenance_service_reports"."customer_acknowledged_at" is not null and "maintenance_service_reports"."pre_work_attachment_id" is not null and "maintenance_service_reports"."post_work_attachment_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "maintenance_signed_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"agreement_id" uuid NOT NULL,
	"agreement_version_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"sha256" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"content_type" text DEFAULT 'application/pdf' NOT NULL,
	"retained_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "maintenance_artifact_valid" CHECK ("maintenance_signed_artifacts"."size_bytes" > 0 and "maintenance_signed_artifacts"."sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "assets_org_id_unique" ON "assets" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_checklist_templates_org_id_unique" ON "maintenance_checklist_templates" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_checklist_versions_org_id_unique" ON "maintenance_checklist_versions" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_legal_documents_org_id_unique" ON "maintenance_legal_documents" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_legal_versions_org_id_unique" ON "maintenance_legal_versions" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_reminders_org_id_unique" ON "maintenance_reminder_intents" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_occurrences_org_id_unique" ON "maintenance_occurrences" USING btree ("organization_id","id");--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_customer_tenant_fk" FOREIGN KEY ("organization_id","customer_id") REFERENCES "public"."customers"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_agreement_coverage" ADD CONSTRAINT "maintenance_coverage_agreement_tenant_fk" FOREIGN KEY ("organization_id","agreement_id") REFERENCES "public"."maintenance_agreements"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_agreement_coverage" ADD CONSTRAINT "maintenance_coverage_version_tenant_fk" FOREIGN KEY ("organization_id","agreement_version_id") REFERENCES "public"."maintenance_agreement_versions"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_agreement_coverage" ADD CONSTRAINT "maintenance_coverage_asset_tenant_fk" FOREIGN KEY ("organization_id","asset_id") REFERENCES "public"."assets"("organization_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_benefit_applications" ADD CONSTRAINT "maintenance_benefit_membership_tenant_fk" FOREIGN KEY ("organization_id","membership_id") REFERENCES "public"."maintenance_memberships"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_benefit_applications" ADD CONSTRAINT "maintenance_benefit_plan_tenant_fk" FOREIGN KEY ("organization_id","plan_id") REFERENCES "public"."maintenance_plans"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_checklist_templates" ADD CONSTRAINT "maintenance_checklist_templates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_checklist_templates" ADD CONSTRAINT "maintenance_checklist_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_checklist_versions" ADD CONSTRAINT "maintenance_checklist_versions_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_checklist_versions" ADD CONSTRAINT "maintenance_checklist_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_checklist_versions" ADD CONSTRAINT "maintenance_checklist_version_template_tenant_fk" FOREIGN KEY ("organization_id","template_id") REFERENCES "public"."maintenance_checklist_templates"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_legal_documents" ADD CONSTRAINT "maintenance_legal_documents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_legal_documents" ADD CONSTRAINT "maintenance_legal_documents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_legal_versions" ADD CONSTRAINT "maintenance_legal_versions_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_legal_versions" ADD CONSTRAINT "maintenance_legal_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_legal_versions" ADD CONSTRAINT "maintenance_legal_version_document_tenant_fk" FOREIGN KEY ("organization_id","document_id") REFERENCES "public"."maintenance_legal_documents"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_outbox" ADD CONSTRAINT "maintenance_outbox_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_outbox" ADD CONSTRAINT "maintenance_outbox_reminder_tenant_fk" FOREIGN KEY ("organization_id","reminder_intent_id") REFERENCES "public"."maintenance_reminder_intents"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_service_reports" ADD CONSTRAINT "maintenance_service_reports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_service_reports" ADD CONSTRAINT "maintenance_service_reports_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_service_reports" ADD CONSTRAINT "maintenance_report_job_tenant_fk" FOREIGN KEY ("organization_id","job_id") REFERENCES "public"."jobs"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_service_reports" ADD CONSTRAINT "maintenance_report_agreement_tenant_fk" FOREIGN KEY ("organization_id","agreement_id") REFERENCES "public"."maintenance_agreements"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_service_reports" ADD CONSTRAINT "maintenance_report_version_tenant_fk" FOREIGN KEY ("organization_id","agreement_version_id") REFERENCES "public"."maintenance_agreement_versions"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_service_reports" ADD CONSTRAINT "maintenance_report_membership_tenant_fk" FOREIGN KEY ("organization_id","membership_id") REFERENCES "public"."maintenance_memberships"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_service_reports" ADD CONSTRAINT "maintenance_report_occurrence_tenant_fk" FOREIGN KEY ("organization_id","occurrence_id") REFERENCES "public"."maintenance_occurrences"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_service_reports" ADD CONSTRAINT "maintenance_report_asset_tenant_fk" FOREIGN KEY ("organization_id","asset_id") REFERENCES "public"."assets"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_service_reports" ADD CONSTRAINT "maintenance_report_checklist_tenant_fk" FOREIGN KEY ("organization_id","checklist_version_id") REFERENCES "public"."maintenance_checklist_versions"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_service_reports" ADD CONSTRAINT "maintenance_report_pre_attachment_tenant_fk" FOREIGN KEY ("organization_id","pre_work_attachment_id") REFERENCES "public"."attachments"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_service_reports" ADD CONSTRAINT "maintenance_report_post_attachment_tenant_fk" FOREIGN KEY ("organization_id","post_work_attachment_id") REFERENCES "public"."attachments"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_signed_artifacts" ADD CONSTRAINT "maintenance_artifact_agreement_tenant_fk" FOREIGN KEY ("organization_id","agreement_id") REFERENCES "public"."maintenance_agreements"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_signed_artifacts" ADD CONSTRAINT "maintenance_artifact_version_tenant_fk" FOREIGN KEY ("organization_id","agreement_version_id") REFERENCES "public"."maintenance_agreement_versions"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assets_org_customer_idx" ON "assets" USING btree ("organization_id","customer_id","status");--> statement-breakpoint
CREATE INDEX "assets_org_serial_idx" ON "assets" USING btree ("organization_id","serial_number");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_coverage_version_asset_unique" ON "maintenance_agreement_coverage" USING btree ("organization_id","agreement_version_id","asset_id");--> statement-breakpoint
CREATE INDEX "maintenance_coverage_agreement_idx" ON "maintenance_agreement_coverage" USING btree ("organization_id","agreement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_benefit_idempotency_unique" ON "maintenance_benefit_applications" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "maintenance_benefit_membership_idx" ON "maintenance_benefit_applications" USING btree ("organization_id","membership_id","created_at");--> statement-breakpoint
CREATE INDEX "maintenance_checklist_templates_org_idx" ON "maintenance_checklist_templates" USING btree ("organization_id","active");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_checklist_version_number_unique" ON "maintenance_checklist_versions" USING btree ("organization_id","template_id","version_number");--> statement-breakpoint
CREATE INDEX "maintenance_legal_documents_org_idx" ON "maintenance_legal_documents" USING btree ("organization_id","active");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_legal_version_number_unique" ON "maintenance_legal_versions" USING btree ("organization_id","document_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_outbox_intent_channel_unique" ON "maintenance_outbox" USING btree ("organization_id","reminder_intent_id","channel");--> statement-breakpoint
CREATE INDEX "maintenance_outbox_pending_idx" ON "maintenance_outbox" USING btree ("organization_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_report_job_unique" ON "maintenance_service_reports" USING btree ("organization_id","job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_reports_org_id_unique" ON "maintenance_service_reports" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "maintenance_reports_membership_idx" ON "maintenance_service_reports" USING btree ("organization_id","membership_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_artifact_version_unique" ON "maintenance_signed_artifacts" USING btree ("organization_id","agreement_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_artifact_object_key_unique" ON "maintenance_signed_artifacts" USING btree ("object_key");
