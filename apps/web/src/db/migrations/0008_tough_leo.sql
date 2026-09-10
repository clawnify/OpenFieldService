CREATE TYPE "public"."discount_type" AS ENUM('none', 'fixed', 'percent');--> statement-breakpoint
CREATE TYPE "public"."quote_option_tier" AS ENUM('good', 'better', 'best', 'custom');--> statement-breakpoint
CREATE TYPE "public"."pricebook_item_type" AS ENUM('equipment', 'part', 'material', 'service', 'labor', 'other');--> statement-breakpoint
CREATE TYPE "public"."pricebook_status" AS ENUM('active', 'inactive');--> statement-breakpoint
CREATE TYPE "public"."quote_status" AS ENUM('draft', 'sent', 'accepted', 'rejected', 'expired', 'cancelled');--> statement-breakpoint
CREATE TABLE "pricebook_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"parent_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pricebook_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"category_id" uuid,
	"type" "pricebook_item_type" NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"sku" text,
	"unit" text DEFAULT 'each' NOT NULL,
	"default_quantity_milli" integer DEFAULT 1000 NOT NULL,
	"cost_cents" bigint DEFAULT 0 NOT NULL,
	"sell_price_cents" bigint DEFAULT 0 NOT NULL,
	"taxable" boolean DEFAULT true NOT NULL,
	"status" "pricebook_status" DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricebook_item_money_nonnegative" CHECK ("pricebook_items"."cost_cents">=0 and "pricebook_items"."sell_price_cents">=0),
	CONSTRAINT "pricebook_item_quantity_positive" CHECK ("pricebook_items"."default_quantity_milli">0)
);
--> statement-breakpoint
CREATE TABLE "quote_option_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"option_id" uuid NOT NULL,
	"pricebook_item_id" uuid,
	"description" text NOT NULL,
	"category" text DEFAULT 'other' NOT NULL,
	"quantity_milli" integer NOT NULL,
	"unit" text NOT NULL,
	"unit_price_cents" bigint NOT NULL,
	"cost_cents" bigint,
	"taxable" boolean DEFAULT true NOT NULL,
	"total_cents" bigint NOT NULL,
	"sort_order" integer NOT NULL,
	CONSTRAINT "quote_line_values_valid" CHECK ("quote_option_lines"."quantity_milli">0 and "quote_option_lines"."unit_price_cents">=0 and "quote_option_lines"."total_cents">=0)
);
--> statement-breakpoint
CREATE TABLE "quote_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"quote_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"tier" "quote_option_tier" NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"sort_order" integer NOT NULL,
	"recommended" boolean DEFAULT false NOT NULL,
	"subtotal_cents" bigint DEFAULT 0 NOT NULL,
	"discount_cents" bigint DEFAULT 0 NOT NULL,
	"tax_cents" bigint DEFAULT 0 NOT NULL,
	"total_cents" bigint DEFAULT 0 NOT NULL,
	"row_version" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quote_status_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"quote_id" uuid NOT NULL,
	"from_status" "quote_status",
	"to_status" "quote_status" NOT NULL,
	"actor_user_id" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quote_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"quote_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"discount_type" "discount_type" DEFAULT 'none' NOT NULL,
	"discount_basis_points" integer DEFAULT 0 NOT NULL,
	"discount_cents" bigint DEFAULT 0 NOT NULL,
	"tax_basis_points" integer DEFAULT 0 NOT NULL,
	"subtotal_cents" bigint DEFAULT 0 NOT NULL,
	"tax_cents" bigint DEFAULT 0 NOT NULL,
	"total_cents" bigint DEFAULT 0 NOT NULL,
	"notes" text,
	"expires_on" date,
	"row_version" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quote_version_rates_valid" CHECK ("quote_versions"."discount_basis_points" between 0 and 10000 and "quote_versions"."tax_basis_points" between 0 and 10000)
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"sequence_number" integer NOT NULL,
	"identifier" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"lead_id" uuid,
	"status" "quote_status" DEFAULT 'draft' NOT NULL,
	"current_version_id" uuid,
	"accepted_version_id" uuid,
	"accepted_option_id" uuid,
	"accepted_by" uuid,
	"accepted_at" timestamp with time zone,
	"rejected_reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "pricebook_categories_org_id_unique" ON "pricebook_categories" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "pricebook_items_org_id_unique" ON "pricebook_items" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "quote_option_lines_org_id_unique" ON "quote_option_lines" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "quote_options_org_id_unique" ON "quote_options" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "quote_versions_org_id_unique" ON "quote_versions" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "quotes_org_id_unique" ON "quotes" USING btree ("organization_id","id");--> statement-breakpoint
ALTER TABLE "pricebook_categories" ADD CONSTRAINT "pricebook_categories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricebook_categories" ADD CONSTRAINT "pricebook_category_parent_tenant_fk" FOREIGN KEY ("organization_id","parent_id") REFERENCES "public"."pricebook_categories"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricebook_items" ADD CONSTRAINT "pricebook_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricebook_items" ADD CONSTRAINT "pricebook_items_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricebook_items" ADD CONSTRAINT "pricebook_items_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricebook_items" ADD CONSTRAINT "pricebook_item_category_tenant_fk" FOREIGN KEY ("organization_id","category_id") REFERENCES "public"."pricebook_categories"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_option_lines" ADD CONSTRAINT "quote_line_option_tenant_fk" FOREIGN KEY ("organization_id","option_id") REFERENCES "public"."quote_options"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_option_lines" ADD CONSTRAINT "quote_line_pricebook_tenant_fk" FOREIGN KEY ("organization_id","pricebook_item_id") REFERENCES "public"."pricebook_items"("organization_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_options" ADD CONSTRAINT "quote_option_quote_tenant_fk" FOREIGN KEY ("organization_id","quote_id") REFERENCES "public"."quotes"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_options" ADD CONSTRAINT "quote_option_version_tenant_fk" FOREIGN KEY ("organization_id","version_id") REFERENCES "public"."quote_versions"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_status_history" ADD CONSTRAINT "quote_status_history_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_status_history" ADD CONSTRAINT "quote_history_quote_tenant_fk" FOREIGN KEY ("organization_id","quote_id") REFERENCES "public"."quotes"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_versions" ADD CONSTRAINT "quote_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_versions" ADD CONSTRAINT "quote_version_quote_tenant_fk" FOREIGN KEY ("organization_id","quote_id") REFERENCES "public"."quotes"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quote_customer_tenant_fk" FOREIGN KEY ("organization_id","customer_id") REFERENCES "public"."customers"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quote_lead_tenant_fk" FOREIGN KEY ("organization_id","lead_id") REFERENCES "public"."leads"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quote_acceptor_tenant_fk" FOREIGN KEY ("organization_id","accepted_by") REFERENCES "public"."organization_members"("organization_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pricebook_categories_org_id_unique" ON "pricebook_categories" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "pricebook_categories_org_name_unique" ON "pricebook_categories" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "pricebook_categories_org_order_idx" ON "pricebook_categories" USING btree ("organization_id","sort_order","name");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pricebook_items_org_id_unique" ON "pricebook_items" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "pricebook_items_org_sku_unique" ON "pricebook_items" USING btree ("organization_id","sku") WHERE "pricebook_items"."sku" is not null;--> statement-breakpoint
CREATE INDEX "pricebook_items_org_search_idx" ON "pricebook_items" USING btree ("organization_id","status","type","name");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "quote_option_lines_org_id_unique" ON "quote_option_lines" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "quote_option_lines_option_order_idx" ON "quote_option_lines" USING btree ("organization_id","option_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "quote_options_org_id_unique" ON "quote_options" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "quote_options_version_tier_unique" ON "quote_options" USING btree ("organization_id","version_id","tier");--> statement-breakpoint
CREATE INDEX "quote_status_history_idx" ON "quote_status_history" USING btree ("organization_id","quote_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "quote_versions_org_id_unique" ON "quote_versions" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "quote_versions_quote_number_unique" ON "quote_versions" USING btree ("organization_id","quote_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "quotes_org_id_unique" ON "quotes" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "quotes_org_sequence_unique" ON "quotes" USING btree ("organization_id","sequence_number");--> statement-breakpoint
CREATE UNIQUE INDEX "quotes_org_identifier_unique" ON "quotes" USING btree ("organization_id","identifier");--> statement-breakpoint
CREATE INDEX "quotes_org_status_idx" ON "quotes" USING btree ("organization_id","status","created_at");
