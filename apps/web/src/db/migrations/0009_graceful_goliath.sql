ALTER TABLE "quote_options" ADD COLUMN "discount_type" "discount_type" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "quote_options" ADD COLUMN "discount_basis_points" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "quote_options" ADD COLUMN "discount_input_cents" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "quote_options" ADD COLUMN "tax_basis_points" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "quote_options" ADD CONSTRAINT "quote_option_rates_valid" CHECK ("quote_options"."discount_basis_points" between 0 and 10000 and "quote_options"."tax_basis_points" between 0 and 10000);