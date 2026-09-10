ALTER TABLE "phone_calls" ADD COLUMN "client_request_id" text;--> statement-breakpoint
ALTER TABLE "phone_calls" ADD CONSTRAINT "phone_calls_client_request_id_unique" UNIQUE("client_request_id");