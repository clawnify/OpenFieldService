CREATE TABLE "deal_stage_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"deal_id" uuid NOT NULL,
	"previous_pipeline_id" uuid,
	"previous_stage_id" uuid,
	"new_pipeline_id" uuid NOT NULL,
	"new_stage_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"identifier" text NOT NULL,
	"name" text NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"stage_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"contact_id" uuid,
	"owner_user_id" uuid,
	"amount_cents" bigint DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'CAD' NOT NULL,
	"expected_close_date" date,
	"closed_at" timestamp with time zone,
	"lost_reason" text,
	"lost_reason_note" text,
	"source" text,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "deals_amount_nonnegative" CHECK ("deals"."amount_cents" >= 0),
	CONSTRAINT "deals_currency_format" CHECK ("deals"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "deals_lost_reason_complete" CHECK ("deals"."lost_reason" is null or "deals"."closed_at" is not null)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "deals_organization_id_unique" ON "deals" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_stages_pipeline_id_unique" ON "pipeline_stages" USING btree ("organization_id","pipeline_id","id");--> statement-breakpoint
ALTER TABLE "deal_stage_history" ADD CONSTRAINT "deal_stage_history_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_stage_history" ADD CONSTRAINT "deal_stage_history_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_stage_history" ADD CONSTRAINT "deal_stage_history_deal_tenant_fk" FOREIGN KEY ("organization_id","deal_id") REFERENCES "public"."deals"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_pipeline_tenant_fk" FOREIGN KEY ("organization_id","pipeline_id") REFERENCES "public"."pipelines"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_stage_pipeline_tenant_fk" FOREIGN KEY ("organization_id","pipeline_id","stage_id") REFERENCES "public"."pipeline_stages"("organization_id","pipeline_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_customer_tenant_fk" FOREIGN KEY ("organization_id","customer_id") REFERENCES "public"."customers"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_contact_tenant_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contacts"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_owner_tenant_fk" FOREIGN KEY ("organization_id","owner_user_id") REFERENCES "public"."organization_members"("organization_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deal_stage_history_deal_idx" ON "deal_stage_history" USING btree ("organization_id","deal_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "deals_organization_identifier_unique" ON "deals" USING btree ("organization_id","identifier");--> statement-breakpoint
CREATE INDEX "deals_organization_stage_idx" ON "deals" USING btree ("organization_id","pipeline_id","stage_id");--> statement-breakpoint
CREATE INDEX "deals_organization_owner_idx" ON "deals" USING btree ("organization_id","owner_user_id");--> statement-breakpoint
CREATE INDEX "deals_organization_customer_idx" ON "deals" USING btree ("organization_id","customer_id");--> statement-breakpoint
CREATE INDEX "deals_organization_close_idx" ON "deals" USING btree ("organization_id","expected_close_date");--> statement-breakpoint
CREATE INDEX "deals_organization_created_idx" ON "deals" USING btree ("organization_id","created_at");
