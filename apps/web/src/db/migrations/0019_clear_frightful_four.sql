CREATE TYPE "public"."job_completion_report_status" AS ENUM('draft', 'submitted');--> statement-breakpoint
CREATE TYPE "public"."job_evidence_kind" AS ENUM('pre_work_photo', 'post_work_photo');--> statement-breakpoint
CREATE TABLE "job_completion_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"attachment_id" uuid NOT NULL,
	"kind" "job_evidence_kind" NOT NULL,
	"position" integer NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid
);
--> statement-breakpoint
CREATE TABLE "job_completion_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"report_id" uuid NOT NULL,
	"signature_id" uuid NOT NULL,
	"technician_user_id" uuid NOT NULL,
	"completed_by" uuid NOT NULL,
	"report_snapshot" jsonb NOT NULL,
	"pre_work_evidence_snapshot" jsonb NOT NULL,
	"post_work_evidence_snapshot" jsonb NOT NULL,
	"signature_snapshot" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_completion_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"technician_user_id" uuid NOT NULL,
	"status" "job_completion_report_status" DEFAULT 'draft' NOT NULL,
	"work_performed" text DEFAULT '' NOT NULL,
	"findings" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"materials_used" text DEFAULT '' NOT NULL,
	"checklist_snapshot" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"submitted_snapshot" jsonb,
	"snapshot_hash" text,
	"row_version" integer DEFAULT 0 NOT NULL,
	"submitted_by" uuid,
	"submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_customer_signatures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"report_id" uuid NOT NULL,
	"attachment_id" uuid NOT NULL,
	"report_snapshot_hash" text NOT NULL,
	"signer_name" text NOT NULL,
	"signer_relationship" text DEFAULT '' NOT NULL,
	"acknowledgement" text NOT NULL,
	"captured_by" uuid NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "job_completion_reports_org_id_unique" ON "job_completion_reports" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_customer_signatures_org_id_unique" ON "job_customer_signatures" USING btree ("organization_id","id");--> statement-breakpoint
ALTER TABLE "job_completion_evidence" ADD CONSTRAINT "job_completion_evidence_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_completion_evidence" ADD CONSTRAINT "job_completion_evidence_job_tenant_fk" FOREIGN KEY ("organization_id","job_id") REFERENCES "public"."jobs"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_completion_evidence" ADD CONSTRAINT "job_completion_evidence_attachment_tenant_fk" FOREIGN KEY ("organization_id","attachment_id") REFERENCES "public"."attachments"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_completion_evidence" ADD CONSTRAINT "job_completion_evidence_creator_tenant_fk" FOREIGN KEY ("organization_id","created_by") REFERENCES "public"."organization_members"("organization_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_completion_evidence" ADD CONSTRAINT "job_completion_evidence_archiver_tenant_fk" FOREIGN KEY ("organization_id","archived_by") REFERENCES "public"."organization_members"("organization_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_completion_records" ADD CONSTRAINT "job_completion_records_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_completion_records" ADD CONSTRAINT "job_completion_record_job_tenant_fk" FOREIGN KEY ("organization_id","job_id") REFERENCES "public"."jobs"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_completion_records" ADD CONSTRAINT "job_completion_record_report_tenant_fk" FOREIGN KEY ("organization_id","report_id") REFERENCES "public"."job_completion_reports"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_completion_records" ADD CONSTRAINT "job_completion_record_signature_tenant_fk" FOREIGN KEY ("organization_id","signature_id") REFERENCES "public"."job_customer_signatures"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_completion_records" ADD CONSTRAINT "job_completion_record_technician_tenant_fk" FOREIGN KEY ("organization_id","technician_user_id") REFERENCES "public"."organization_members"("organization_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_completion_records" ADD CONSTRAINT "job_completion_record_actor_tenant_fk" FOREIGN KEY ("organization_id","completed_by") REFERENCES "public"."organization_members"("organization_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_completion_reports" ADD CONSTRAINT "job_completion_reports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_completion_reports" ADD CONSTRAINT "job_completion_report_job_tenant_fk" FOREIGN KEY ("organization_id","job_id") REFERENCES "public"."jobs"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_completion_reports" ADD CONSTRAINT "job_completion_report_technician_tenant_fk" FOREIGN KEY ("organization_id","technician_user_id") REFERENCES "public"."organization_members"("organization_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_completion_reports" ADD CONSTRAINT "job_completion_report_submitter_tenant_fk" FOREIGN KEY ("organization_id","submitted_by") REFERENCES "public"."organization_members"("organization_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_customer_signatures" ADD CONSTRAINT "job_customer_signatures_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_customer_signatures" ADD CONSTRAINT "job_customer_signature_job_tenant_fk" FOREIGN KEY ("organization_id","job_id") REFERENCES "public"."jobs"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_customer_signatures" ADD CONSTRAINT "job_customer_signature_report_tenant_fk" FOREIGN KEY ("organization_id","report_id") REFERENCES "public"."job_completion_reports"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_customer_signatures" ADD CONSTRAINT "job_customer_signature_attachment_tenant_fk" FOREIGN KEY ("organization_id","attachment_id") REFERENCES "public"."attachments"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_customer_signatures" ADD CONSTRAINT "job_customer_signature_capturer_tenant_fk" FOREIGN KEY ("organization_id","captured_by") REFERENCES "public"."organization_members"("organization_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "job_completion_evidence_org_id_unique" ON "job_completion_evidence" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_completion_evidence_attachment_unique" ON "job_completion_evidence" USING btree ("organization_id","attachment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_completion_evidence_position_unique" ON "job_completion_evidence" USING btree ("organization_id","job_id","kind","position");--> statement-breakpoint
CREATE INDEX "job_completion_evidence_job_idx" ON "job_completion_evidence" USING btree ("organization_id","job_id","kind","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "job_completion_records_org_id_unique" ON "job_completion_records" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_completion_records_job_unique" ON "job_completion_records" USING btree ("organization_id","job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_completion_records_idempotency_unique" ON "job_completion_records" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "job_completion_reports_job_unique" ON "job_completion_reports" USING btree ("organization_id","job_id");--> statement-breakpoint
CREATE INDEX "job_completion_reports_status_idx" ON "job_completion_reports" USING btree ("organization_id","status","submitted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "job_customer_signatures_attachment_unique" ON "job_customer_signatures" USING btree ("organization_id","attachment_id");--> statement-breakpoint
CREATE INDEX "job_customer_signatures_job_idx" ON "job_customer_signatures" USING btree ("organization_id","job_id","captured_at");
