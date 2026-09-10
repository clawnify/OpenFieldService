CREATE TYPE "public"."proposal_link_status" AS ENUM('sent', 'viewed', 'selected', 'revoked', 'expired');--> statement-breakpoint
CREATE TABLE "proposal_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"quote_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"status" "proposal_link_status" DEFAULT 'sent' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"selected_option_id" uuid,
	"selected_at" timestamp with time zone,
	"selector_name" text,
	"selector_ip" text,
	"selector_user_agent" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tax_profile_components" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"rate_basis_points" integer NOT NULL,
	"sort_order" integer NOT NULL,
	CONSTRAINT "tax_component_rate_valid" CHECK ("tax_profile_components"."rate_basis_points" between 0 and 10000)
);
--> statement-breakpoint
CREATE TABLE "tax_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"country_code" text DEFAULT '' NOT NULL,
	"region_code" text DEFAULT '' NOT NULL,
	"currency" text DEFAULT 'CAD' NOT NULL,
	"prices_include_tax" boolean DEFAULT false NOT NULL,
	"default_taxable" boolean DEFAULT true NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_until" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tax_snapshot_components" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"rate_basis_points" integer NOT NULL,
	"amount_cents" bigint NOT NULL,
	"sort_order" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tax_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"option_id" uuid NOT NULL,
	"profile_id" uuid,
	"enabled" boolean NOT NULL,
	"country_code" text NOT NULL,
	"region_code" text NOT NULL,
	"currency" text NOT NULL,
	"prices_include_tax" boolean NOT NULL,
	"taxable_base_cents" bigint NOT NULL,
	"total_tax_cents" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "tax_profiles_org_id_unique" ON "tax_profiles" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_snapshots_org_id_unique" ON "tax_snapshots" USING btree ("organization_id","id");--> statement-breakpoint
ALTER TABLE "proposal_links" ADD CONSTRAINT "proposal_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_links" ADD CONSTRAINT "proposal_link_quote_tenant_fk" FOREIGN KEY ("organization_id","quote_id") REFERENCES "public"."quotes"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_links" ADD CONSTRAINT "proposal_link_version_tenant_fk" FOREIGN KEY ("organization_id","version_id") REFERENCES "public"."quote_versions"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_links" ADD CONSTRAINT "proposal_link_option_tenant_fk" FOREIGN KEY ("organization_id","selected_option_id") REFERENCES "public"."quote_options"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_profile_components" ADD CONSTRAINT "tax_component_profile_tenant_fk" FOREIGN KEY ("organization_id","profile_id") REFERENCES "public"."tax_profiles"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_profiles" ADD CONSTRAINT "tax_profiles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_profiles" ADD CONSTRAINT "tax_profiles_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_snapshot_components" ADD CONSTRAINT "tax_snapshot_component_tenant_fk" FOREIGN KEY ("organization_id","snapshot_id") REFERENCES "public"."tax_snapshots"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_snapshots" ADD CONSTRAINT "tax_snapshot_option_tenant_fk" FOREIGN KEY ("organization_id","option_id") REFERENCES "public"."quote_options"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_snapshots" ADD CONSTRAINT "tax_snapshot_profile_tenant_fk" FOREIGN KEY ("organization_id","profile_id") REFERENCES "public"."tax_profiles"("organization_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "proposal_links_token_hash_unique" ON "proposal_links" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "proposal_links_quote_idx" ON "proposal_links" USING btree ("organization_id","quote_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_profile_components_org_id_unique" ON "tax_profile_components" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_profile_components_profile_code_unique" ON "tax_profile_components" USING btree ("organization_id","profile_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tax_profiles_org_id_unique" ON "tax_profiles" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "tax_profiles_org_effective_idx" ON "tax_profiles" USING btree ("organization_id","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tax_snapshots_org_id_unique" ON "tax_snapshots" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_snapshots_option_unique" ON "tax_snapshots" USING btree ("organization_id","option_id");
