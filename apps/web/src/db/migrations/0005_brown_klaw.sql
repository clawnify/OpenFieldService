CREATE TYPE "public"."activity_type" AS ENUM('call', 'email', 'meeting', 'visit', 'other');--> statement-breakpoint
CREATE TYPE "public"."crm_target_type" AS ENUM('customer', 'contact', 'company', 'lead', 'deal');--> statement-breakpoint
CREATE TYPE "public"."task_priority" AS ENUM('low', 'normal', 'high', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('open', 'in_progress', 'completed');--> statement-breakpoint
CREATE TABLE "activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"type" "activity_type" NOT NULL,
	"subject" text NOT NULL,
	"details" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"target_type" "crm_target_type" NOT NULL,
	"target_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"body" text NOT NULL,
	"target_type" "crm_target_type" NOT NULL,
	"target_id" uuid NOT NULL,
	"author_user_id" uuid NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" "task_status" DEFAULT 'open' NOT NULL,
	"priority" "task_priority" DEFAULT 'normal' NOT NULL,
	"due_at" timestamp with time zone,
	"assignee_user_id" uuid,
	"target_type" "crm_target_type" NOT NULL,
	"target_id" uuid NOT NULL,
	"completed_at" timestamp with time zone,
	"completed_by" uuid,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "tasks_completion_consistent" CHECK (("tasks"."status" = 'completed' and "tasks"."completed_at" is not null) or ("tasks"."status" <> 'completed' and "tasks"."completed_at" is null))
);
--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_actor_tenant_fk" FOREIGN KEY ("organization_id","actor_user_id") REFERENCES "public"."organization_members"("organization_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_author_tenant_fk" FOREIGN KEY ("organization_id","author_user_id") REFERENCES "public"."organization_members"("organization_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_tenant_fk" FOREIGN KEY ("organization_id","assignee_user_id") REFERENCES "public"."organization_members"("organization_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "activities_organization_id_unique" ON "activities" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "activities_organization_target_idx" ON "activities" USING btree ("organization_id","target_type","target_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notes_organization_id_unique" ON "notes" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "notes_organization_target_idx" ON "notes" USING btree ("organization_id","target_type","target_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_organization_id_unique" ON "tasks" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "tasks_organization_status_due_idx" ON "tasks" USING btree ("organization_id","status","due_at");--> statement-breakpoint
CREATE INDEX "tasks_organization_assignee_idx" ON "tasks" USING btree ("organization_id","assignee_user_id");--> statement-breakpoint
CREATE INDEX "tasks_organization_target_idx" ON "tasks" USING btree ("organization_id","target_type","target_id");