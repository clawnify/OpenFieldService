CREATE TYPE "public"."crm_record_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"legal_name" text,
	"email" text,
	"phone" text,
	"website" text,
	"address_line_1" text,
	"address_line_2" text,
	"city" text,
	"region" text,
	"postal_code" text,
	"notes" text,
	"status" "crm_record_status" DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_id" uuid,
	"company_id" uuid,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"email" text,
	"phone" text,
	"title" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "contacts_parent_required" CHECK ("contacts"."customer_id" is not null or "contacts"."company_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "status" "crm_record_status" DEFAULT 'active' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "companies_organization_id_unique" ON "companies" USING btree ("organization_id","id");--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_customer_tenant_fk" FOREIGN KEY ("organization_id","customer_id") REFERENCES "public"."customers"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_company_tenant_fk" FOREIGN KEY ("organization_id","company_id") REFERENCES "public"."companies"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "companies_organization_name_idx" ON "companies" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "companies_organization_status_idx" ON "companies" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_organization_id_unique" ON "contacts" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "contacts_organization_name_idx" ON "contacts" USING btree ("organization_id","last_name","first_name");--> statement-breakpoint
CREATE INDEX "contacts_organization_customer_idx" ON "contacts" USING btree ("organization_id","customer_id");--> statement-breakpoint
CREATE INDEX "contacts_organization_company_idx" ON "contacts" USING btree ("organization_id","company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_primary_customer_unique" ON "contacts" USING btree ("organization_id","customer_id") WHERE "contacts"."is_primary" = true and "contacts"."active" = true and "contacts"."customer_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_primary_company_unique" ON "contacts" USING btree ("organization_id","company_id") WHERE "contacts"."is_primary" = true and "contacts"."active" = true and "contacts"."company_id" is not null;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_company_tenant_fk" FOREIGN KEY ("organization_id","company_id") REFERENCES "public"."companies"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customers_organization_company_idx" ON "customers" USING btree ("organization_id","company_id");--> statement-breakpoint
CREATE INDEX "customers_organization_status_idx" ON "customers" USING btree ("organization_id","status");
