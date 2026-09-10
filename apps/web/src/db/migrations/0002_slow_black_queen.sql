CREATE TYPE "public"."lead_status" AS ENUM('new', 'contacted', 'qualified', 'estimate', 'won', 'lost');--> statement-breakpoint
CREATE TABLE "lead_status_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"old_status" "lead_status",
	"new_status" "lead_status" NOT NULL,
	"reason" text,
	"actor_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"identifier" text NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"address_line_1" text,
	"address_line_2" text,
	"city" text,
	"region" text,
	"postal_code" text,
	"source" text,
	"notes" text,
	"status" "lead_status" DEFAULT 'new' NOT NULL,
	"assigned_user_id" uuid,
	"estimated_value_cents" integer,
	"estimate_notes" text,
	"lost_reason" text,
	"lost_reason_note" text,
	"converted_customer_id" uuid,
	"converted_at" timestamp with time zone,
	"converted_by" uuid,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "leads_conversion_complete" CHECK (("leads"."converted_customer_id" is null and "leads"."converted_at" is null and "leads"."converted_by" is null) or ("leads"."converted_customer_id" is not null and "leads"."converted_at" is not null and "leads"."converted_by" is not null and "leads"."status" = 'won'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "leads_organization_identifier_unique" ON "leads" USING btree ("organization_id","identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "leads_organization_id_unique" ON "leads" USING btree ("organization_id","id");--> statement-breakpoint
ALTER TABLE "lead_status_history" ADD CONSTRAINT "lead_status_history_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_status_history" ADD CONSTRAINT "lead_status_history_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_status_history" ADD CONSTRAINT "lead_status_history_tenant_fk" FOREIGN KEY ("organization_id","lead_id") REFERENCES "public"."leads"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_converted_by_users_id_fk" FOREIGN KEY ("converted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_assignee_tenant_fk" FOREIGN KEY ("organization_id","assigned_user_id") REFERENCES "public"."organization_members"("organization_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_customer_tenant_fk" FOREIGN KEY ("organization_id","converted_customer_id") REFERENCES "public"."customers"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lead_status_history_tenant_lead_idx" ON "lead_status_history" USING btree ("organization_id","lead_id","created_at");--> statement-breakpoint
CREATE INDEX "leads_organization_status_idx" ON "leads" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "leads_organization_assignee_idx" ON "leads" USING btree ("organization_id","assigned_user_id");--> statement-breakpoint
CREATE INDEX "leads_organization_created_idx" ON "leads" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "leads_organization_email_idx" ON "leads" USING btree ("organization_id","email");--> statement-breakpoint
CREATE INDEX "leads_organization_phone_idx" ON "leads" USING btree ("organization_id","phone");
