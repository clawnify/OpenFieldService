CREATE TYPE "public"."maintenance_agreement_status" AS ENUM('draft', 'sent', 'viewed', 'active', 'cancelled', 'expired', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."maintenance_entitlement_event_type" AS ENUM('grant', 'consume', 'adjust');--> statement-breakpoint
CREATE TYPE "public"."maintenance_membership_status" AS ENUM('active', 'cancelled', 'expired', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."maintenance_occurrence_status" AS ENUM('claimed', 'job_generated', 'skipped', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."maintenance_plan_status" AS ENUM('active', 'inactive');--> statement-breakpoint
CREATE TYPE "public"."maintenance_recurrence" AS ENUM('annual', 'semi_annual', 'quarterly', 'custom_days');--> statement-breakpoint
CREATE TYPE "public"."maintenance_reminder_status" AS ENUM('pending', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."maintenance_renewal_preference" AS ENUM('none', 'manual', 'auto');--> statement-breakpoint
CREATE TYPE "public"."maintenance_schedule_status" AS ENUM('active', 'paused', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."maintenance_signature_status" AS ENUM('pending', 'signed', 'revoked', 'expired');--> statement-breakpoint
CREATE TABLE "maintenance_agreement_status_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"agreement_id" uuid NOT NULL,
	"from_status" "maintenance_agreement_status",
	"to_status" "maintenance_agreement_status" NOT NULL,
	"actor_user_id" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_agreement_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"agreement_id" uuid NOT NULL,
	"version_number" integer DEFAULT 1 NOT NULL,
	"plan_snapshot" text NOT NULL,
	"customer_snapshot" text NOT NULL,
	"service_location_snapshot" text NOT NULL,
	"terms_snapshot" text DEFAULT '' NOT NULL,
	"effective_date" date NOT NULL,
	"expires_on" date NOT NULL,
	"renewal_preference" "maintenance_renewal_preference" DEFAULT 'none' NOT NULL,
	"auto_renew_consent" text DEFAULT '{}' NOT NULL,
	"total_price_cents" bigint NOT NULL,
	"currency" text NOT NULL,
	"document_hash" text,
	"signed_at" timestamp with time zone,
	"signature_method" text,
	"activation_provenance" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "maintenance_version_term_valid" CHECK ("maintenance_agreement_versions"."expires_on">="maintenance_agreement_versions"."effective_date" and "maintenance_agreement_versions"."total_price_cents">=0 and "maintenance_agreement_versions"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "maintenance_agreements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"sequence_number" integer NOT NULL,
	"identifier" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"status" "maintenance_agreement_status" DEFAULT 'draft' NOT NULL,
	"current_version_id" uuid,
	"supersedes_agreement_id" uuid,
	"superseded_by_agreement_id" uuid,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"row_version" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "maintenance_agreement_row_version_valid" CHECK ("maintenance_agreements"."row_version">=0)
);
--> statement-breakpoint
CREATE TABLE "maintenance_automation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"triggered_by" text NOT NULL,
	"actor_user_id" uuid,
	"occurrences_processed" integer DEFAULT 0 NOT NULL,
	"jobs_generated" integer DEFAULT 0 NOT NULL,
	"renewals_processed" integer DEFAULT 0 NOT NULL,
	"reminders_created" integer DEFAULT 0 NOT NULL,
	"errored_count" integer DEFAULT 0 NOT NULL,
	"error_summary" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_entitlement_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"event_type" "maintenance_entitlement_event_type" NOT NULL,
	"visit_delta" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"actor_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "maintenance_entitlement_delta_valid" CHECK ("maintenance_entitlement_events"."visit_delta"<>0)
);
--> statement-breakpoint
CREATE TABLE "maintenance_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"agreement_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"status" "maintenance_membership_status" DEFAULT 'active' NOT NULL,
	"effective_start" date NOT NULL,
	"effective_end" date NOT NULL,
	"visits_included" integer,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "maintenance_membership_term_valid" CHECK ("maintenance_memberships"."effective_end">="maintenance_memberships"."effective_start" and ("maintenance_memberships"."visits_included" is null or "maintenance_memberships"."visits_included">0))
);
--> statement-breakpoint
CREATE TABLE "maintenance_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"schedule_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"cycle_number" integer NOT NULL,
	"due_date" date NOT NULL,
	"status" "maintenance_occurrence_status" DEFAULT 'claimed' NOT NULL,
	"job_id" uuid,
	"skip_reason" text,
	"generated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "maintenance_occurrence_cycle_valid" CHECK ("maintenance_occurrences"."cycle_number">0)
);
--> statement-breakpoint
CREATE TABLE "maintenance_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"tier" text DEFAULT 'CUSTOM' NOT NULL,
	"status" "maintenance_plan_status" DEFAULT 'active' NOT NULL,
	"price_cents" bigint DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'CAD' NOT NULL,
	"taxable" boolean DEFAULT true NOT NULL,
	"visit_entitlement_count" integer,
	"frequency_description" text DEFAULT '' NOT NULL,
	"priority_benefit" text DEFAULT '' NOT NULL,
	"discount_type" text DEFAULT 'none' NOT NULL,
	"discount_basis_points" integer,
	"discount_fixed_cents" bigint,
	"included_services" text DEFAULT '[]' NOT NULL,
	"excluded_services" text DEFAULT '[]' NOT NULL,
	"other_benefits" text DEFAULT '[]' NOT NULL,
	"equipment_eligibility" text DEFAULT '[]' NOT NULL,
	"effective_from" date,
	"effective_until" date,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "maintenance_plan_money_valid" CHECK ("maintenance_plans"."price_cents">=0 and ("maintenance_plans"."discount_fixed_cents" is null or "maintenance_plans"."discount_fixed_cents">=0) and ("maintenance_plans"."discount_basis_points" is null or ("maintenance_plans"."discount_basis_points">=0 and "maintenance_plans"."discount_basis_points"<=10000))),
	CONSTRAINT "maintenance_plan_visits_valid" CHECK ("maintenance_plans"."visit_entitlement_count" is null or "maintenance_plans"."visit_entitlement_count">0),
	CONSTRAINT "maintenance_plan_currency_valid" CHECK ("maintenance_plans"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "maintenance_reminder_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"agreement_id" uuid NOT NULL,
	"agreement_version_id" uuid NOT NULL,
	"milestone_days" integer NOT NULL,
	"status" "maintenance_reminder_status" DEFAULT 'pending' NOT NULL,
	"recipient_snapshot" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "maintenance_reminder_milestone_valid" CHECK ("maintenance_reminder_intents"."milestone_days" in (60,30,14))
);
--> statement-breakpoint
CREATE TABLE "maintenance_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"recurrence" "maintenance_recurrence" NOT NULL,
	"custom_interval_days" integer,
	"status" "maintenance_schedule_status" DEFAULT 'active' NOT NULL,
	"next_due_date" date NOT NULL,
	"cycles_generated" integer DEFAULT 0 NOT NULL,
	"automation_enabled" boolean DEFAULT true NOT NULL,
	"pause_reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "maintenance_schedule_interval_valid" CHECK (("maintenance_schedules"."recurrence"='custom_days' and "maintenance_schedules"."custom_interval_days" between 1 and 3650) or ("maintenance_schedules"."recurrence"<>'custom_days' and "maintenance_schedules"."custom_interval_days" is null)),
	CONSTRAINT "maintenance_schedule_cycles_valid" CHECK ("maintenance_schedules"."cycles_generated">=0)
);
--> statement-breakpoint
CREATE TABLE "maintenance_signature_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"agreement_id" uuid NOT NULL,
	"agreement_version_id" uuid NOT NULL,
	"status" "maintenance_signature_status" DEFAULT 'pending' NOT NULL,
	"token_hash" text NOT NULL,
	"signer_name" text NOT NULL,
	"signer_email" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consent_at" timestamp with time zone,
	"signed_at" timestamp with time zone,
	"signature_method" text,
	"signer_ip" text,
	"signer_user_agent" text,
	"auto_renew_enabled" boolean,
	"row_version" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "maintenance_signature_completion_valid" CHECK (("maintenance_signature_requests"."status"<>'signed') or ("maintenance_signature_requests"."signed_at" is not null and "maintenance_signature_requests"."consent_at" is not null and "maintenance_signature_requests"."auto_renew_enabled" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_agreements_org_id_unique" ON "maintenance_agreements" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_agreement_versions_org_id_unique" ON "maintenance_agreement_versions" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_plans_org_id_unique" ON "maintenance_plans" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_memberships_org_id_unique" ON "maintenance_memberships" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_schedules_org_id_unique" ON "maintenance_schedules" USING btree ("organization_id","id");--> statement-breakpoint
ALTER TABLE "maintenance_agreement_status_history" ADD CONSTRAINT "maintenance_agreement_status_history_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_agreement_status_history" ADD CONSTRAINT "maintenance_history_agreement_tenant_fk" FOREIGN KEY ("organization_id","agreement_id") REFERENCES "public"."maintenance_agreements"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_agreement_versions" ADD CONSTRAINT "maintenance_agreement_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_agreement_versions" ADD CONSTRAINT "maintenance_version_agreement_tenant_fk" FOREIGN KEY ("organization_id","agreement_id") REFERENCES "public"."maintenance_agreements"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_agreements" ADD CONSTRAINT "maintenance_agreements_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_agreements" ADD CONSTRAINT "maintenance_agreements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_agreements" ADD CONSTRAINT "maintenance_agreements_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_agreements" ADD CONSTRAINT "maintenance_agreement_customer_tenant_fk" FOREIGN KEY ("organization_id","customer_id") REFERENCES "public"."customers"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_agreements" ADD CONSTRAINT "maintenance_agreement_plan_tenant_fk" FOREIGN KEY ("organization_id","plan_id") REFERENCES "public"."maintenance_plans"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_agreements" ADD CONSTRAINT "maintenance_agreement_supersedes_tenant_fk" FOREIGN KEY ("organization_id","supersedes_agreement_id") REFERENCES "public"."maintenance_agreements"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_agreements" ADD CONSTRAINT "maintenance_agreement_superseded_by_tenant_fk" FOREIGN KEY ("organization_id","superseded_by_agreement_id") REFERENCES "public"."maintenance_agreements"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_automation_runs" ADD CONSTRAINT "maintenance_automation_runs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_entitlement_events" ADD CONSTRAINT "maintenance_entitlement_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_entitlement_events" ADD CONSTRAINT "maintenance_entitlement_membership_tenant_fk" FOREIGN KEY ("organization_id","membership_id") REFERENCES "public"."maintenance_memberships"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_memberships" ADD CONSTRAINT "maintenance_membership_agreement_tenant_fk" FOREIGN KEY ("organization_id","agreement_id") REFERENCES "public"."maintenance_agreements"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_memberships" ADD CONSTRAINT "maintenance_membership_customer_tenant_fk" FOREIGN KEY ("organization_id","customer_id") REFERENCES "public"."customers"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_memberships" ADD CONSTRAINT "maintenance_membership_plan_tenant_fk" FOREIGN KEY ("organization_id","plan_id") REFERENCES "public"."maintenance_plans"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_occurrences" ADD CONSTRAINT "maintenance_occurrence_schedule_tenant_fk" FOREIGN KEY ("organization_id","schedule_id") REFERENCES "public"."maintenance_schedules"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_occurrences" ADD CONSTRAINT "maintenance_occurrence_membership_tenant_fk" FOREIGN KEY ("organization_id","membership_id") REFERENCES "public"."maintenance_memberships"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_occurrences" ADD CONSTRAINT "maintenance_occurrence_job_tenant_fk" FOREIGN KEY ("organization_id","job_id") REFERENCES "public"."jobs"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_plans" ADD CONSTRAINT "maintenance_plans_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_plans" ADD CONSTRAINT "maintenance_plans_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_plans" ADD CONSTRAINT "maintenance_plans_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_reminder_intents" ADD CONSTRAINT "maintenance_reminder_agreement_tenant_fk" FOREIGN KEY ("organization_id","agreement_id") REFERENCES "public"."maintenance_agreements"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_reminder_intents" ADD CONSTRAINT "maintenance_reminder_version_tenant_fk" FOREIGN KEY ("organization_id","agreement_version_id") REFERENCES "public"."maintenance_agreement_versions"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_schedules" ADD CONSTRAINT "maintenance_schedules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_schedules" ADD CONSTRAINT "maintenance_schedule_membership_tenant_fk" FOREIGN KEY ("organization_id","membership_id") REFERENCES "public"."maintenance_memberships"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_signature_requests" ADD CONSTRAINT "maintenance_signature_requests_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_signature_requests" ADD CONSTRAINT "maintenance_signature_agreement_tenant_fk" FOREIGN KEY ("organization_id","agreement_id") REFERENCES "public"."maintenance_agreements"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_signature_requests" ADD CONSTRAINT "maintenance_signature_version_tenant_fk" FOREIGN KEY ("organization_id","agreement_version_id") REFERENCES "public"."maintenance_agreement_versions"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "maintenance_agreement_history_idx" ON "maintenance_agreement_status_history" USING btree ("organization_id","agreement_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_agreement_version_unique" ON "maintenance_agreement_versions" USING btree ("organization_id","agreement_id","version_number");--> statement-breakpoint
CREATE INDEX "maintenance_agreement_versions_agreement_idx" ON "maintenance_agreement_versions" USING btree ("organization_id","agreement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_agreements_org_sequence_unique" ON "maintenance_agreements" USING btree ("organization_id","sequence_number");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_agreements_org_identifier_unique" ON "maintenance_agreements" USING btree ("organization_id","identifier");--> statement-breakpoint
CREATE INDEX "maintenance_agreements_org_status_idx" ON "maintenance_agreements" USING btree ("organization_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "maintenance_agreements_customer_idx" ON "maintenance_agreements" USING btree ("organization_id","customer_id");--> statement-breakpoint
CREATE INDEX "maintenance_automation_runs_org_idx" ON "maintenance_automation_runs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_entitlement_idempotency_unique" ON "maintenance_entitlement_events" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "maintenance_entitlement_membership_idx" ON "maintenance_entitlement_events" USING btree ("organization_id","membership_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_membership_agreement_unique" ON "maintenance_memberships" USING btree ("organization_id","agreement_id");--> statement-breakpoint
CREATE INDEX "maintenance_membership_customer_idx" ON "maintenance_memberships" USING btree ("organization_id","customer_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_occurrence_cycle_unique" ON "maintenance_occurrences" USING btree ("organization_id","schedule_id","cycle_number");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_occurrence_job_unique" ON "maintenance_occurrences" USING btree ("organization_id","job_id") WHERE "maintenance_occurrences"."job_id" is not null;--> statement-breakpoint
CREATE INDEX "maintenance_occurrence_due_idx" ON "maintenance_occurrences" USING btree ("organization_id","status","due_date");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_plans_org_code_unique" ON "maintenance_plans" USING btree ("organization_id","code");--> statement-breakpoint
CREATE INDEX "maintenance_plans_org_status_idx" ON "maintenance_plans" USING btree ("organization_id","status","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_reminder_milestone_unique" ON "maintenance_reminder_intents" USING btree ("organization_id","agreement_version_id","milestone_days");--> statement-breakpoint
CREATE INDEX "maintenance_reminder_org_idx" ON "maintenance_reminder_intents" USING btree ("organization_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_schedule_membership_unique" ON "maintenance_schedules" USING btree ("organization_id","membership_id");--> statement-breakpoint
CREATE INDEX "maintenance_schedule_due_idx" ON "maintenance_schedules" USING btree ("organization_id","status","next_due_date");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_signature_token_unique" ON "maintenance_signature_requests" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_signature_live_agreement_unique" ON "maintenance_signature_requests" USING btree ("organization_id","agreement_id") WHERE "maintenance_signature_requests"."status"='pending';--> statement-breakpoint
CREATE INDEX "maintenance_signature_agreement_idx" ON "maintenance_signature_requests" USING btree ("organization_id","agreement_id");
