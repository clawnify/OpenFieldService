CREATE TYPE "public"."technician_sync_operation" AS ENUM('save_report', 'submit_report', 'set_checklist', 'add_note', 'upload_evidence', 'capture_signature', 'complete_job');--> statement-breakpoint
CREATE TYPE "public"."technician_sync_state" AS ENUM('pending', 'applied');--> statement-breakpoint
CREATE TABLE "technician_sync_mutations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"client_mutation_id" uuid NOT NULL,
	"operation" "technician_sync_operation" NOT NULL,
	"payload_hash" text NOT NULL,
	"state" "technician_sync_state" DEFAULT 'pending' NOT NULL,
	"result" jsonb,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "client_mutation_id" uuid;--> statement-breakpoint
ALTER TABLE "job_checklist_items" ADD COLUMN "last_sync_mutation_id" uuid;--> statement-breakpoint
ALTER TABLE "job_notes" ADD COLUMN "client_mutation_id" uuid;--> statement-breakpoint
ALTER TABLE "job_completion_reports" ADD COLUMN "last_sync_mutation_id" uuid;--> statement-breakpoint
ALTER TABLE "technician_sync_mutations" ADD CONSTRAINT "technician_sync_mutations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technician_sync_mutations" ADD CONSTRAINT "technician_sync_mutation_actor_tenant_fk" FOREIGN KEY ("organization_id","actor_user_id") REFERENCES "public"."organization_members"("organization_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technician_sync_mutations" ADD CONSTRAINT "technician_sync_mutation_job_tenant_fk" FOREIGN KEY ("organization_id","job_id") REFERENCES "public"."jobs"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "technician_sync_mutations_context_key_unique" ON "technician_sync_mutations" USING btree ("organization_id","actor_user_id","client_mutation_id");--> statement-breakpoint
CREATE INDEX "technician_sync_mutations_job_idx" ON "technician_sync_mutations" USING btree ("organization_id","job_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "attachments_sync_mutation_unique" ON "attachments" USING btree ("organization_id","uploaded_by","client_mutation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_notes_sync_mutation_unique" ON "job_notes" USING btree ("organization_id","author_user_id","client_mutation_id");