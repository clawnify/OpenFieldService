CREATE TYPE "public"."phone_call_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "public"."phone_call_status" AS ENUM('queued', 'ringing', 'in_progress', 'completed', 'failed', 'no_answer', 'busy', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."phone_invocation_status" AS ENUM('pending', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."phone_match_confidence" AS ENUM('unknown', 'exact_phone', 'manual');--> statement-breakpoint
CREATE TYPE "public"."phone_number_status" AS ENUM('active', 'inactive');--> statement-breakpoint
CREATE TYPE "public"."phone_operating_mode" AS ENUM('active', 'paused', 'maintenance', 'disabled', 'emergency_stop');--> statement-breakpoint
CREATE TABLE "phone_call_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"call_id" uuid NOT NULL,
	"provider_event_id" text NOT NULL,
	"provider_status" text NOT NULL,
	"mapped_status" "phone_call_status" NOT NULL,
	"provider_occurred_at" timestamp with time zone NOT NULL,
	"accepted" boolean NOT NULL,
	"rejection_reason" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "phone_call_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"call_id" uuid NOT NULL,
	"summary" text NOT NULL,
	"disposition" text NOT NULL,
	"captured_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "phone_call_task_links" (
	"organization_id" uuid NOT NULL,
	"call_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "phone_call_transcripts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"call_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"speaker" text NOT NULL,
	"content" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "phone_transcripts_sequence_nonnegative" CHECK ("phone_call_transcripts"."sequence" >= 0)
);
--> statement-breakpoint
CREATE TABLE "phone_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" text DEFAULT 'twilio' NOT NULL,
	"provider_call_id" text NOT NULL,
	"direction" "phone_call_direction" NOT NULL,
	"status" "phone_call_status" DEFAULT 'queued' NOT NULL,
	"phone_number_id" uuid NOT NULL,
	"normalized_from" text NOT NULL,
	"normalized_to" text NOT NULL,
	"customer_id" uuid,
	"lead_id" uuid,
	"job_id" uuid,
	"match_confidence" "phone_match_confidence" DEFAULT 'unknown' NOT NULL,
	"match_source" text NOT NULL,
	"assigned_user_id" uuid,
	"disposition" text,
	"notes" text,
	"agent_snapshot" jsonb,
	"started_at" timestamp with time zone,
	"answered_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "phone_calls_one_crm_subject" CHECK (num_nonnulls("phone_calls"."customer_id", "phone_calls"."lead_id") <= 1)
);
--> statement-breakpoint
CREATE TABLE "phone_numbers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" text DEFAULT 'twilio' NOT NULL,
	"provider_number_id" text NOT NULL,
	"e164" text NOT NULL,
	"label" text,
	"status" "phone_number_status" DEFAULT 'active' NOT NULL,
	"inbound_enabled" boolean DEFAULT true NOT NULL,
	"outbound_enabled" boolean DEFAULT true NOT NULL,
	"voice_agent_id" uuid,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "phone_numbers_e164_check" CHECK ("phone_numbers"."e164" ~ '^\+[1-9][0-9]{7,14}$')
);
--> statement-breakpoint
CREATE TABLE "phone_operation_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"operating_mode" "phone_operating_mode" DEFAULT 'disabled' NOT NULL,
	"inbound_enabled" boolean DEFAULT false NOT NULL,
	"outbound_enabled" boolean DEFAULT false NOT NULL,
	"max_concurrent_calls" integer DEFAULT 1 NOT NULL,
	"daily_call_cap" integer DEFAULT 25 NOT NULL,
	"voice_runtime_url" text,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_until" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "phone_settings_caps_positive" CHECK ("phone_operation_settings"."max_concurrent_calls" > 0 and "phone_operation_settings"."daily_call_cap" > 0)
);
--> statement-breakpoint
CREATE TABLE "phone_provider_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" text DEFAULT 'twilio' NOT NULL,
	"account_sid" text NOT NULL,
	"auth_token_ciphertext" text NOT NULL,
	"auth_token_iv" text NOT NULL,
	"auth_token_tag" text NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "phone_runtime_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "phone_tool_invocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"call_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"tool_name" text NOT NULL,
	"payload_hash" text NOT NULL,
	"status" "phone_invocation_status" DEFAULT 'pending' NOT NULL,
	"result" jsonb,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "voice_agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"logical_name" text NOT NULL,
	"version" integer NOT NULL,
	"status" "phone_number_status" DEFAULT 'active' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"prompt" text NOT NULL,
	"voice" text NOT NULL,
	"tool_policy" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_until" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "phone_calls_org_id_uq" ON "phone_calls" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "phone_numbers_org_id_uq" ON "phone_numbers" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "voice_agents_org_id_uq" ON "voice_agents" USING btree ("organization_id","id");--> statement-breakpoint
ALTER TABLE "phone_call_events" ADD CONSTRAINT "phone_call_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_call_events" ADD CONSTRAINT "phone_call_events_call_tenant_fk" FOREIGN KEY ("organization_id","call_id") REFERENCES "public"."phone_calls"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_call_outcomes" ADD CONSTRAINT "phone_call_outcomes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_call_outcomes" ADD CONSTRAINT "phone_outcomes_call_tenant_fk" FOREIGN KEY ("organization_id","call_id") REFERENCES "public"."phone_calls"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_call_task_links" ADD CONSTRAINT "phone_call_task_links_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_call_task_links" ADD CONSTRAINT "phone_call_task_links_call_tenant_fk" FOREIGN KEY ("organization_id","call_id") REFERENCES "public"."phone_calls"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_call_task_links" ADD CONSTRAINT "phone_call_task_links_task_tenant_fk" FOREIGN KEY ("organization_id","task_id") REFERENCES "public"."tasks"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_call_transcripts" ADD CONSTRAINT "phone_call_transcripts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_call_transcripts" ADD CONSTRAINT "phone_transcripts_call_tenant_fk" FOREIGN KEY ("organization_id","call_id") REFERENCES "public"."phone_calls"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_calls" ADD CONSTRAINT "phone_calls_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_calls" ADD CONSTRAINT "phone_calls_number_tenant_fk" FOREIGN KEY ("organization_id","phone_number_id") REFERENCES "public"."phone_numbers"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_calls" ADD CONSTRAINT "phone_calls_customer_tenant_fk" FOREIGN KEY ("organization_id","customer_id") REFERENCES "public"."customers"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_calls" ADD CONSTRAINT "phone_calls_lead_tenant_fk" FOREIGN KEY ("organization_id","lead_id") REFERENCES "public"."leads"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_calls" ADD CONSTRAINT "phone_calls_job_tenant_fk" FOREIGN KEY ("organization_id","job_id") REFERENCES "public"."jobs"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_calls" ADD CONSTRAINT "phone_calls_assignee_tenant_fk" FOREIGN KEY ("organization_id","assigned_user_id") REFERENCES "public"."organization_members"("organization_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_numbers" ADD CONSTRAINT "phone_numbers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_numbers" ADD CONSTRAINT "phone_numbers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_numbers" ADD CONSTRAINT "phone_numbers_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_numbers" ADD CONSTRAINT "phone_numbers_agent_tenant_fk" FOREIGN KEY ("organization_id","voice_agent_id") REFERENCES "public"."voice_agents"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_operation_settings" ADD CONSTRAINT "phone_operation_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_operation_settings" ADD CONSTRAINT "phone_operation_settings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_provider_credentials" ADD CONSTRAINT "phone_provider_credentials_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_provider_credentials" ADD CONSTRAINT "phone_provider_credentials_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_runtime_credentials" ADD CONSTRAINT "phone_runtime_credentials_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_runtime_credentials" ADD CONSTRAINT "phone_runtime_credentials_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_tool_invocations" ADD CONSTRAINT "phone_tool_invocations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_tool_invocations" ADD CONSTRAINT "phone_tool_invocations_call_tenant_fk" FOREIGN KEY ("organization_id","call_id") REFERENCES "public"."phone_calls"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_agents" ADD CONSTRAINT "voice_agents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_agents" ADD CONSTRAINT "voice_agents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "phone_call_events_provider_uq" ON "phone_call_events" USING btree ("organization_id","provider_event_id");--> statement-breakpoint
CREATE INDEX "phone_call_events_call_idx" ON "phone_call_events" USING btree ("organization_id","call_id","provider_occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "phone_outcomes_call_uq" ON "phone_call_outcomes" USING btree ("organization_id","call_id");--> statement-breakpoint
CREATE UNIQUE INDEX "phone_call_task_links_task_uq" ON "phone_call_task_links" USING btree ("organization_id","task_id");--> statement-breakpoint
CREATE INDEX "phone_call_task_links_call_idx" ON "phone_call_task_links" USING btree ("organization_id","call_id");--> statement-breakpoint
CREATE UNIQUE INDEX "phone_transcripts_call_sequence_uq" ON "phone_call_transcripts" USING btree ("organization_id","call_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "phone_calls_provider_identity_uq" ON "phone_calls" USING btree ("provider","provider_call_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "phone_calls_org_id_uq" ON "phone_calls" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "phone_calls_org_created_idx" ON "phone_calls" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "phone_calls_org_status_idx" ON "phone_calls" USING btree ("organization_id","status","created_at");--> statement-breakpoint
CREATE INDEX "phone_calls_org_from_idx" ON "phone_calls" USING btree ("organization_id","normalized_from");--> statement-breakpoint
CREATE UNIQUE INDEX "phone_numbers_provider_e164_uq" ON "phone_numbers" USING btree ("provider","e164");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "phone_numbers_org_id_uq" ON "phone_numbers" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "phone_numbers_org_status_idx" ON "phone_numbers" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "phone_settings_org_version_uq" ON "phone_operation_settings" USING btree ("organization_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "phone_settings_one_current_uq" ON "phone_operation_settings" USING btree ("organization_id") WHERE "phone_operation_settings"."effective_until" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "phone_provider_credentials_org_provider_uq" ON "phone_provider_credentials" USING btree ("organization_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "phone_runtime_token_hash_uq" ON "phone_runtime_credentials" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "phone_runtime_org_idx" ON "phone_runtime_credentials" USING btree ("organization_id","revoked_at");--> statement-breakpoint
CREATE UNIQUE INDEX "phone_tool_invocations_key_uq" ON "phone_tool_invocations" USING btree ("organization_id","call_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "voice_agents_org_name_version_uq" ON "voice_agents" USING btree ("organization_id","logical_name","version");--> statement-breakpoint
CREATE INDEX "voice_agents_current_idx" ON "voice_agents" USING btree ("organization_id","logical_name","effective_until");
