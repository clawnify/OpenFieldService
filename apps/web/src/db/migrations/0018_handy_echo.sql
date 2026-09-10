CREATE UNIQUE INDEX IF NOT EXISTS "maintenance_occurrences_org_id_unique" ON "maintenance_occurrences" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "maintenance_reminders_org_id_unique" ON "maintenance_reminder_intents" USING btree ("organization_id","id");
