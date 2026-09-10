CREATE TYPE "public"."job_priority" AS ENUM('low', 'normal', 'high', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('scheduled', 'in_progress', 'completed', 'invoiced', 'cancelled');--> statement-breakpoint
ALTER TYPE "public"."attachment_target_type" ADD VALUE 'job';--> statement-breakpoint
CREATE TABLE "job_checklist_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"label" text NOT NULL,
	"position" integer NOT NULL,
	"completed" boolean DEFAULT false NOT NULL,
	"completed_at" timestamp with time zone,
	"completed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "job_checklist_completion_consistent" CHECK (("job_checklist_items"."completed"=false and "job_checklist_items"."completed_at" is null) or ("job_checklist_items"."completed"=true and "job_checklist_items"."completed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "job_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"body" text NOT NULL,
	"author_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "job_schedule_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"old_technician_user_id" uuid,
	"new_technician_user_id" uuid,
	"old_scheduled_date" date,
	"new_scheduled_date" date,
	"old_scheduled_time" time,
	"new_scheduled_time" time,
	"old_duration_minutes" integer NOT NULL,
	"new_duration_minutes" integer NOT NULL,
	"actor_user_id" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_status_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"from_status" "job_status",
	"to_status" "job_status" NOT NULL,
	"actor_user_id" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"sequence_number" bigint NOT NULL,
	"identifier" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"contact_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"service_address" text NOT NULL,
	"status" "job_status" DEFAULT 'scheduled' NOT NULL,
	"priority" "job_priority" DEFAULT 'normal' NOT NULL,
	"technician_user_id" uuid,
	"scheduled_date" date,
	"scheduled_time" time,
	"duration_minutes" integer DEFAULT 60 NOT NULL,
	"timezone" text DEFAULT 'America/Vancouver' NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "jobs_duration_positive" CHECK ("jobs"."duration_minutes">0 and "jobs"."duration_minutes"<=1440),
	CONSTRAINT "jobs_schedule_complete" CHECK (("jobs"."scheduled_date" is null and "jobs"."scheduled_time" is null) or ("jobs"."scheduled_date" is not null and "jobs"."scheduled_time" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_org_id_unique" ON "jobs" USING btree ("organization_id","id");--> statement-breakpoint
ALTER TABLE "job_checklist_items" ADD CONSTRAINT "job_checklist_items_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_checklist_items" ADD CONSTRAINT "job_checklist_tenant_fk" FOREIGN KEY ("organization_id","job_id") REFERENCES "public"."jobs"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_notes" ADD CONSTRAINT "job_notes_tenant_fk" FOREIGN KEY ("organization_id","job_id") REFERENCES "public"."jobs"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_notes" ADD CONSTRAINT "job_notes_author_tenant_fk" FOREIGN KEY ("organization_id","author_user_id") REFERENCES "public"."organization_members"("organization_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_schedule_history" ADD CONSTRAINT "job_schedule_history_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_schedule_history" ADD CONSTRAINT "job_schedule_history_tenant_fk" FOREIGN KEY ("organization_id","job_id") REFERENCES "public"."jobs"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_status_history" ADD CONSTRAINT "job_status_history_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_status_history" ADD CONSTRAINT "job_status_history_tenant_fk" FOREIGN KEY ("organization_id","job_id") REFERENCES "public"."jobs"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_customer_tenant_fk" FOREIGN KEY ("organization_id","customer_id") REFERENCES "public"."customers"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_contact_tenant_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contacts"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_technician_tenant_fk" FOREIGN KEY ("organization_id","technician_user_id") REFERENCES "public"."organization_members"("organization_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "job_checklist_position_unique" ON "job_checklist_items" USING btree ("organization_id","job_id","position");--> statement-breakpoint
CREATE INDEX "job_checklist_job_idx" ON "job_checklist_items" USING btree ("organization_id","job_id");--> statement-breakpoint
CREATE INDEX "job_notes_job_idx" ON "job_notes" USING btree ("organization_id","job_id","created_at");--> statement-breakpoint
CREATE INDEX "job_schedule_history_idx" ON "job_schedule_history" USING btree ("organization_id","job_id","created_at");--> statement-breakpoint
CREATE INDEX "job_status_history_idx" ON "job_status_history" USING btree ("organization_id","job_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_org_sequence_unique" ON "jobs" USING btree ("organization_id","sequence_number");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_org_identifier_unique" ON "jobs" USING btree ("organization_id","identifier");--> statement-breakpoint
CREATE INDEX "jobs_org_schedule_idx" ON "jobs" USING btree ("organization_id","scheduled_date","scheduled_time");--> statement-breakpoint
CREATE INDEX "jobs_org_technician_schedule_idx" ON "jobs" USING btree ("organization_id","technician_user_id","scheduled_date");--> statement-breakpoint
CREATE INDEX "jobs_org_customer_idx" ON "jobs" USING btree ("organization_id","customer_id");
