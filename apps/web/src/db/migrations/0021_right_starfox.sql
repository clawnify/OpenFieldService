CREATE TYPE "public"."retention_campaign_channel" AS ENUM('email', 'sms', 'both');--> statement-breakpoint
CREATE TYPE "public"."retention_campaign_status" AS ENUM('draft', 'scheduled', 'running', 'paused', 'completed', 'cancelled', 'failed');--> statement-breakpoint
CREATE TYPE "public"."retention_credit_status" AS ENUM('issued', 'voided', 'redeemed');--> statement-breakpoint
CREATE TYPE "public"."retention_follow_up_status" AS ENUM('pending', 'sent', 'satisfied', 'needs_attention', 'closed', 'failed', 'suppressed');--> statement-breakpoint
CREATE TYPE "public"."retention_recipient_status" AS ENUM('queued', 'pending', 'suppressed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."retention_referral_status" AS ENUM('pending', 'qualified', 'rewarded', 'expired', 'rejected');--> statement-breakpoint
CREATE TABLE "campaign_recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"status" "retention_recipient_status" DEFAULT 'queued' NOT NULL,
	"outbox_id" uuid,
	"suppression_reason" text,
	"recipient_snapshot" jsonb NOT NULL,
	"finalized_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"campaign_type" text DEFAULT 'seasonal' NOT NULL,
	"status" "retention_campaign_status" DEFAULT 'draft' NOT NULL,
	"channel" "retention_campaign_channel" DEFAULT 'email' NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"cta_link" text DEFAULT '' NOT NULL,
	"audience_filter" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"scheduled_for" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_schedule_valid" CHECK ("campaigns"."status"='draft' or "campaigns"."scheduled_for" is not null or "campaigns"."status" in ('cancelled','failed'))
);
--> statement-breakpoint
CREATE TABLE "customer_credit_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid,
	"amount_cents" bigint,
	"value_description" text DEFAULT '' NOT NULL,
	"status" "retention_credit_status" DEFAULT 'issued' NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"redeemed_at" timestamp with time zone,
	"redeemed_reason" text,
	"actor_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_credit_amount_valid" CHECK ("customer_credit_ledger"."amount_cents" is null or "customer_credit_ledger"."amount_cents">0)
);
--> statement-breakpoint
CREATE TABLE "customer_referrals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"referrer_customer_id" uuid NOT NULL,
	"referred_customer_id" uuid,
	"referred_lead_id" uuid,
	"referral_code" text NOT NULL,
	"status" "retention_referral_status" DEFAULT 'pending' NOT NULL,
	"qualifying_job_id" uuid,
	"qualifying_invoice_id" uuid,
	"qualified_at" timestamp with time zone,
	"rejected_reason" text DEFAULT '' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"event_type" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"dedupe_key" text NOT NULL,
	"recipient_snapshot" jsonb NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_outbox_state_valid" CHECK ("notification_outbox"."status" in ('pending','processing','delivered','failed','cancelled') and "notification_outbox"."attempt_count">=0)
);
--> statement-breakpoint
CREATE TABLE "referral_programs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"reward_type" text DEFAULT 'account_credit' NOT NULL,
	"reward_value_cents" bigint,
	"reward_description" text DEFAULT '' NOT NULL,
	"qualification_rule" text DEFAULT 'first_completed_job' NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referral_program_reward_valid" CHECK ("referral_programs"."reward_value_cents" is null or "referral_programs"."reward_value_cents">=0)
);
--> statement-breakpoint
CREATE TABLE "retention_automation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"triggered_by" text NOT NULL,
	"actor_user_id" uuid,
	"follow_ups_created" integer DEFAULT 0 NOT NULL,
	"referrals_qualified" integer DEFAULT 0 NOT NULL,
	"rewards_issued" integer DEFAULT 0 NOT NULL,
	"campaigns_executed" integer DEFAULT 0 NOT NULL,
	"recipients_finalized" integer DEFAULT 0 NOT NULL,
	"errored_count" integer DEFAULT 0 NOT NULL,
	"error_summary" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "retention_follow_ups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"status" "retention_follow_up_status" DEFAULT 'pending' NOT NULL,
	"due_date" date NOT NULL,
	"sent_at" timestamp with time zone,
	"response_notes" text DEFAULT '' NOT NULL,
	"responded_at" timestamp with time zone,
	"review_eligible" boolean DEFAULT false NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "retention_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"marketing_email_opt_in" boolean DEFAULT false NOT NULL,
	"marketing_sms_opt_in" boolean DEFAULT false NOT NULL,
	"marketing_email_consent_at" timestamp with time zone,
	"marketing_email_consent_source" text,
	"marketing_sms_consent_at" timestamp with time zone,
	"marketing_sms_consent_source" text,
	"do_not_contact" boolean DEFAULT false NOT NULL,
	"unsubscribed_at" timestamp with time zone,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retention_preferences_consent_valid" CHECK ((("retention_preferences"."marketing_email_opt_in"=false) or ("retention_preferences"."marketing_email_consent_at" is not null and length(trim("retention_preferences"."marketing_email_consent_source"))>0)) and (("retention_preferences"."marketing_sms_opt_in"=false) or ("retention_preferences"."marketing_sms_consent_at" is not null and length(trim("retention_preferences"."marketing_sms_consent_source"))>0)))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "campaigns_org_id_unique" ON "campaigns" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_outbox_org_id_unique" ON "notification_outbox" USING btree ("organization_id","id");--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipient_campaign_tenant_fk" FOREIGN KEY ("organization_id","campaign_id") REFERENCES "public"."campaigns"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipient_customer_tenant_fk" FOREIGN KEY ("organization_id","customer_id") REFERENCES "public"."customers"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipient_outbox_tenant_fk" FOREIGN KEY ("organization_id","outbox_id") REFERENCES "public"."notification_outbox"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_credit_ledger" ADD CONSTRAINT "customer_credit_ledger_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_credit_ledger" ADD CONSTRAINT "customer_credit_ledger_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_credit_ledger" ADD CONSTRAINT "customer_credit_customer_tenant_fk" FOREIGN KEY ("organization_id","customer_id") REFERENCES "public"."customers"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_referrals" ADD CONSTRAINT "customer_referrals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_referrals" ADD CONSTRAINT "customer_referrals_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_referrals" ADD CONSTRAINT "customer_referral_referrer_tenant_fk" FOREIGN KEY ("organization_id","referrer_customer_id") REFERENCES "public"."customers"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_referrals" ADD CONSTRAINT "customer_referral_referred_customer_tenant_fk" FOREIGN KEY ("organization_id","referred_customer_id") REFERENCES "public"."customers"("organization_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_referrals" ADD CONSTRAINT "customer_referral_lead_tenant_fk" FOREIGN KEY ("organization_id","referred_lead_id") REFERENCES "public"."leads"("organization_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_referrals" ADD CONSTRAINT "customer_referral_job_tenant_fk" FOREIGN KEY ("organization_id","qualifying_job_id") REFERENCES "public"."jobs"("organization_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_referrals" ADD CONSTRAINT "customer_referral_invoice_tenant_fk" FOREIGN KEY ("organization_id","qualifying_invoice_id") REFERENCES "public"."invoices"("organization_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_customer_tenant_fk" FOREIGN KEY ("organization_id","customer_id") REFERENCES "public"."customers"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_programs" ADD CONSTRAINT "referral_programs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_programs" ADD CONSTRAINT "referral_programs_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_automation_runs" ADD CONSTRAINT "retention_automation_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_automation_runs" ADD CONSTRAINT "retention_automation_runs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_follow_ups" ADD CONSTRAINT "retention_follow_ups_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_follow_ups" ADD CONSTRAINT "retention_follow_ups_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_follow_ups" ADD CONSTRAINT "retention_follow_up_job_tenant_fk" FOREIGN KEY ("organization_id","job_id") REFERENCES "public"."jobs"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_follow_ups" ADD CONSTRAINT "retention_follow_up_customer_tenant_fk" FOREIGN KEY ("organization_id","customer_id") REFERENCES "public"."customers"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_preferences" ADD CONSTRAINT "retention_preferences_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_preferences" ADD CONSTRAINT "retention_preferences_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_preferences" ADD CONSTRAINT "retention_preferences_customer_tenant_fk" FOREIGN KEY ("organization_id","customer_id") REFERENCES "public"."customers"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_recipient_unique" ON "campaign_recipients" USING btree ("organization_id","campaign_id","customer_id","channel");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_recipient_org_id_unique" ON "campaign_recipients" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "campaign_recipient_status_idx" ON "campaign_recipients" USING btree ("organization_id","campaign_id","status");--> statement-breakpoint
CREATE INDEX "campaigns_due_idx" ON "campaigns" USING btree ("organization_id","status","scheduled_for");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_credit_org_id_unique" ON "customer_credit_ledger" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_credit_source_unique" ON "customer_credit_ledger" USING btree ("organization_id","source_type","source_id") WHERE "customer_credit_ledger"."source_id" is not null;--> statement-breakpoint
CREATE INDEX "customer_credit_balance_idx" ON "customer_credit_ledger" USING btree ("organization_id","customer_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_referrals_org_id_unique" ON "customer_referrals" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_referral_code_unique" ON "customer_referrals" USING btree ("referral_code");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_referral_referred_customer_unique" ON "customer_referrals" USING btree ("organization_id","referred_customer_id") WHERE "customer_referrals"."referred_customer_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_referral_referred_lead_unique" ON "customer_referrals" USING btree ("organization_id","referred_lead_id") WHERE "customer_referrals"."referred_lead_id" is not null;--> statement-breakpoint
CREATE INDEX "customer_referrals_status_idx" ON "customer_referrals" USING btree ("organization_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_outbox_dedupe_unique" ON "notification_outbox" USING btree ("organization_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "notification_outbox_pending_idx" ON "notification_outbox" USING btree ("organization_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "referral_program_org_unique" ON "referral_programs" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "referral_program_org_id_unique" ON "referral_programs" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "retention_automation_runs_idx" ON "retention_automation_runs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "retention_follow_up_job_unique" ON "retention_follow_ups" USING btree ("organization_id","job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "retention_follow_up_org_id_unique" ON "retention_follow_ups" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "retention_follow_up_due_idx" ON "retention_follow_ups" USING btree ("organization_id","status","due_date");--> statement-breakpoint
CREATE UNIQUE INDEX "retention_preferences_customer_unique" ON "retention_preferences" USING btree ("organization_id","customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "retention_preferences_org_id_unique" ON "retention_preferences" USING btree ("organization_id","id");
