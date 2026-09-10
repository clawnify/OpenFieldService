CREATE UNIQUE INDEX IF NOT EXISTS "voice_agents_org_id_uq" ON "voice_agents" USING btree ("organization_id","id");
