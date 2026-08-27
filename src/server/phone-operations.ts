import { get, query, run } from "./db.js";
import { decryptSecret, encryptSecret } from "./crypto.js";

/** Phase 15 — Phone Operations Foundation.
 *
 *  Per docs/PHASE14-ANSWERMACHINE-INTEGRATION-AUDIT.md's approved Option C
 *  architecture: OFS owns every business fact (settings, agents, numbers,
 *  calls, transcripts, outcomes) and is the ONLY system a human ever looks
 *  at. A separate, minimal Voice Engine runtime (out of this repository,
 *  evolved from the read-only Answermachine reference) bridges Twilio Media
 *  Streams <-> the OpenAI Realtime API and talks to OFS only through the
 *  `runtime*` functions below, authenticated by a per-organization service
 *  credential OFS itself issues (see `resolveVoiceEngineServiceCredential`)
 *  — OFS resolves `organization_id` server-side from that credential or
 *  from the dialed phone number, NEVER from a value the caller merely
 *  asserts in a request payload. This is this module's central invariant;
 *  every exported function that accepts an `organizationId` expects it to
 *  already be resolved this way by its caller, not read from client input.
 *
 *  This is a FOUNDATION: no automatic Customer/Lead/Job creation happens
 *  here (Phase 16, not started), and no AI tool is given write access to
 *  anything — `recordCallOutcome` stores a structured result for a human to
 *  review, nothing more. */

/** Config surfaces (settings, credentials, agents, numbers) are admin-only
 *  in both directions, matching tax-jurisdiction.ts's stricter-than-
 *  canManageFinancials precedent. Call operational data (list/detail/
 *  transcript/outcome/initiating an outbound call) is admin+dispatcher,
 *  matching the notification-history/financial visibility precedent. A
 *  technician has no legitimate use for either surface (Phase 14 audit
 *  finding: calls are not job-scoped field work) and is blocked from all
 *  of it, same as the full financial blackout in financial.ts. */
export function canManagePhoneOperations(role: string): boolean {
  return role === "admin";
}

export function canViewPhoneOperationsCalls(role: string): boolean {
  return role === "admin" || role === "dispatcher";
}

export class PhoneOperationsError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PhoneOperationsError";
    this.code = code;
  }
}

// ── Crypto helpers (mirrors src/server/auth.ts's session-token idiom —
// intentionally duplicated rather than imported, since auth.ts does not
// export it and this is a well-understood 6-line primitive, not a shared
// abstraction worth coupling two modules over) ─────────────────────────

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function generateOpaqueToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

async function hashOpaqueToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return toBase64Url(new Uint8Array(digest));
}

// ── Phone Operations Settings (versioned/effective-dated, mirrors
// settings.ts#getSettingRow/publishSetting and tax-jurisdiction.ts) ─────

export type OperatingMode = "ACTIVE" | "PAUSED" | "MAINTENANCE" | "DISABLED" | "EMERGENCY_STOP";
const OPERATING_MODES: OperatingMode[] = ["ACTIVE", "PAUSED", "MAINTENANCE", "DISABLED", "EMERGENCY_STOP"];

export interface PhoneOperationsSettings {
  id: number;
  organization_id: number;
  operating_mode: OperatingMode;
  inbound_enabled: boolean;
  outbound_enabled: boolean;
  max_concurrent_calls: number;
  daily_call_cap: number;
  effective_from: string;
  effective_until: string | null;
  created_by: number | null;
  created_at: string;
  configured: boolean;
}

interface PhoneOperationsSettingsRow {
  id: number;
  organization_id: number;
  operating_mode: string;
  inbound_enabled: number;
  outbound_enabled: number;
  max_concurrent_calls: number;
  daily_call_cap: number;
  effective_from: string;
  effective_until: string | null;
  created_by: number | null;
  created_at: string;
}

function toSettings(row: PhoneOperationsSettingsRow): PhoneOperationsSettings {
  return {
    id: row.id,
    organization_id: row.organization_id,
    operating_mode: row.operating_mode as OperatingMode,
    inbound_enabled: !!row.inbound_enabled,
    outbound_enabled: !!row.outbound_enabled,
    max_concurrent_calls: row.max_concurrent_calls,
    daily_call_cap: row.daily_call_cap,
    effective_from: row.effective_from,
    effective_until: row.effective_until,
    created_by: row.created_by,
    created_at: row.created_at,
    configured: true,
  };
}

/** The safe, zero-configuration default: no inbound, no outbound, DISABLED.
 *  Never a network/database call — used whenever an organization has never
 *  saved Phone Operations settings, so every gating check below has a
 *  concrete value to compare against without a null-check at every call
 *  site. `configured: false` lets the settings UI distinguish "never set
 *  up" from "explicitly disabled." */
function defaultSettings(organizationId: number): PhoneOperationsSettings {
  return {
    id: 0,
    organization_id: organizationId,
    operating_mode: "DISABLED",
    inbound_enabled: false,
    outbound_enabled: false,
    max_concurrent_calls: 1,
    daily_call_cap: 0,
    effective_from: new Date(0).toISOString(),
    effective_until: null,
    created_by: null,
    created_at: new Date(0).toISOString(),
    configured: false,
  };
}

export async function resolvePhoneOperationsSettings(organizationId: number, asOf?: string): Promise<PhoneOperationsSettings> {
  const at = asOf ?? new Date().toISOString();
  const row = await get<PhoneOperationsSettingsRow>(
    `SELECT * FROM phone_operations_settings
     WHERE organization_id = ? AND effective_from <= ?
       AND (effective_until IS NULL OR effective_until > ?)
     ORDER BY effective_from DESC LIMIT 1`,
    [organizationId, at, at]
  );
  return row ? toSettings(row) : defaultSettings(organizationId);
}

export async function getPhoneOperationsSettingsHistory(organizationId: number): Promise<PhoneOperationsSettings[]> {
  const rows = await query<PhoneOperationsSettingsRow>(
    "SELECT * FROM phone_operations_settings WHERE organization_id = ? ORDER BY effective_from DESC", [organizationId]
  );
  return rows.map(toSettings);
}

export interface SavePhoneOperationsSettingsInput {
  organizationId: number;
  operating_mode: string;
  inbound_enabled: boolean;
  outbound_enabled: boolean;
  max_concurrent_calls: number;
  daily_call_cap: number;
  effectiveFrom?: string;
  actorId: number;
}

/** Publishes a new settings version. Never mutates a past version — closes
 *  the currently-open row's `effective_until` and inserts a fresh one, same
 *  non-destructive discipline as settings.ts#publishSetting /
 *  tax-jurisdiction.ts#saveTaxProfile. A call already in progress keeps
 *  whatever `voice_agent_snapshot` it captured at start regardless of this
 *  change (see `createInboundCall`/`createOutboundCall` below) — this
 *  function only ever affects NEW calls placed/answered after it runs. */
export async function savePhoneOperationsSettings(input: SavePhoneOperationsSettingsInput): Promise<PhoneOperationsSettings> {
  if (!OPERATING_MODES.includes(input.operating_mode as OperatingMode)) {
    throw new PhoneOperationsError("invalid_mode", `operating_mode must be one of ${OPERATING_MODES.join(", ")}`);
  }
  if (!Number.isInteger(input.max_concurrent_calls) || input.max_concurrent_calls < 1) {
    throw new PhoneOperationsError("invalid_max_concurrent_calls", "max_concurrent_calls must be a positive integer");
  }
  if (!Number.isInteger(input.daily_call_cap) || input.daily_call_cap < 0) {
    throw new PhoneOperationsError("invalid_daily_call_cap", "daily_call_cap must be a non-negative integer");
  }
  const effectiveFrom = input.effectiveFrom ?? new Date().toISOString();
  const latest = await get<PhoneOperationsSettingsRow>(
    "SELECT * FROM phone_operations_settings WHERE organization_id = ? ORDER BY effective_from DESC LIMIT 1",
    [input.organizationId]
  );
  if (latest && effectiveFrom <= latest.effective_from) {
    throw new PhoneOperationsError("invalid_effective_from", `New version must be effective after the current one (${latest.effective_from})`);
  }
  if (latest && latest.effective_until === null) {
    await run("UPDATE phone_operations_settings SET effective_until = ? WHERE id = ?", [effectiveFrom, latest.id]);
  }
  await run(
    `INSERT INTO phone_operations_settings
       (organization_id, operating_mode, inbound_enabled, outbound_enabled, max_concurrent_calls, daily_call_cap, effective_from, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.organizationId, input.operating_mode, input.inbound_enabled ? 1 : 0, input.outbound_enabled ? 1 : 0,
      input.max_concurrent_calls, input.daily_call_cap, effectiveFrom, input.actorId,
    ]
  );
  const row = await get<PhoneOperationsSettingsRow>(
    "SELECT * FROM phone_operations_settings WHERE organization_id = ? ORDER BY id DESC LIMIT 1", [input.organizationId]
  );
  return toSettings(row!);
}

// ── Voice Engine (Twilio) account credential — one per organization,
// current-value, not historically versioned (an operational credential,
// not financial/legal truth). AES-256-GCM at rest via crypto.ts, same
// mechanism already protecting Google Calendar OAuth tokens. ────────────

export interface VoiceEngineCredentialSummary {
  organization_id: number;
  provider: string;
  account_sid: string;
  status: string;
  configured: boolean;
  updated_at: string | null;
}

interface VoiceEngineCredentialRow {
  id: number;
  organization_id: number;
  provider: string;
  account_sid: string;
  auth_token_encrypted: string;
  status: string;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

export async function getVoiceEngineCredentialSummary(organizationId: number): Promise<VoiceEngineCredentialSummary> {
  const row = await get<VoiceEngineCredentialRow>(
    "SELECT * FROM voice_engine_credentials WHERE organization_id = ?", [organizationId]
  );
  if (!row) return { organization_id: organizationId, provider: "twilio", account_sid: "", status: "unconfigured", configured: false, updated_at: null };
  return { organization_id: row.organization_id, provider: row.provider, account_sid: row.account_sid, status: row.status, configured: true, updated_at: row.updated_at };
}

/** Only for server-side use (webhook signature verification, outbound call
 *  placement) — the decrypted token must never be returned from an API
 *  route. Returns null if unconfigured or `TOKEN_ENCRYPTION_KEY` is unset. */
export async function getDecryptedTwilioAuthToken(organizationId: number, tokenEncryptionKey: string | undefined): Promise<{ accountSid: string; authToken: string } | null> {
  if (!tokenEncryptionKey) return null;
  const row = await get<VoiceEngineCredentialRow>(
    "SELECT * FROM voice_engine_credentials WHERE organization_id = ? AND status = 'active'", [organizationId]
  );
  if (!row) return null;
  const authToken = await decryptSecret(row.auth_token_encrypted, tokenEncryptionKey);
  return { accountSid: row.account_sid, authToken };
}

export async function saveVoiceEngineCredential(input: { organizationId: number; accountSid: string; authToken: string; actorId: number }, tokenEncryptionKey: string | undefined): Promise<VoiceEngineCredentialSummary> {
  if (!tokenEncryptionKey) throw new PhoneOperationsError("not_configured", "TOKEN_ENCRYPTION_KEY is not set on this server");
  if (!input.accountSid.trim()) throw new PhoneOperationsError("invalid_account_sid", "account_sid is required");
  if (!input.authToken.trim()) throw new PhoneOperationsError("invalid_auth_token", "auth_token is required");
  const encrypted = await encryptSecret(input.authToken, tokenEncryptionKey);
  const existing = await get<{ id: number }>("SELECT id FROM voice_engine_credentials WHERE organization_id = ?", [input.organizationId]);
  if (existing) {
    await run(
      `UPDATE voice_engine_credentials SET account_sid = ?, auth_token_encrypted = ?, status = 'active', updated_at = datetime('now')
       WHERE organization_id = ?`,
      [input.accountSid.trim(), encrypted, input.organizationId]
    );
  } else {
    await run(
      `INSERT INTO voice_engine_credentials (organization_id, account_sid, auth_token_encrypted, created_by)
       VALUES (?, ?, ?, ?)`,
      [input.organizationId, input.accountSid.trim(), encrypted, input.actorId]
    );
  }
  return getVoiceEngineCredentialSummary(input.organizationId);
}

// ── Voice Engine SERVICE credential — the token the separate Voice Engine
// runtime presents to OFS's runtime API. Hashed before storage exactly like
// sessions.token_hash (auth.ts). This is the mechanism that lets OFS
// resolve `organization_id` for a runtime request WITHOUT trusting
// anything the runtime asserts in its request body. ─────────────────────

export interface VoiceEngineServiceCredentialSummary {
  id: number;
  organization_id: number;
  label: string;
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

export async function issueVoiceEngineServiceCredential(organizationId: number, label: string, actorId: number): Promise<{ id: number; token: string }> {
  const token = generateOpaqueToken();
  const tokenHash = await hashOpaqueToken(token);
  await run(
    "INSERT INTO voice_engine_service_credentials (organization_id, token_hash, label, created_by) VALUES (?, ?, ?, ?)",
    [organizationId, tokenHash, label.trim().slice(0, 200), actorId]
  );
  const row = await get<{ id: number }>(
    "SELECT id FROM voice_engine_service_credentials WHERE organization_id = ? ORDER BY id DESC LIMIT 1", [organizationId]
  );
  return { id: row!.id, token };
}

export async function listVoiceEngineServiceCredentials(organizationId: number): Promise<VoiceEngineServiceCredentialSummary[]> {
  return query<VoiceEngineServiceCredentialSummary>(
    "SELECT id, organization_id, label, created_at, revoked_at, last_used_at FROM voice_engine_service_credentials WHERE organization_id = ? ORDER BY created_at DESC",
    [organizationId]
  );
}

export async function revokeVoiceEngineServiceCredential(organizationId: number, id: number): Promise<boolean> {
  const result = await run(
    "UPDATE voice_engine_service_credentials SET revoked_at = datetime('now') WHERE id = ? AND organization_id = ? AND revoked_at IS NULL",
    [id, organizationId]
  );
  return result.changes > 0;
}

/** The ONE function that turns a raw runtime bearer token into a resolved,
 *  trustworthy `organization_id`. Never accepts an organization id as
 *  input — that would defeat the entire point. Updates `last_used_at`
 *  best-effort (not awaited-critical — a failure here must never block the
 *  caller from proceeding with an otherwise-valid credential). */
export async function resolveVoiceEngineServiceCredential(rawToken: string): Promise<{ id: number; organization_id: number } | null> {
  if (!rawToken) return null;
  const tokenHash = await hashOpaqueToken(rawToken);
  const row = await get<{ id: number; organization_id: number }>(
    "SELECT id, organization_id FROM voice_engine_service_credentials WHERE token_hash = ? AND revoked_at IS NULL", [tokenHash]
  );
  if (!row) return null;
  await run("UPDATE voice_engine_service_credentials SET last_used_at = datetime('now') WHERE id = ?", [row.id]);
  return row;
}

// ── Voice Agents (versioned per `name`, mirrors settings.ts's per-key
// versioning thread rather than tax-jurisdiction.ts's single-thread-per-org
// shape, since an organization may run more than one named agent). ──────

export interface VoiceAgent {
  id: number;
  organization_id: number;
  name: string;
  language: string;
  voice: string;
  model: string;
  instructions: string;
  is_default: boolean;
  status: string;
  /** Phase 16 — the exact set of Phone Operations CRM tool names this
   *  AGENT VERSION may invoke (see phone-operations-crm.ts's tool
   *  registry). Versioned like every other column here: changing it
   *  publishes a new agent version and never rewrites what an
   *  already-run call's own frozen `voice_agent_snapshot` recorded. */
  tool_policy: string[];
  effective_from: string;
  effective_until: string | null;
  created_by: number | null;
  created_at: string;
}

interface VoiceAgentRow extends Omit<VoiceAgent, "is_default" | "tool_policy"> {
  is_default: number;
  tool_policy: string;
}

function toAgent(row: VoiceAgentRow): VoiceAgent {
  let toolPolicy: string[] = [];
  try { toolPolicy = JSON.parse(row.tool_policy); } catch { /* malformed policy never crashes a read — resolves to no tools */ }
  return { ...row, is_default: !!row.is_default, tool_policy: Array.isArray(toolPolicy) ? toolPolicy : [] };
}

/** Every agent version currently in effect (one row per distinct `name`),
 *  mirrors settings.ts#listCurrentSettings. */
export async function listCurrentVoiceAgents(organizationId: number): Promise<VoiceAgent[]> {
  const now = new Date().toISOString();
  const rows = await query<VoiceAgentRow>(
    `SELECT a.* FROM voice_agents a
     WHERE a.organization_id = ? AND a.effective_from <= ?
       AND (a.effective_until IS NULL OR a.effective_until > ?)
       AND a.effective_from = (
         SELECT MAX(a2.effective_from) FROM voice_agents a2
         WHERE a2.organization_id = a.organization_id AND a2.name = a.name AND a2.effective_from <= ?
       )
     ORDER BY a.name ASC`,
    [organizationId, now, now, now]
  );
  return rows.map(toAgent);
}

export async function getVoiceAgentHistory(organizationId: number, name: string): Promise<VoiceAgent[]> {
  const rows = await query<VoiceAgentRow>(
    "SELECT * FROM voice_agents WHERE organization_id = ? AND name = ? ORDER BY effective_from DESC", [organizationId, name]
  );
  return rows.map(toAgent);
}

export async function resolveDefaultVoiceAgent(organizationId: number, asOf?: string): Promise<VoiceAgent | null> {
  const at = asOf ?? new Date().toISOString();
  const row = await get<VoiceAgentRow>(
    `SELECT * FROM voice_agents
     WHERE organization_id = ? AND is_default = 1 AND status = 'active' AND effective_from <= ?
       AND (effective_until IS NULL OR effective_until > ?)
     ORDER BY effective_from DESC LIMIT 1`,
    [organizationId, at, at]
  );
  return row ? toAgent(row) : null;
}

export interface SaveVoiceAgentInput {
  organizationId: number;
  name: string;
  language: string;
  voice: string;
  model: string;
  instructions: string;
  is_default: boolean;
  status: string;
  tool_policy: string[];
  effectiveFrom?: string;
  actorId: number;
}

const AGENT_STATUSES = ["draft", "active", "archived"];

/** Publishes a new version of the agent named `input.name`. Never mutates a
 *  past version — closes the previously-open version's `effective_until`
 *  at the new version's start and inserts a fresh row, same discipline as
 *  settings.ts#publishSetting keyed by `name` instead of `key`. If this
 *  version becomes the organization's default, any OTHER currently-open
 *  default agent is demoted first (a plain in-place `is_default` flip on
 *  that other row — `is_default` is a "current selection" pointer, not
 *  itself historical truth the way rate/prompt content is) so the database
 *  constraint (`idx_voice_agents_one_open_default`) is never violated. */
export async function saveVoiceAgent(input: SaveVoiceAgentInput): Promise<VoiceAgent> {
  const name = input.name.trim();
  if (!name) throw new PhoneOperationsError("invalid_name", "name is required");
  if (!AGENT_STATUSES.includes(input.status)) throw new PhoneOperationsError("invalid_status", `status must be one of ${AGENT_STATUSES.join(", ")}`);
  const effectiveFrom = input.effectiveFrom ?? new Date().toISOString();
  const latest = await get<VoiceAgentRow>(
    "SELECT * FROM voice_agents WHERE organization_id = ? AND name = ? ORDER BY effective_from DESC LIMIT 1",
    [input.organizationId, name]
  );
  if (latest && effectiveFrom <= latest.effective_from) {
    throw new PhoneOperationsError("invalid_effective_from", `New version must be effective after the current one (${latest.effective_from})`);
  }
  if (input.is_default) {
    await run(
      "UPDATE voice_agents SET is_default = 0 WHERE organization_id = ? AND effective_until IS NULL AND is_default = 1 AND name != ?",
      [input.organizationId, name]
    );
  }
  if (latest && latest.effective_until === null) {
    await run("UPDATE voice_agents SET effective_until = ? WHERE id = ?", [effectiveFrom, latest.id]);
  }
  await run(
    `INSERT INTO voice_agents (organization_id, name, language, voice, model, instructions, is_default, status, tool_policy, effective_from, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.organizationId, name, input.language, input.voice, input.model, input.instructions,
      input.is_default ? 1 : 0, input.status, JSON.stringify(input.tool_policy ?? []), effectiveFrom, input.actorId,
    ]
  );
  const row = await get<VoiceAgentRow>(
    "SELECT * FROM voice_agents WHERE organization_id = ? AND name = ? ORDER BY id DESC LIMIT 1", [input.organizationId, name]
  );
  return toAgent(row!);
}

// ── Phone Numbers (plain CRUD — provisioning records, not historically
// versioned truth). `resolveOrganizationByPhoneNumber` is the anti-IDOR
// primitive the Twilio webhook route uses to determine which organization
// owns an inbound call from the dialed `To` number alone — never from
// anything Twilio's request merely claims about tenancy. ────────────────

export interface PhoneNumber {
  id: number;
  organization_id: number;
  e164_number: string;
  provider: string;
  provider_number_sid: string;
  voice_agent_id: number | null;
  inbound_enabled: boolean;
  outbound_enabled: boolean;
  status: string;
  created_by: number | null;
  created_at: string;
}

interface PhoneNumberRow extends Omit<PhoneNumber, "inbound_enabled" | "outbound_enabled"> {
  inbound_enabled: number;
  outbound_enabled: number;
}

function toPhoneNumber(row: PhoneNumberRow): PhoneNumber {
  return { ...row, inbound_enabled: !!row.inbound_enabled, outbound_enabled: !!row.outbound_enabled };
}

export async function listPhoneNumbers(organizationId: number): Promise<PhoneNumber[]> {
  const rows = await query<PhoneNumberRow>("SELECT * FROM phone_numbers WHERE organization_id = ? ORDER BY created_at DESC", [organizationId]);
  return rows.map(toPhoneNumber);
}

/** Pure bookkeeping — this never calls Twilio to confirm the organization's
 *  configured Twilio account actually owns `e164Number`. Uniqueness is
 *  global (not per-org), so an admin can register a number belonging to a
 *  different, not-yet-onboarded organization and block that org from ever
 *  provisioning it (independent Security review finding). This can't be
 *  used to hijack a real call — the squatter's own Twilio Auth Token won't
 *  match the real owner's, so `verifyTwilioSignature` fails closed — but
 *  it's a real griefing/DoS vector worth real ownership verification (a
 *  Twilio API lookup, or a verification-code flow) in a future phase. */
export async function createPhoneNumber(input: { organizationId: number; e164Number: string; voiceAgentId: number | null; actorId: number }): Promise<PhoneNumber> {
  if (!/^\+[1-9]\d{6,14}$/.test(input.e164Number)) throw new PhoneOperationsError("invalid_number", "e164_number must be a valid E.164 number, e.g. +16045551234");
  const existing = await get<{ id: number }>("SELECT id FROM phone_numbers WHERE e164_number = ?", [input.e164Number]);
  if (existing) throw new PhoneOperationsError("duplicate_number", "This number is already provisioned");
  await run(
    "INSERT INTO phone_numbers (organization_id, e164_number, voice_agent_id, created_by) VALUES (?, ?, ?, ?)",
    [input.organizationId, input.e164Number, input.voiceAgentId, input.actorId]
  );
  const row = await get<PhoneNumberRow>("SELECT * FROM phone_numbers WHERE organization_id = ? ORDER BY id DESC LIMIT 1", [input.organizationId]);
  return toPhoneNumber(row!);
}

export async function updatePhoneNumber(organizationId: number, id: number, patch: { voiceAgentId?: number | null; inboundEnabled?: boolean; outboundEnabled?: boolean; status?: string }): Promise<PhoneNumber | null> {
  const existing = await get<{ id: number }>("SELECT id FROM phone_numbers WHERE id = ? AND organization_id = ?", [id, organizationId]);
  if (!existing) return null;
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.voiceAgentId !== undefined) { sets.push("voice_agent_id = ?"); params.push(patch.voiceAgentId); }
  if (patch.inboundEnabled !== undefined) { sets.push("inbound_enabled = ?"); params.push(patch.inboundEnabled ? 1 : 0); }
  if (patch.outboundEnabled !== undefined) { sets.push("outbound_enabled = ?"); params.push(patch.outboundEnabled ? 1 : 0); }
  if (patch.status !== undefined) { sets.push("status = ?"); params.push(patch.status); }
  if (sets.length) {
    params.push(id, organizationId);
    await run(`UPDATE phone_numbers SET ${sets.join(", ")} WHERE id = ? AND organization_id = ?`, params);
  }
  const row = await get<PhoneNumberRow>("SELECT * FROM phone_numbers WHERE id = ? AND organization_id = ?", [id, organizationId]);
  return toPhoneNumber(row!);
}

export async function resolveOrganizationByPhoneNumber(e164Number: string): Promise<{ organization_id: number; phone_number_id: number; voice_agent_id: number | null; inbound_enabled: boolean } | null> {
  const row = await get<{ organization_id: number; id: number; voice_agent_id: number | null; inbound_enabled: number; status: string }>(
    "SELECT organization_id, id, voice_agent_id, inbound_enabled, status FROM phone_numbers WHERE e164_number = ?", [e164Number]
  );
  if (!row || row.status !== "active") return null;
  return { organization_id: row.organization_id, phone_number_id: row.id, voice_agent_id: row.voice_agent_id, inbound_enabled: !!row.inbound_enabled };
}

// ── Calls (FSM) ──────────────────────────────────────────────────────

export type CallStatus = "queued" | "ringing" | "in_progress" | "completed" | "failed" | "no_answer" | "busy" | "canceled";

/** Terminal states never transition further — enforced by ALLOWED_TRANSITIONS
 *  having no entry for them. */
const ALLOWED_TRANSITIONS: Record<CallStatus, CallStatus[]> = {
  queued: ["ringing", "in_progress", "failed", "canceled", "no_answer", "busy"],
  ringing: ["in_progress", "completed", "failed", "no_answer", "busy", "canceled"],
  in_progress: ["completed", "failed"],
  completed: [],
  failed: [],
  no_answer: [],
  busy: [],
  canceled: [],
};

export interface Call {
  id: number;
  organization_id: number;
  direction: "inbound" | "outbound";
  status: CallStatus;
  provider_call_sid: string | null;
  phone_number_id: number | null;
  from_number: string;
  to_number: string;
  voice_agent_id: number | null;
  voice_agent_snapshot: Record<string, unknown>;
  initiated_by_user_id: number | null;
  started_at: string | null;
  answered_at: string | null;
  ended_at: string | null;
  end_reason: string;
  duration_seconds: number | null;
  created_at: string;
  /** Phase 16 — CRM linkage. Nullable/independent (a call may link to a
   *  Customer, a Lead, a Job, any combination, or none) — see
   *  phone-operations-crm.ts for how these are set. */
  customer_id: number | null;
  lead_id: number | null;
  job_id: number | null;
  match_confidence: "EXACT_PHONE" | "MANUAL" | "UNKNOWN";
  match_source: string;
}

interface CallRow extends Omit<Call, "voice_agent_snapshot"> {
  voice_agent_snapshot: string;
}

function toCall(row: CallRow): Call {
  let snapshot: Record<string, unknown> = {};
  try { snapshot = JSON.parse(row.voice_agent_snapshot); } catch { /* malformed snapshot never crashes a read */ }
  return { ...row, voice_agent_snapshot: snapshot };
}

function snapshotAgent(agent: VoiceAgent | null): Record<string, unknown> {
  if (!agent) return {};
  // Phase 16: tool_policy is frozen here too — the ONE place invokeTool()
  // reads a call's permitted tools from (see phone-operations-crm.ts), so a
  // later edit to this agent's live tool_policy can never retroactively
  // grant or revoke capability on an already-started call.
  return { id: agent.id, name: agent.name, language: agent.language, voice: agent.voice, model: agent.model, instructions: agent.instructions, tool_policy: agent.tool_policy };
}

/** Every gate a new call must pass before OFS will create/accept it —
 *  operating mode, direction toggle, concurrency cap, and daily cap.
 *  EMERGENCY_STOP and DISABLED behave identically for NEW calls (both
 *  refuse); EMERGENCY_STOP additionally signals the Voice Engine (via
 *  `resolvePhoneOperationsSettings` polling — see docs) to end any calls
 *  already in progress, which is outside this Worker's control once a
 *  Media Stream session is live on the separate runtime.
 *
 *  ponytail: the concurrency/daily-cap counts are read-then-the-caller-
 *  inserts, not one atomic statement — two near-simultaneous inbound
 *  webhooks can both pass the check before either row commits, momentarily
 *  exceeding the configured cap (independent Architecture/Security review
 *  finding). Accepted for this foundation's realistic small-business call
 *  volume; revisit with a single-writer transaction or an atomic
 *  `INSERT ... WHERE (SELECT COUNT...) < cap` if concurrent-call volume
 *  ever becomes non-trivial. */
export async function assertCallAllowed(organizationId: number, direction: "inbound" | "outbound"): Promise<void> {
  const settings = await resolvePhoneOperationsSettings(organizationId);
  if (settings.operating_mode !== "ACTIVE") {
    throw new PhoneOperationsError("not_active", `Phone Operations is ${settings.operating_mode.toLowerCase()}, not accepting new calls`);
  }
  if (direction === "inbound" && !settings.inbound_enabled) throw new PhoneOperationsError("inbound_disabled", "Inbound calling is disabled");
  if (direction === "outbound" && !settings.outbound_enabled) throw new PhoneOperationsError("outbound_disabled", "Outbound calling is disabled");
  const active = await get<{ n: number }>(
    "SELECT COUNT(*) as n FROM calls WHERE organization_id = ? AND status IN ('queued','ringing','in_progress')", [organizationId]
  );
  if ((active?.n ?? 0) >= settings.max_concurrent_calls) throw new PhoneOperationsError("concurrency_limit", "Maximum concurrent calls reached");
  if (settings.daily_call_cap > 0) {
    const today = await get<{ n: number }>(
      "SELECT COUNT(*) as n FROM calls WHERE organization_id = ? AND date(created_at) = date('now')", [organizationId]
    );
    if ((today?.n ?? 0) >= settings.daily_call_cap) throw new PhoneOperationsError("daily_cap_reached", "Daily call cap reached");
  }
}

async function createCall(input: {
  organizationId: number; direction: "inbound" | "outbound"; fromNumber: string; toNumber: string;
  phoneNumberId: number | null; voiceAgentId: number | null; providerCallSid: string | null; initiatedByUserId: number | null;
}): Promise<Call> {
  await assertCallAllowed(input.organizationId, input.direction);
  // The number's own bound agent wins when set (independent reviewer
  // finding, Phase 15 fix — `phone_numbers.voice_agent_id` was being
  // recorded and exposed in the UI but never actually consulted here,
  // silently routing every call to the org-wide default regardless of
  // which number was dialed); falls back to the org default otherwise.
  const agent = input.voiceAgentId
    ? await get<VoiceAgentRow>("SELECT * FROM voice_agents WHERE id = ? AND organization_id = ?", [input.voiceAgentId, input.organizationId]).then((r) => (r ? toAgent(r) : null))
    : await resolveDefaultVoiceAgent(input.organizationId);
  try {
    await run(
      `INSERT INTO calls (organization_id, direction, status, provider_call_sid, phone_number_id, from_number, to_number, voice_agent_id, voice_agent_snapshot, initiated_by_user_id, started_at)
       VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.organizationId, input.direction, input.providerCallSid, input.phoneNumberId, input.fromNumber, input.toNumber,
        agent?.id ?? null, JSON.stringify(snapshotAgent(agent)), input.initiatedByUserId, new Date().toISOString(),
      ]
    );
  } catch (err) {
    // Twilio retries a webhook it didn't get a fast 2xx for — a replayed
    // inbound call with the same CallSid must resolve idempotently to the
    // call already created on the first delivery, never a 500 (independent
    // Testing review finding, reproduced: an uncaught UNIQUE violation on
    // provider_call_sid here crashed the request, unlike recordCallEvent/
    // appendTranscript two functions below, which already handle this).
    if (input.providerCallSid && String(err).includes("UNIQUE")) {
      const existing = await getCallByProviderSid(input.providerCallSid);
      if (existing) return existing;
    }
    throw err;
  }
  const row = await get<CallRow>("SELECT * FROM calls WHERE organization_id = ? ORDER BY id DESC LIMIT 1", [input.organizationId]);
  const call = toCall(row!);
  await recordCallEvent(input.organizationId, call.id, { eventType: "created", toStatus: "queued", actorType: input.direction === "inbound" ? "twilio" : "user", actorUserId: input.initiatedByUserId });
  return call;
}

export async function createInboundCall(input: { organizationId: number; phoneNumberId: number; voiceAgentId: number | null; fromNumber: string; toNumber: string; providerCallSid: string }): Promise<Call> {
  return createCall({ organizationId: input.organizationId, direction: "inbound", fromNumber: input.fromNumber, toNumber: input.toNumber, phoneNumberId: input.phoneNumberId, voiceAgentId: input.voiceAgentId, providerCallSid: input.providerCallSid, initiatedByUserId: null });
}

export async function createOutboundCall(input: { organizationId: number; phoneNumberId: number; voiceAgentId: number | null; fromNumber: string; toNumber: string; initiatedByUserId: number }): Promise<Call> {
  return createCall({ organizationId: input.organizationId, direction: "outbound", fromNumber: input.fromNumber, toNumber: input.toNumber, phoneNumberId: input.phoneNumberId, voiceAgentId: input.voiceAgentId, providerCallSid: null, initiatedByUserId: input.initiatedByUserId });
}

/** Marks a call `failed` when it could never actually be placed (e.g. the
 *  Twilio REST call itself threw) — without this, a call row created by
 *  `createOutboundCall` before the provider call failed would stay
 *  `queued` forever (no provider_call_sid ever exists for a status
 *  webhook to resolve it), permanently consuming one concurrency-cap and
 *  one daily-cap slot for the organization (independent Architecture and
 *  Security review finding). */
export async function markCallFailedToPlace(organizationId: number, callId: number, reason: string): Promise<void> {
  const call = await getCall(organizationId, callId);
  if (!call) return;
  await recordCallEvent(organizationId, callId, { eventType: "placement_failed", toStatus: "failed", actorType: "system", details: { reason } });
}

export async function getCall(organizationId: number, id: number): Promise<Call | null> {
  const row = await get<CallRow>("SELECT * FROM calls WHERE id = ? AND organization_id = ?", [id, organizationId]);
  return row ? toCall(row) : null;
}

export async function getCallByProviderSid(providerCallSid: string): Promise<Call | null> {
  const row = await get<CallRow>("SELECT * FROM calls WHERE provider_call_sid = ?", [providerCallSid]);
  return row ? toCall(row) : null;
}

export async function listCalls(organizationId: number, opts: { limit: number; offset: number; status?: string; direction?: string }): Promise<{ calls: Call[]; total: number }> {
  const clauses = ["organization_id = ?"];
  const params: unknown[] = [organizationId];
  if (opts.status) { clauses.push("status = ?"); params.push(opts.status); }
  if (opts.direction) { clauses.push("direction = ?"); params.push(opts.direction); }
  const where = clauses.join(" AND ");
  const rows = await query<CallRow>(`SELECT * FROM calls WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, opts.limit, opts.offset]);
  const totalRow = await get<{ n: number }>(`SELECT COUNT(*) as n FROM calls WHERE ${where}`, params);
  return { calls: rows.map(toCall), total: totalRow?.n ?? 0 };
}

export interface RecordCallEventInput {
  eventType: string;
  toStatus?: CallStatus;
  actorType: "system" | "twilio" | "voice_engine" | "user";
  actorUserId?: number | null;
  idempotencyKey?: string | null;
  details?: Record<string, unknown>;
}

/** Appends an event and, if `toStatus` is given, transitions the call —
 *  validated against ALLOWED_TRANSITIONS so an out-of-order or replayed
 *  webhook can never rewind a call from a terminal state. Idempotent when
 *  `idempotencyKey` is supplied: a duplicate (call_id, idempotency_key) —
 *  e.g. Twilio retrying an unacknowledged webhook — is silently absorbed,
 *  never double-applied. `organizationId` is re-checked here (not just at
 *  the route layer) so this function is safe to call from anywhere in the
 *  codebase without re-deriving the cross-tenant check at every call site
 *  — independent Security review finding, same discipline
 *  `markCallSessionDisconnected` already applies. */
export async function recordCallEvent(organizationId: number, callId: number, input: RecordCallEventInput): Promise<{ applied: boolean }> {
  const call = await get<CallRow>("SELECT * FROM calls WHERE id = ? AND organization_id = ?", [callId, organizationId]);
  if (!call) throw new PhoneOperationsError("not_found", "Call not found");
  const fromStatus = call.status as CallStatus;
  let toStatus = input.toStatus;
  if (toStatus && toStatus !== fromStatus) {
    const allowed = ALLOWED_TRANSITIONS[fromStatus] ?? [];
    if (!allowed.includes(toStatus)) {
      throw new PhoneOperationsError("invalid_transition", `Cannot transition call from ${fromStatus} to ${toStatus}`);
    }
  } else {
    toStatus = undefined;
  }
  try {
    await run(
      `INSERT INTO call_events (call_id, event_type, from_status, to_status, actor_type, actor_user_id, idempotency_key, details)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [callId, input.eventType, fromStatus, toStatus ?? null, input.actorType, input.actorUserId ?? null, input.idempotencyKey ?? null, JSON.stringify(input.details ?? {})]
    );
  } catch (err) {
    if (input.idempotencyKey && String(err).includes("UNIQUE")) return { applied: false };
    throw err;
  }
  if (toStatus) {
    const isTerminal = ["completed", "failed", "no_answer", "busy", "canceled"].includes(toStatus);
    const now = new Date().toISOString();
    const sets = ["status = ?"];
    const params: unknown[] = [toStatus];
    if (toStatus === "in_progress" && !call.answered_at) { sets.push("answered_at = ?"); params.push(now); }
    if (isTerminal) {
      sets.push("ended_at = ?"); params.push(now);
      sets.push("end_reason = ?"); params.push(input.eventType);
      if (call.started_at) {
        sets.push("duration_seconds = ?");
        params.push(Math.max(0, Math.round((Date.parse(now) - Date.parse(call.started_at)) / 1000)));
      }
    }
    params.push(callId);
    await run(`UPDATE calls SET ${sets.join(", ")} WHERE id = ?`, params);
  }
  return { applied: true };
}

export async function listCallEvents(organizationId: number, callId: number): Promise<Array<{ id: number; event_type: string; from_status: string | null; to_status: string | null; actor_type: string; actor_user_id: number | null; details: string; created_at: string }>> {
  return query(
    `SELECT ce.* FROM call_events ce JOIN calls c ON c.id = ce.call_id WHERE ce.call_id = ? AND c.organization_id = ? ORDER BY ce.id ASC`,
    [callId, organizationId]
  );
}

// ── Call Sessions (Media Stream boundary auth) — short-lived, call-scoped,
// organization-bound tokens OFS issues so the Voice Engine's WebSocket
// upgrade for one specific call can be authenticated without a durable
// credential ever touching the audio path. ──────────────────────────────

export async function issueCallSession(callId: number, ttlSeconds = 120): Promise<{ id: number; token: string; expiresAt: string }> {
  const token = generateOpaqueToken();
  const tokenHash = await hashOpaqueToken(token);
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  await run("INSERT INTO call_sessions (call_id, session_token_hash, expires_at) VALUES (?, ?, ?)", [callId, tokenHash, expiresAt]);
  const row = await get<{ id: number }>("SELECT id FROM call_sessions WHERE call_id = ? ORDER BY id DESC LIMIT 1", [callId]);
  return { id: row!.id, token, expiresAt };
}

export async function resolveCallSession(rawToken: string): Promise<{ id: number; call_id: number; organization_id: number } | null> {
  const tokenHash = await hashOpaqueToken(rawToken);
  const row = await get<{ id: number; call_id: number; organization_id: number; expires_at: string }>(
    `SELECT cs.id, cs.call_id, c.organization_id, cs.expires_at FROM call_sessions cs
     JOIN calls c ON c.id = cs.call_id WHERE cs.session_token_hash = ?`,
    [tokenHash]
  );
  if (!row) return null;
  if (Date.parse(row.expires_at) < Date.now()) return null;
  return { id: row.id, call_id: row.call_id, organization_id: row.organization_id };
}

export async function markCallSessionConnected(sessionId: number): Promise<void> {
  await run("UPDATE call_sessions SET connected_at = datetime('now') WHERE id = ? AND connected_at IS NULL", [sessionId]);
}

/** Org-checked: joins through to `calls.organization_id` before writing, so
 *  a service credential can never disconnect a session belonging to a
 *  different organization by guessing/enumerating session ids — the same
 *  cross-tenant IDOR concern `resolveVoiceEngineServiceCredential`'s own
 *  header comment calls out. Returns false (no-op) rather than throwing on
 *  a cross-org or unknown id, so a caller can treat it identically to
 *  "not found." */
export async function markCallSessionDisconnected(organizationId: number, sessionId: number, reason: string): Promise<boolean> {
  const owned = await get<{ id: number }>(
    `SELECT cs.id FROM call_sessions cs JOIN calls c ON c.id = cs.call_id WHERE cs.id = ? AND c.organization_id = ?`,
    [sessionId, organizationId]
  );
  if (!owned) return false;
  await run("UPDATE call_sessions SET disconnected_at = datetime('now'), disconnect_reason = ? WHERE id = ? AND disconnected_at IS NULL", [reason, sessionId]);
  return true;
}

// ── Transcripts (append-only) ───────────────────────────────────────

export async function appendTranscript(organizationId: number, callId: number, entry: { sequence: number; speaker: "agent" | "caller"; text: string; confidence?: number | null }): Promise<{ applied: boolean }> {
  const owned = await get<{ id: number }>("SELECT id FROM calls WHERE id = ? AND organization_id = ?", [callId, organizationId]);
  if (!owned) throw new PhoneOperationsError("not_found", "Call not found");
  try {
    await run(
      "INSERT INTO call_transcripts (call_id, sequence, speaker, text, confidence) VALUES (?, ?, ?, ?, ?)",
      [callId, entry.sequence, entry.speaker, entry.text, entry.confidence ?? null]
    );
    return { applied: true };
  } catch (err) {
    if (String(err).includes("UNIQUE")) return { applied: false };
    throw err;
  }
}

export async function listTranscript(organizationId: number, callId: number): Promise<Array<{ sequence: number; speaker: string; text: string; confidence: number | null; created_at: string }>> {
  return query(
    `SELECT ct.sequence, ct.speaker, ct.text, ct.confidence, ct.created_at FROM call_transcripts ct
     JOIN calls c ON c.id = ct.call_id WHERE ct.call_id = ? AND c.organization_id = ? ORDER BY ct.sequence ASC`,
    [callId, organizationId]
  );
}

// ── Outcomes — a structured AI-produced result for a human to review.
// Deliberately never triggers a Customer/Lead/Job write (Phase 16). ─────

export async function recordCallOutcome(organizationId: number, callId: number, input: { outcomeType: string; summary: string; structuredData: Record<string, unknown>; confidence?: number | null }): Promise<{ applied: boolean }> {
  const owned = await get<{ id: number }>("SELECT id FROM calls WHERE id = ? AND organization_id = ?", [callId, organizationId]);
  if (!owned) throw new PhoneOperationsError("not_found", "Call not found");
  const existing = await get<{ id: number }>("SELECT id FROM call_outcomes WHERE call_id = ?", [callId]);
  if (existing) return { applied: false };
  await run(
    "INSERT INTO call_outcomes (call_id, outcome_type, summary, structured_data, confidence) VALUES (?, ?, ?, ?, ?)",
    [callId, input.outcomeType, input.summary, JSON.stringify(input.structuredData), input.confidence ?? null]
  );
  return { applied: true };
}

export async function getCallOutcome(organizationId: number, callId: number): Promise<{ outcome_type: string; summary: string; structured_data: string; confidence: number | null; created_at: string } | null> {
  const row = await get<{ outcome_type: string; summary: string; structured_data: string; confidence: number | null; created_at: string }>(
    `SELECT co.outcome_type, co.summary, co.structured_data, co.confidence, co.created_at FROM call_outcomes co
     JOIN calls c ON c.id = co.call_id WHERE co.call_id = ? AND c.organization_id = ?`,
    [callId, organizationId]
  );
  return row ?? null;
}

// ── Human Transfer (foundation only — no live PSTN transfer is executed
// by this Worker; this records intent/outcome for the Voice Engine and
// dispatcher UI to coordinate against). ─────────────────────────────────

export async function requestCallTransfer(organizationId: number, callId: number, input: { requestedBy: "voice_engine" | "user"; targetUserId?: number | null; targetPhoneNumber?: string | null }): Promise<{ id: number }> {
  const owned = await get<{ id: number }>("SELECT id FROM calls WHERE id = ? AND organization_id = ?", [callId, organizationId]);
  if (!owned) throw new PhoneOperationsError("not_found", "Call not found");
  await run(
    "INSERT INTO call_transfers (call_id, requested_by, target_user_id, target_phone_number) VALUES (?, ?, ?, ?)",
    [callId, input.requestedBy, input.targetUserId ?? null, input.targetPhoneNumber ?? ""]
  );
  const row = await get<{ id: number }>("SELECT id FROM call_transfers WHERE call_id = ? ORDER BY id DESC LIMIT 1", [callId]);
  return { id: row!.id };
}

export async function listCallTransfers(organizationId: number, callId: number): Promise<Array<{ id: number; requested_at: string; requested_by: string; target_user_id: number | null; target_phone_number: string; status: string; completed_at: string | null }>> {
  return query(
    `SELECT ct.* FROM call_transfers ct JOIN calls c ON c.id = ct.call_id WHERE ct.call_id = ? AND c.organization_id = ? ORDER BY ct.id ASC`,
    [callId, organizationId]
  );
}

// ── Audit ────────────────────────────────────────────────────────────

export async function recordPhoneOperationsAudit(input: { organizationId: number; eventType: string; entityType: string; entityId?: number | null; actorType: "user" | "voice_engine" | "system"; actorUserId?: number | null; details?: Record<string, unknown> }): Promise<void> {
  await run(
    "INSERT INTO phone_operations_audit (organization_id, event_type, entity_type, entity_id, actor_type, actor_user_id, details) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [input.organizationId, input.eventType, input.entityType, input.entityId ?? null, input.actorType, input.actorUserId ?? null, JSON.stringify(input.details ?? {})]
  );
}
