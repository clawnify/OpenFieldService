-- Migration number: 0024 	 2026-08-26T00:00:00.000Z
--
-- FSM upgrade, Phase 16 (Phone Operations <-> CRM / Customers / Leads /
-- Scheduler / Jobs):
--
-- Purely additive — no existing table's meaning changes, no data is
-- rewritten. Adds the linkage a call can have to the existing Customer/
-- Lead/Job source-of-truth tables (never a second CRM), a tool-invocation
-- audit/idempotency table for the new runtime tool-call surface, and a
-- follow-up/task mechanism (grepped first — no such table existed anywhere
-- in this codebase; `notification_outbox` is a delivery-send queue, not a
-- task list, so this is genuinely new, not a duplicate of something
-- already there).
--
--   * `calls.customer_id` / `.lead_id` / `.job_id` — nullable, SET NULL,
--     same "loose attribution reference, not composition" precedent as
--     `customers.referred_by_customer_id` (migration 0008): deleting the
--     linked Customer/Lead/Job must never delete the call record itself.
--     All three may be set independently (e.g. a call about an existing
--     Job might also later create a follow-up unrelated to any Lead) —
--     deliberately not mutually exclusive, no CHECK constraint forcing
--     "exactly one".
--   * `calls.match_confidence` / `.match_source` — records HOW a
--     customer_id link was established (`EXACT_PHONE` = automatic
--     normalized-phone match against `customers`, same mechanism
--     `lead-conversion.ts#findMatchingCustomerIds` already uses; `MANUAL` =
--     a dispatcher/admin corrected or set the link by hand; `UNKNOWN` =
--     no link, or a link whose provenance predates this column) — Section
--     45's explicit "no opaque AI decided this is the customer" requirement.
--     `match_source` is `'system'` for an automatic match or `'user:<id>'`
--     for a manual one, mirroring every other actor-provenance column in
--     this schema (never a bare unattributed change).
--   * `voice_agents.tool_policy` — a JSON array of allowed tool names for
--     that SPECIFIC agent VERSION (versioned exactly like every other
--     `voice_agents` column, per Section 28's explicit requirement that a
--     later permission change must never rewrite an already-run call's
--     historical policy). Defaults to `'[]']` (no tools) — every
--     pre-Phase-16 agent version retroactively reads as "had zero tool
--     capability", which is the truthful historical fact: no tool
--     mechanism existed before this migration.
--   * `call_follow_ups` — a task an admin/dispatcher (or, low-risk-write,
--     the Voice Engine itself) creates for a human to act on later ("call
--     back tomorrow", "send a quote"). References Call and, optionally,
--     whichever of Customer/Lead/Job it's actually about.
--   * `call_tool_invocations` — the audit trail AND idempotency guard for
--     every tool the runtime API executes on behalf of a call (Sections
--     35/37/53/58): `idempotency_key` is caller-supplied (from the Voice
--     Engine, matching `call_events.idempotency_key`'s existing pattern) so
--     a retried/duplicated tool call resolves to the ALREADY-COMPUTED
--     result rather than re-executing a side effect a second time.

ALTER TABLE calls ADD COLUMN customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL;
ALTER TABLE calls ADD COLUMN lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL;
ALTER TABLE calls ADD COLUMN job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL;
ALTER TABLE calls ADD COLUMN match_confidence TEXT NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE calls ADD COLUMN match_source TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_calls_customer ON calls(customer_id);
CREATE INDEX IF NOT EXISTS idx_calls_lead ON calls(lead_id);
CREATE INDEX IF NOT EXISTS idx_calls_job ON calls(job_id);

ALTER TABLE voice_agents ADD COLUMN tool_policy TEXT NOT NULL DEFAULT '[]';

CREATE TABLE IF NOT EXISTS call_follow_ups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  call_id INTEGER NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  assigned_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  due_date TEXT,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  created_by_type TEXT NOT NULL,
  created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_call_follow_ups_org ON call_follow_ups(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_call_follow_ups_call ON call_follow_ups(call_id);

CREATE TABLE IF NOT EXISTS call_tool_invocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  call_id INTEGER NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  risk_category TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  input_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_call_tool_invocations_idempotency ON call_tool_invocations(call_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_call_tool_invocations_call ON call_tool_invocations(call_id);
