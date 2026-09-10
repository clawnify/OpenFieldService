CREATE TYPE "public"."pipeline_stage_kind" AS ENUM('open', 'won', 'lost');--> statement-breakpoint
CREATE TABLE "pipeline_stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"kind" "pipeline_stage_kind" DEFAULT 'open' NOT NULL,
	"probability" integer DEFAULT 0 NOT NULL,
	"color" text,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "pipeline_stages_position_nonnegative" CHECK ("pipeline_stages"."position" >= 0),
	CONSTRAINT "pipeline_stages_probability_range" CHECK ("pipeline_stages"."probability" between 0 and 100),
	CONSTRAINT "pipeline_stages_terminal_probability" CHECK (("pipeline_stages"."kind" = 'open') or ("pipeline_stages"."kind" = 'won' and "pipeline_stages"."probability" = 100) or ("pipeline_stages"."kind" = 'lost' and "pipeline_stages"."probability" = 0)),
	CONSTRAINT "pipeline_stages_color_format" CHECK ("pipeline_stages"."color" is null or "pipeline_stages"."color" ~ '^#[0-9A-Fa-f]{6}$')
);
--> statement-breakpoint
CREATE TABLE "pipelines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "pipelines_archived_not_default" CHECK ("pipelines"."archived_at" is null or "pipelines"."is_default" = false)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "pipelines_organization_id_unique" ON "pipelines" USING btree ("organization_id","id");--> statement-breakpoint
ALTER TABLE "pipeline_stages" ADD CONSTRAINT "pipeline_stages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_stages" ADD CONSTRAINT "pipeline_stages_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_stages" ADD CONSTRAINT "pipeline_stages_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_stages" ADD CONSTRAINT "pipeline_stages_pipeline_tenant_fk" FOREIGN KEY ("organization_id","pipeline_id") REFERENCES "public"."pipelines"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipelines" ADD CONSTRAINT "pipelines_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipelines" ADD CONSTRAINT "pipelines_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipelines" ADD CONSTRAINT "pipelines_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_stages_organization_id_unique" ON "pipeline_stages" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_stages_active_position_unique" ON "pipeline_stages" USING btree ("organization_id","pipeline_id","position") WHERE "pipeline_stages"."archived_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_stages_active_name_unique" ON "pipeline_stages" USING btree ("organization_id","pipeline_id",lower("name")) WHERE "pipeline_stages"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "pipeline_stages_pipeline_idx" ON "pipeline_stages" USING btree ("organization_id","pipeline_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pipelines_active_name_unique" ON "pipelines" USING btree ("organization_id",lower("name")) WHERE "pipelines"."archived_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "pipelines_one_active_default_unique" ON "pipelines" USING btree ("organization_id") WHERE "pipelines"."is_default" = true and "pipelines"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "pipelines_organization_created_idx" ON "pipelines" USING btree ("organization_id","created_at");
