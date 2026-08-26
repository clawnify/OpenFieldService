-- Migration number: 0023 	 2026-08-26T00:00:00.000Z
--
-- FSM upgrade, Phase 15 (Phone Operations Foundation):
--
-- Per docs/PHASE14-ANSWERMACHINE-INTEGRATION-AUDIT.md's approved Option C
-- (hybrid) architecture: OFS remains the sole user-facing system and sole
-- source of truth. A separate, minimal Voice Engine runtime (evolved from
-- the read-only Answermachine reference project, out of this repository)
-- bridges Twilio Media Streams <-> the OpenAI Realtime API and authenticates
-- back to OFS with a per-organization service credential this migration
-- creates storage for (`voice_engine_service_credentials`) — OFS resolves
-- `organization_id` from that credential/from the dialed phone number,
-- never from a value the Voice Engine merely asserts in a request payload
-- (closes the cross-tenant IDOR/confused-deputy risk both the independent
-- Architecture and Security reviews flagged in Phase 14 as the single most
-- consequential finding).
--
-- Every table here is organization-scoped and purely additive — no
-- existing table is altered. `phone_operations_settings.operating_mode`
-- defaults to 'DISABLED' for every organization (including the existing
-- default org, id=1), matching Tax Profile's `tax_enabled=0` precedent: a
-- fresh install or an org that never visits Phone Operations settings sees
-- zero behavior change and cannot receive or place any call.
--
--   * `phone_operations_settings` — versioned/effective-dated exactly like
--     `global_settings`/`tax_profiles` (see src/server/settings.ts,
--     src/server/tax-jurisdiction.ts). A new Save never edits a row in
--     place — see src/server/phone-operations.ts#savePhoneOperationsSettings.
--   * `voice_engine_credentials` — one row per organization holding the
--     Twilio Account SID (not secret) and an AES-256-GCM-encrypted-at-rest
--     Auth Token (src/server/crypto.ts, the same mechanism already used for
--     Google Calendar OAuth tokens) — never stored or logged in plaintext.
--   * `voice_engine_service_credentials` — the token the separate Voice
--     Engine runtime presents to OFS's runtime API. Hashed before storage,
--     exactly like `sessions.token_hash` (src/server/auth.ts) — the raw
--     token is shown to an admin exactly once at creation and never
--     recoverable afterward.
--   * `voice_agents` — versioned/effective-dated like `tax_profiles`; a
--     partial unique index guarantees at most one open-ended default agent
--     per organization at the database level, not just in application code.
--   * `phone_numbers` — one row per provisioned number, optionally bound to
--     a default voice agent.
--   * `calls` / `call_events` / `call_sessions` / `call_transcripts` /
--     `call_outcomes` / `call_transfers` — the Call FSM and its append-only
--     history, mirroring the existing `job_status_history`/`lead_status_history`
--     append-only-audit-table convention. `calls.voice_agent_snapshot` is
--     written once when a call starts and never rewritten afterward — the
--     same snapshot-once historical-immutability discipline
--     `tax_snapshots`/Contract commercial snapshots already use — so a
--     later change to the default agent's prompt/model can never rewrite
--     what an in-flight or completed call was actually run with.
--   * `phone_operations_audit` — a 7th domain-specific audit table after
--     job_status_history/job_rebate_audit/job_compliance_audit/invoice_audit/
--     lead_status_history/job_schedule_history, extending the existing
--     per-domain pattern rather than consolidating (same reasoning Phase 4
--     and Phase 5 already re-affirmed).
--
-- Explicitly out of scope for this migration (Phase 16, not started): no
-- automatic Customer/Lead/Job creation from call data — `call_outcomes`
-- stores the AI-produced structured result for a human to review, and
-- nothing here writes to `customers`/`leads`/`jobs`.

CREATE TABLE IF NOT EXISTS phone_operations_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  operating_mode TEXT NOT NULL DEFAULT 'DISABLED',
  inbound_enabled INTEGER NOT NULL DEFAULT 0,
  outbound_enabled INTEGER NOT NULL DEFAULT 0,
  max_concurrent_calls INTEGER NOT NULL DEFAULT 1,
  daily_call_cap INTEGER NOT NULL DEFAULT 0,
  effective_from TEXT NOT NULL DEFAULT (datetime('now')),
  effective_until TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_phone_operations_settings_org_effective ON phone_operations_settings(organization_id, effective_from);

CREATE TABLE IF NOT EXISTS voice_engine_credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'twilio',
  account_sid TEXT NOT NULL,
  auth_token_encrypted TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS voice_engine_service_credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT,
  last_used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_voice_engine_service_credentials_org ON voice_engine_service_credentials(organization_id);

CREATE TABLE IF NOT EXISTS voice_agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'en',
  voice TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft',
  effective_from TEXT NOT NULL DEFAULT (datetime('now')),
  effective_until TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_voice_agents_org_effective ON voice_agents(organization_id, effective_from);
CREATE UNIQUE INDEX IF NOT EXISTS idx_voice_agents_one_open_default ON voice_agents(organization_id) WHERE is_default = 1 AND effective_until IS NULL;

CREATE TABLE IF NOT EXISTS phone_numbers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  e164_number TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL DEFAULT 'twilio',
  provider_number_sid TEXT NOT NULL DEFAULT '',
  voice_agent_id INTEGER REFERENCES voice_agents(id) ON DELETE SET NULL,
  inbound_enabled INTEGER NOT NULL DEFAULT 1,
  outbound_enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_phone_numbers_org ON phone_numbers(organization_id);

CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  direction TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  provider_call_sid TEXT UNIQUE,
  phone_number_id INTEGER REFERENCES phone_numbers(id) ON DELETE SET NULL,
  from_number TEXT NOT NULL,
  to_number TEXT NOT NULL,
  voice_agent_id INTEGER REFERENCES voice_agents(id) ON DELETE SET NULL,
  voice_agent_snapshot TEXT NOT NULL DEFAULT '{}',
  initiated_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  started_at TEXT,
  answered_at TEXT,
  ended_at TEXT,
  end_reason TEXT NOT NULL DEFAULT '',
  duration_seconds INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_calls_org_created ON calls(organization_id, created_at);
CREATE INDEX IF NOT EXISTS idx_calls_phone_number ON calls(phone_number_id);

CREATE TABLE IF NOT EXISTS call_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id INTEGER NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  actor_type TEXT NOT NULL,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  idempotency_key TEXT,
  details TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_call_events_call ON call_events(call_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_call_events_idempotency ON call_events(call_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS call_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id INTEGER NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  session_token_hash TEXT NOT NULL UNIQUE,
  issued_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  connected_at TEXT,
  disconnected_at TEXT,
  disconnect_reason TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_call_sessions_call ON call_sessions(call_id);

CREATE TABLE IF NOT EXISTS call_transcripts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id INTEGER NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  speaker TEXT NOT NULL,
  text TEXT NOT NULL,
  confidence REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_call_transcripts_call_sequence ON call_transcripts(call_id, sequence);

CREATE TABLE IF NOT EXISTS call_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id INTEGER NOT NULL UNIQUE REFERENCES calls(id) ON DELETE CASCADE,
  outcome_type TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  structured_data TEXT NOT NULL DEFAULT '{}',
  confidence REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS call_transfers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id INTEGER NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  requested_by TEXT NOT NULL,
  target_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  target_phone_number TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'requested',
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_call_transfers_call ON call_transfers(call_id);

CREATE TABLE IF NOT EXISTS phone_operations_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  actor_type TEXT NOT NULL,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  details TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_phone_operations_audit_org ON phone_operations_audit(organization_id, created_at);
