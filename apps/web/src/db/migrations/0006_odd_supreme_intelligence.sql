CREATE TYPE "public"."attachment_target_type" AS ENUM('customer', 'contact', 'company', 'lead', 'deal', 'note');--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"target_type" "attachment_target_type" NOT NULL,
	"target_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"storage_deleted_at" timestamp with time zone,
	CONSTRAINT "attachments_size_positive" CHECK ("attachments"."size_bytes" > 0 and "attachments"."size_bytes" <= 15728640),
	CONSTRAINT "attachments_sha256_format" CHECK ("attachments"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "attachments_storage_delete_requires_archive" CHECK ("attachments"."storage_deleted_at" is null or "attachments"."archived_at" is not null)
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_archived_by_users_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploader_tenant_fk" FOREIGN KEY ("organization_id","uploaded_by") REFERENCES "public"."organization_members"("organization_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attachments_organization_id_unique" ON "attachments" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "attachments_object_key_unique" ON "attachments" USING btree ("object_key");--> statement-breakpoint
CREATE INDEX "attachments_organization_target_idx" ON "attachments" USING btree ("organization_id","target_type","target_id","created_at");
