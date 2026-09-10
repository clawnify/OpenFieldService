CREATE TABLE "retention_public_capabilities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"resource_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retention_public_capability_purpose_valid" CHECK ("retention_public_capabilities"."purpose" in ('follow_up_response','marketing_unsubscribe'))
);
--> statement-breakpoint
CREATE TABLE "retention_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"follow_up_delay_days" integer DEFAULT 7 NOT NULL,
	"public_base_url" text,
	"review_url" text,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retention_settings_delay_valid" CHECK ("retention_settings"."follow_up_delay_days" between 0 and 365)
);
--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD COLUMN "available_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "retention_follow_ups" ADD COLUMN "response" text;--> statement-breakpoint
ALTER TABLE "retention_follow_ups" ADD COLUMN "review_url_snapshot" text;--> statement-breakpoint
ALTER TABLE "retention_follow_ups" ADD COLUMN "review_clicked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "retention_follow_ups" ADD COLUMN "maintenance_offer_shown" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "retention_follow_ups" ADD COLUMN "maintenance_offer_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "retention_public_capabilities" ADD CONSTRAINT "retention_public_capabilities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_public_capabilities" ADD CONSTRAINT "retention_public_capability_customer_tenant_fk" FOREIGN KEY ("organization_id","customer_id") REFERENCES "public"."customers"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_settings" ADD CONSTRAINT "retention_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_settings" ADD CONSTRAINT "retention_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "retention_public_capability_token_unique" ON "retention_public_capabilities" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "retention_public_capability_resource_unique" ON "retention_public_capabilities" USING btree ("organization_id","purpose","resource_id");--> statement-breakpoint
CREATE INDEX "retention_public_capability_customer_idx" ON "retention_public_capabilities" USING btree ("organization_id","customer_id","purpose");--> statement-breakpoint
CREATE UNIQUE INDEX "retention_settings_org_unique" ON "retention_settings" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "retention_settings_org_id_unique" ON "retention_settings" USING btree ("organization_id","id");