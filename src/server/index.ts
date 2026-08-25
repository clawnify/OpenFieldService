import type { Context } from "hono";
import { createApp, createRoute, z } from "@clawnify/app";
import { query, get, run, initDB } from "./db.js";
import {
  createSession,
  getSessionUser,
  hashPassword,
  invalidateUserSessions,
  logoutCurrentSession,
  setSessionCookie,
  verifyPassword,
  verifyPasswordOrDummy,
  type PublicUser,
  type Role,
  type UserRow,
} from "./auth.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import {
  SettingVersionError,
  getSettingHistory,
  listCurrentSettings,
  publishSetting,
  retireSetting,
} from "./settings.js";
import { BUSINESS_TIMEZONE_SETTING_KEY, getBusinessTimezone, isValidIanaTimezone } from "./business-timezone.js";
import {
  CompanyProfileValidationError,
  getCompanyLogo,
  getCompanyProfile,
  removeCompanyLogo,
  setCompanyLogo,
  upsertCompanyProfile,
} from "./company-profile.js";
import {
  ACTIVE_STATUSES,
  JOB_TYPES,
  PRE_WORK_STATUSES,
  WorkflowError,
  actorTechnicianId,
  allowedTransitionsForActor,
  canActorAccessJobCompliance,
  canCompleteJob,
  entryStatus,
  isJobType,
  isTerminalStatus,
  transitionJob,
  type Actor,
  type JobType,
} from "./workflow.js";
import {
  evaluateRebateEligibility,
  getJobRebateAudit,
  listEligibilityCodes,
  recordEligibilityCheck,
  recordEligibilityFieldChange,
} from "./modules/programs/bc/rebate.js";
import {
  AssetError,
  ASSET_STATUSES,
  canDeleteAsset,
  canManageAssets,
  createAsset,
  deleteAsset,
  getAsset,
  linkAssetToJob,
  listAssets,
  listAssetsForJob,
  unlinkAssetFromJob,
  updateAsset,
} from "./assets.js";
import { HVAC_ASSET_TYPES } from "./modules/hvac/asset-types.js";
import {
  DISCOUNT_TYPES,
  LINE_ITEM_CATEGORIES,
  QuoteError,
  addLineItem,
  canManageQuotes,
  createQuote,
  createQuoteRevision,
  deleteLineItem,
  deleteQuote,
  getQuote,
  getQuoteStatusHistory,
  getQuoteVersion,
  listQuoteVersions,
  listQuotes,
  updateLineItem,
  updateQuoteVersion,
} from "./quotes.js";
import {
  QUOTE_STATUSES,
  QuoteWorkflowError,
  canCreateRevisionFrom,
  resolveAllowedQuoteTransitions,
  transitionQuote,
} from "./quote-workflow.js";
import {
  SIGNATURE_METHODS,
  SIGNER_ROLES,
  ContractError,
  addContractSigner,
  canManageContracts,
  cancelSignatureRequest,
  createContract,
  createContractRevision,
  createContractTemplate,
  createContractTemplateVersion,
  declineSignature,
  deleteContract,
  deleteContractSigner,
  getContract,
  getContractDeliveryStatus,
  getContractVersion,
  getEvidencePackage,
  getSignatureRequestByToken,
  getSignedDocumentArtifact,
  listContractSigners,
  listContractTemplates,
  listContractVersions,
  listContracts,
  listSignatureRequests,
  recordConsent,
  resendSignatureRequest,
  resendSignedCopy,
  sendContractForSignature,
  submitSignature,
  updateContractVersion,
} from "./contracts.js";
import {
  CONTRACT_STATUSES,
  ContractWorkflowError,
  canCreateContractRevisionFrom,
  getContractStatusHistory,
  resolveAllowedContractTransitions,
  transitionContract,
} from "./contract-workflow.js";
import {
  CUSTOMER_REBATE_PROFILE_JOIN,
  CUSTOMER_REBATE_PROFILE_OVERRIDE_COLUMNS,
  getCustomerRebateProfile,
  upsertCustomerRebateProfile,
  type CustomerRebateProfile,
} from "./modules/programs/bc/customer-profile.js";
import { CustomerValidationError, resolveReferralAttribution } from "./customers.js";
import { LeadWorkflowError, transitionLead } from "./lead-workflow.js";
import { LeadConversionError, convertLead } from "./lead-conversion.js";
import {
  enqueueAppointmentCancelled, enqueueAppointmentConfirmation, enqueueAppointmentRescheduled,
  enqueueInvoiceSent, enqueueOnTheWay, enqueuePaymentReceipt, enqueuePostJobSurvey,
  getCustomerContact, latestPaymentId, latestScheduleHistoryId, latestStatusHistoryId, safeEnqueue,
} from "./notifications.js";
import { runCronCycle, type NotificationProviderBindings } from "./notification-dispatcher.js";
import { CONSENT_SOURCES, PreferenceUpdateError, getPreferencesView, updatePreferences } from "./notification-preferences.js";
import {
  getCustomerNotificationHistory, getInvoiceNotificationHistory, getJobNotificationHistory, getLeadNotificationHistory,
} from "./notification-history.js";
import {
  ScheduleConflictError,
  ScheduleValidationError,
  assertTechnicianAssignable,
  checkScheduleConflict,
  recordScheduleHistory,
  scheduleChanged,
  validateScheduleFields,
  type ScheduleSnapshot,
} from "./scheduling.js";
import {
  GoogleApiError,
  buildAuthUrl,
  exchangeCodeForTokens,
  fetchGoogleAccountEmail,
  listCalendars as listGoogleCalendars,
  revokeToken,
  type GoogleOAuthEnv,
} from "./google-calendar.js";
import {
  deleteJobFromAllCalendars,
  getValidAccessTokenForUser,
  syncAllJobsForUser,
  syncJobForUser,
  syncJobToAllConnectedUsers,
  type CalendarSyncEnv,
} from "./calendar-sync.js";
import { assertUploadAllowed, buildMediaKey, getObject, putObject, StorageError, type StorageEnv } from "./storage.js";
import { geocodeJob } from "./geocoding.js";
import { buildGeocodingProvider, type GoogleGeocodingBindings } from "./google-geocoding.js";
import { buildRoutingProvider, type RoutingBindings } from "./google-routing.js";
import { computeTechnicianRouteLegs, type RouteStopInput } from "./routing.js";
import {
  ComplianceError,
  MEDIA_KINDS,
  getCompletionReport,
  getComplianceAudit,
  getJobMedia,
  insertJobMedia,
  insertJobSignature,
  listJobMedia,
  listJobSignatures,
  recordComplianceEvent,
  softDeleteJobMedia,
  submitCompletionReport,
  upsertCompletionReport,
  type MediaKind,
} from "./compliance.js";
import {
  FinancialError,
  PAYER_TYPES,
  PAYMENT_METHODS,
  canManageFinancials,
  cancelPaymentSessionByToken,
  confirmMockPayment,
  createManualInvoice,
  createPaymentSession,
  deleteDraftInvoice,
  generateInvoiceForJob,
  getInvoiceAudit,
  getInvoiceById,
  getInvoiceDeliveryStatus,
  getInvoiceFinancials,
  getInvoicePdfBytesForDelivery,
  getPaymentDetail,
  getPaymentReceiptDeliveryStatus,
  getPaymentSessionByToken,
  getReceiptPdfBytesForDelivery,
  issueInvoice,
  listPayments,
  prepareInvoiceSend,
  preparePaymentReceiptEmail,
  processPaymentWebhookEvent,
  recordPayment,
  setRebateAmount,
  voidInvoice,
  voidPayment,
  type PayerType,
  type PaymentMethod,
} from "./financial.js";
import { MockPaymentProvider } from "./payment-provider.js";

type GoogleBindings = {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REDIRECT_URI?: string;
  TOKEN_ENCRYPTION_KEY?: string;
};

// Phase 10.2 — deliberately a SEPARATE type/binding from
// GoogleGeocodingBindings#GOOGLE_MAPS_API_KEY (the server-side geocoding
// secret). This key is designed to reach the browser (Google's own model —
// a Maps JavaScript API key is restricted via HTTP referrer, not secrecy)
// and must never be the same value as the geocoding secret, which must
// never leave the server. Non-secret tier, same as GOOGLE_CLIENT_ID above —
// lives in wrangler.toml's [vars], not .dev.vars.
type MapsBrowserBindings = { GOOGLE_MAPS_BROWSER_API_KEY?: string };

// Phase 13B — secret-tier (lives in .dev.vars locally / `wrangler secret
// put` in production, never wrangler.toml's [vars]), same convention as
// every other provider secret above. Its mere presence/absence IS the
// Provider-Disabled Mode gate (Section 34) — see paymentWebhookSecret()'s
// own doc comment further down this file.
type PaymentBindings = { MOCK_PAYMENT_WEBHOOK_SECRET?: string };

type Env = { Bindings: { DB: D1Database } & GoogleBindings & StorageEnv & NotificationProviderBindings & GoogleGeocodingBindings & MapsBrowserBindings & RoutingBindings & PaymentBindings; Variables: { user: PublicUser; organizationId: number } };

function googleEnv(c: Context<Env>): GoogleOAuthEnv & CalendarSyncEnv {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI, TOKEN_ENCRYPTION_KEY } = c.env;
  return {
    GOOGLE_CLIENT_ID: GOOGLE_CLIENT_ID || "",
    GOOGLE_CLIENT_SECRET: GOOGLE_CLIENT_SECRET || "",
    GOOGLE_REDIRECT_URI: GOOGLE_REDIRECT_URI || "",
    TOKEN_ENCRYPTION_KEY: TOKEN_ENCRYPTION_KEY || "",
  };
}

function isGoogleConfigured(c: Context<Env>): boolean {
  const env = googleEnv(c);
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REDIRECT_URI && env.TOKEN_ENCRYPTION_KEY);
}

const app = createApp<Env>({
  title: "Field Service Scheduler",
  version: "1.0.0",
  description:
    "Field service scheduling and business management with customers, technicians, service types, and job tracking.",
});

// ── Auth middleware ───────────────────────────────────────────────
// Every /api/* route requires a valid session except login (and logout,
// which is a no-op without one). Registered immediately after app
// creation so it wraps every route defined below.

// Phase 13B — the payment-provider webhook has no session of any kind (a
// real provider's server calls it directly, cookie-less, the same way
// Stripe/etc. webhooks work) — its security boundary is the HMAC
// signature check inside the handler (Section 30), not session auth, by
// design. An exact-match entry (not a token in the path) is correct here,
// unlike the /api/public/ prefix exemption below.
const PUBLIC_API_PATHS = new Set(["/api/auth/login", "/api/auth/logout", "/api/webhooks/payments/mock"]);

app.use("/api/*", async (c, next) => {
  // Phase 13 — the ONLY prefix-based (not exact-match) public exemption in
  // this codebase: contract signing links carry a dynamic token in the
  // path, so an exact-match Set can't cover them. Authorization for every
  // route under this prefix is the token itself (hashed at rest, single
  // -version/single-signer-bound, expiring/revocable) — see contracts.ts's
  // getSignatureRequestByToken(), the sole entry point every one of these
  // routes goes through. Never trust any organization_id/customer_id from
  // the request itself on this path — only what the token resolves to.
  if (PUBLIC_API_PATHS.has(c.req.path) || c.req.path.startsWith("/api/public/")) {
    await next();
    return;
  }
  const sessionUser = await getSessionUser(c);
  if (!sessionUser) return c.json({ error: "Unauthorized" }, 401);
  const { organizationId, ...user } = sessionUser;
  c.set("user", user);
  c.set("organizationId", organizationId);
  await next();
});

function currentUser(c: Context<Env>): PublicUser {
  return c.get("user");
}

// Phase 11.5 — the ONE authoritative place tenant context is resolved for
// route handlers, mirroring currentUser()'s shape/placement exactly. Always
// server-derived from the authenticated session (see the middleware above)
// — a client-supplied organization_id is never read or trusted anywhere in
// this file for authorization purposes.
function actorOrganizationId(c: Context<Env>): number {
  return c.get("organizationId");
}

// ── Shared Schemas ─────────────────────────────────────────────────

const ErrorSchema = z.object({ error: z.string() }).openapi("Error");
const OkSchema = z.object({ ok: z.boolean() }).openapi("Ok");
// Phase 7 — Advanced Scheduler: `error` stays a plain string (existing
// convention every other error response in this file follows — see
// ErrorSchema above), with an additive `conflict` object carrying just
// enough for the UI to explain the collision without leaking customer PII
// (no customer name/address/phone — job_id + the conflicting slot only).
const ScheduleConflictSchema = z.object({
  error: z.string(),
  conflict: z.object({
    job_id: z.number().int(),
    scheduled_date: z.string(),
    scheduled_time: z.string(),
    duration: z.number().int(),
  }),
}).openapi("ScheduleConflict");

const RoleSchema = z.enum(["admin", "dispatcher", "technician"]);
const PasswordSchema = z.string().min(8, "Password must be at least 8 characters");

const UserSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  email: z.string(),
  role: RoleSchema,
  active: z.number().int(),
  last_login_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
}).openapi("User");

const CustomerSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  email: z.string(),
  phone: z.string(),
  address: z.string(),
  city: z.string(),
  state: z.string(),
  zip: z.string(),
  notes: z.string(),
  referral_source: z.string(),
  referral_name: z.string(),
  referred_by_customer_id: z.number().int().nullable(),
  referred_by_customer_name: z.string().nullable().optional(),
  house_size: z.number().int().nullable(),
  primary_heating_source: z.string(),
  number_of_adults: z.number().int().nullable(),
  number_of_children: z.number().int().nullable(),
  household_income: z.number().nullable(),
  job_count: z.number().int().optional(),
  created_at: z.string(),
  updated_at: z.string(),
}).openapi("Customer");

// Rebate-profile fields are collected for rebate-track customers only ("do not
// assume these fields apply to every customer") and are treated as
// dispatcher/admin territory, same as job scheduling in Phase 2 — a technician
// can view a customer record but not edit income/household data. Referral
// attribution (referral_name/referred_by_customer_id) is the same "who
// referred this customer" concept referral_source already covers, just more
// detail — same RBAC boundary, not a separate decision.
const REBATE_PROFILE_FIELDS = new Set([
  "referral_source", "referral_name", "referred_by_customer_id",
  "house_size", "primary_heating_source", "number_of_adults", "number_of_children", "household_income",
]);

// Phase 11.3 — the subset of REBATE_PROFILE_FIELDS that now lives in
// bc_rebate_customer_profiles rather than directly on `customers` (referral
// fields are NOT part of this set — they remain generic Core columns, never
// HVAC/BC-specific, and are unaffected by this phase). Used to route these
// 5 fields to the profile-table write path instead of the generic
// customers UPDATE, and to exclude them from it.
const REBATE_COLUMN_FIELDS = new Set([
  "house_size", "primary_heating_source", "number_of_adults", "number_of_children", "household_income",
]);

// Phase 8.2 — Lead API. Field-for-field against the actual migration 0010
// schema (leads/lead_status_history), not against any imagined future shape:
// a single `name` column, no `company` field — see the Phase 8.1 finding
// (mem:backlog/p1-lead-management-pipeline) that this task brief's own
// restated schema (split first/last name + company) doesn't match the real
// migration. Preserved here rather than silently "fixed" either way.
const LeadSchema = z.object({
  id: z.number().int(),
  identifier: z.string(),
  name: z.string(),
  phone: z.string(),
  email: z.string(),
  address: z.string(),
  city: z.string(),
  state: z.string(),
  zip: z.string(),
  status: z.string(),
  assigned_user_id: z.number().int().nullable(),
  assigned_user_name: z.string().nullable().optional(),
  referral_source: z.string(),
  referral_name: z.string(),
  referred_by_customer_id: z.number().int().nullable(),
  referred_by_customer_name: z.string().nullable().optional(),
  program_interest: z.string().nullable(),
  estimated_value_cents: z.number().int().nullable(),
  estimate_notes: z.string(),
  lost_reason: z.string(),
  lost_reason_note: z.string(),
  converted_customer_id: z.number().int().nullable(),
  converted_at: z.string().nullable(),
  converted_by: z.number().int().nullable(),
  notes: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
}).openapi("Lead");

const LeadStatusHistorySchema = z.object({
  id: z.number().int(),
  lead_id: z.number().int(),
  old_status: z.string().nullable(),
  new_status: z.string(),
  actor_user_id: z.number().int().nullable(),
  reason: z.string(),
  created_at: z.string(),
}).openapi("LeadStatusHistory");

type Lead = z.infer<typeof LeadSchema>;

const TechnicianSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  email: z.string(),
  phone: z.string(),
  color: z.string(),
  active: z.number().int(),
  user_id: z.number().int().nullable(),
  user_email: z.string().nullable().optional(),
  job_count: z.number().int().optional(),
  created_at: z.string(),
}).openapi("Technician");

const ServiceTypeSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  description: z.string(),
  default_duration: z.number().int(),
  default_price: z.number(),
  color: z.string(),
  created_at: z.string(),
}).openapi("ServiceType");

const JobNoteSchema = z.object({
  id: z.number().int(),
  job_id: z.number().int(),
  content: z.string(),
  created_at: z.string(),
}).openapi("JobNote");

const JobSchema = z.object({
  id: z.number().int(),
  identifier: z.string(),
  customer_id: z.number().int(),
  technician_id: z.number().int().nullable(),
  service_type_id: z.number().int().nullable(),
  status: z.string(),
  job_type: z.string(),
  eligibility_code: z.string(),
  eligibility_code_expiry: z.string(),
  priority: z.string(),
  scheduled_date: z.string(),
  scheduled_time: z.string(),
  duration: z.number().int(),
  price: z.number(),
  address: z.string(),
  notes: z.string(),
  completion_notes: z.string(),
  is_recurring: z.number().int(),
  recurrence_interval: z.string(),
  next_recurrence_date: z.string(),
  customer_name: z.string().optional(),
  customer_phone: z.string().optional(),
  technician_name: z.string().nullable().optional(),
  technician_color: z.string().nullable().optional(),
  service_type_name: z.string().nullable().optional(),
  service_type_color: z.string().nullable().optional(),
  job_notes: z.array(JobNoteSchema).optional(),
  // Phase 10.2 — additive, nullable/optional: every existing consumer of
  // JobSchema (job-list, job-detail, etc.) is unaffected; only the new
  // Dispatcher Map view reads these. Sourced from the same `SELECT j.*`
  // every JobSchema-returning route already runs — Phase 10.0's migration
  // put these columns on `jobs` itself, so no query change was needed
  // anywhere, only this schema addition. `geocode_status` stays a plain
  // string (not a z.enum mirror of GeocodeStatus) matching this file's
  // own established precedent of never DB-CHECKing/schema-locking a status
  // vocabulary that's allowed to grow without a migration (see
  // migrations/0013's own comment).
  latitude: z.number().nullable().optional(),
  longitude: z.number().nullable().optional(),
  geocode_status: z.string().optional(),
  created_at: z.string(),
  updated_at: z.string(),
}).openapi("Job");

const MaterialSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  unit: z.string(),
  unit_cost: z.number(),
  in_stock: z.number(),
  created_at: z.string(),
});

type Customer = z.infer<typeof CustomerSchema>;
type Technician = z.infer<typeof TechnicianSchema>;
type ServiceType = z.infer<typeof ServiceTypeSchema>;
type JobNote = z.infer<typeof JobNoteSchema>;
type Job = z.infer<typeof JobSchema>;
type Material = z.infer<typeof MaterialSchema>;

interface ChecklistItem {
  id: number;
  job_id: number;
  label: string;
  checked: number;
  sort_order: number;
}

interface JobMaterial {
  id: number;
  job_id: number;
  material_id: number;
  quantity: number;
  unit_cost: number;
  material_name: string | null;
  material_unit: string | null;
}

const IdParam = z.object({ id: z.string().openapi({ description: "Resource ID" }) });

// Phase 9.3 — shared by the 4 new notification-history routes only (not a
// retrofit of the pre-existing list routes' own duplicated page/limit
// parsing, which is untouched). Same defensive clamp as listLeads (Phase
// 8.5) — a malformed page/limit must never reach D1's LIMIT/OFFSET raw.
const NotificationHistoryQuery = z.object({ page: z.string().optional(), limit: z.string().optional() });
function parseHistoryPagination(q: { page?: string; limit?: string }): { limit: number; offset: number } {
  const parsedPage = parseInt(q.page || "1", 10);
  const page = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  const parsedLimit = parseInt(q.limit || "25", 10);
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 100) : 25;
  return { limit, offset: (page - 1) * limit };
}

// ── Helpers ────────────────────────────────────────────────────────

async function nextIdentifier(): Promise<string> {
  const prefix = await get<{ value: string }>("SELECT value FROM _meta WHERE key = 'identifier_prefix'");
  const counter = await get<{ value: string }>("SELECT value FROM _meta WHERE key = 'job_counter'");
  const next = parseInt(counter?.value || "0", 10) + 1;
  await run("UPDATE _meta SET value = ? WHERE key = 'job_counter'", [String(next)]);
  return `${prefix?.value || "JOB"}-${next}`;
}

// ── Stats ──────────────────────────────────────────────────────────

const getStats = createRoute({
  method: "get",
  path: "/api/stats",
  responses: {
    200: {
      description: "Dashboard stats",
      content: { "application/json": { schema: z.object({
        jobs: z.number().int(),
        customers: z.number().int(),
        technicians: z.number().int(),
        service_types: z.number().int(),
        today_jobs: z.number().int(),
        upcoming_jobs: z.number().int(),
        completed_jobs: z.number().int(),
        revenue: z.number(),
        invoices_outstanding: z.number(),
        invoices_overdue: z.number(),
      }) } },
    },
  },
});

// Technicians get a scoped-to-own-work subset, never the company-wide
// aggregate — job/customer counts are legitimately useful to a technician
// (the sidebar's Today/Upcoming footer and Jobs/Customers nav badges render
// for every role, technician included) so those are recomputed with an
// `technician_id = ?` filter rather than just zeroed; `technicians`/
// `service_types` (no technician-facing UI reads either) and every
// financial field (revenue/invoices_outstanding/invoices_overdue — a
// technician has no financial access to ANY job, not even their own, per
// canManageFinancials()) are hard-zeroed. See mem:risks/technician-stats-financial-exposure.
async function scopedTechnicianStats(techId: number | null) {
  if (techId === null) {
    return {
      jobs: 0, customers: 0, technicians: 0, service_types: 0,
      today_jobs: 0, upcoming_jobs: 0, completed_jobs: 0,
      revenue: 0, invoices_outstanding: 0, invoices_overdue: 0,
    };
  }
  const today = new Date().toISOString().split("T")[0];
  const jobs = await get<{ count: number }>("SELECT COUNT(*) as count FROM jobs WHERE technician_id = ?", [techId]);
  const customers = await get<{ count: number }>(
    "SELECT COUNT(*) as count FROM customers WHERE id IN (SELECT customer_id FROM jobs WHERE technician_id = ?)", [techId]
  );
  const todayJobs = await get<{ count: number }>(
    "SELECT COUNT(*) as count FROM jobs WHERE technician_id = ? AND scheduled_date = ?", [techId, today]
  );
  const upcomingJobs = await get<{ count: number }>(
    `SELECT COUNT(*) as count FROM jobs WHERE technician_id = ? AND status IN (${PRE_WORK_STATUSES.map(() => "?").join(",")}) AND scheduled_date >= ?`,
    [techId, ...PRE_WORK_STATUSES, today]
  );
  const completedJobs = await get<{ count: number }>(
    "SELECT COUNT(*) as count FROM jobs WHERE technician_id = ? AND status = 'completed'", [techId]
  );
  return {
    jobs: jobs?.count || 0,
    customers: customers?.count || 0,
    technicians: 0,
    service_types: 0,
    today_jobs: todayJobs?.count || 0,
    upcoming_jobs: upcomingJobs?.count || 0,
    completed_jobs: completedJobs?.count || 0,
    revenue: 0,
    invoices_outstanding: 0,
    invoices_overdue: 0,
  };
}

app.openapi(getStats, async (c) => {
  const me = currentUser(c);
  if (me.role === "technician") {
    const techId = await actorTechnicianId({ id: me.id, role: me.role });
    return c.json(await scopedTechnicianStats(techId), 200);
  }

  // Phase 11.5: every company-wide aggregate below is scoped to the actor's
  // own organization — otherwise an admin/dispatcher of one organization
  // would see counts/revenue blended in from every other organization.
  const organizationId = actorOrganizationId(c);
  const jobs = await get<{ count: number }>("SELECT COUNT(*) as count FROM jobs WHERE organization_id = ?", [organizationId]);
  const customers = await get<{ count: number }>("SELECT COUNT(*) as count FROM customers WHERE organization_id = ?", [organizationId]);
  const technicians = await get<{ count: number }>("SELECT COUNT(*) as count FROM technicians WHERE organization_id = ? AND active = 1", [organizationId]);
  const serviceTypes = await get<{ count: number }>("SELECT COUNT(*) as count FROM service_types WHERE organization_id = ?", [organizationId]);
  const today = new Date().toISOString().split("T")[0];
  const todayJobs = await get<{ count: number }>("SELECT COUNT(*) as count FROM jobs WHERE organization_id = ? AND scheduled_date = ?", [organizationId, today]);
  const upcomingJobs = await get<{ count: number }>(
    `SELECT COUNT(*) as count FROM jobs WHERE organization_id = ? AND status IN (${PRE_WORK_STATUSES.map(() => "?").join(",")}) AND scheduled_date >= ?`,
    [organizationId, ...PRE_WORK_STATUSES, today]
  );
  const completedJobs = await get<{ count: number }>("SELECT COUNT(*) as count FROM jobs WHERE organization_id = ? AND status = 'completed'", [organizationId]);
  const revenue = await get<{ total: number }>("SELECT COALESCE(SUM(price), 0) as total FROM jobs WHERE organization_id = ? AND status = 'completed'", [organizationId]);
  return c.json({
    jobs: jobs?.count || 0,
    customers: customers?.count || 0,
    technicians: technicians?.count || 0,
    service_types: serviceTypes?.count || 0,
    today_jobs: todayJobs?.count || 0,
    upcoming_jobs: upcomingJobs?.count || 0,
    completed_jobs: completedJobs?.count || 0,
    revenue: revenue?.total || 0,
    // "outstanding" = issued and not yet fully paid. "overdue" is a computed
    // subset of that (past its due date) — status itself never stores
    // "overdue" (see migrations/0007), so this can never silently go stale
    // the way a stored status would.
    invoices_outstanding: (await get<{ count: number }>(
      "SELECT COUNT(*) as count FROM invoices WHERE organization_id = ? AND status IN ('issued', 'partially_paid')", [organizationId]
    ))?.count || 0,
    invoices_overdue: (await get<{ count: number }>(
      "SELECT COUNT(*) as count FROM invoices WHERE organization_id = ? AND status IN ('issued', 'partially_paid') AND due_date != '' AND due_date < ?", [organizationId, today]
    ))?.count || 0,
  }, 200);
});

// ── Jobs ───────────────────────────────────────────────────────────

const listJobs = createRoute({
  method: "get",
  path: "/api/jobs",
  request: {
    query: z.object({
      page: z.string().optional(),
      limit: z.string().optional(),
      search: z.string().optional(),
      status: z.string().optional(),
      date: z.string().optional(),
      technician_id: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Paginated job list",
      content: { "application/json": { schema: z.object({ jobs: z.array(JobSchema), total: z.number().int() }) } },
    },
  },
});

app.openapi(listJobs, async (c) => {
  const q = c.req.valid("query");
  const page = parseInt(q.page || "1", 10);
  const limit = parseInt(q.limit || "50", 10);
  const offset = (page - 1) * limit;

  let where = "WHERE j.organization_id = ?";
  const params: unknown[] = [actorOrganizationId(c)];

  if (q.search) {
    // Matches the search-box placeholder's promise ("...customer, job number,
    // address, or phone") — phone was missing here (job number/customer/
    // address only) until this UI-review pass added it.
    where += " AND (j.identifier LIKE ? OR c.name LIKE ? OR j.address LIKE ? OR c.phone LIKE ?)";
    const s = `%${q.search}%`;
    params.push(s, s, s, s);
  }
  if (q.status) {
    where += " AND j.status = ?";
    params.push(q.status);
  }
  if (q.date) {
    where += " AND j.scheduled_date = ?";
    params.push(q.date);
  }
  // P1 fix (mem:risks/technician-job-read-scoping): a technician's own linked
  // technician id — resolved from the AUTHENTICATED SESSION, never from the
  // client-supplied ?technician_id= query param — always wins for a
  // technician actor. admin/dispatcher keep the existing behavior (an
  // optional client-supplied filter, unchanged).
  const me = currentUser(c);
  if (me.role === "technician") {
    const techId = await actorTechnicianId({ id: me.id, role: me.role });
    if (techId === null) return c.json({ jobs: [], total: 0 }, 200);
    where += " AND j.technician_id = ?";
    params.push(techId);
  } else if (q.technician_id) {
    where += " AND j.technician_id = ?";
    params.push(q.technician_id);
  }

  const countRow = await get<{ count: number }>(
    `SELECT COUNT(*) as count FROM jobs j LEFT JOIN customers c ON j.customer_id = c.id ${where}`,
    params
  );

  const jobs = await query<Job>(
    `SELECT j.*, c.name as customer_name, c.phone as customer_phone,
       t.name as technician_name, t.color as technician_color,
       st.name as service_type_name, st.color as service_type_color
     FROM jobs j
     LEFT JOIN customers c ON j.customer_id = c.id
     LEFT JOIN technicians t ON j.technician_id = t.id
     LEFT JOIN service_types st ON j.service_type_id = st.id
     ${where}
     ORDER BY j.scheduled_date ASC, j.scheduled_time ASC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  return c.json({ jobs, total: countRow?.count || 0 }, 200);
});

// Registered here, before GET /api/jobs/{id}, deliberately: both are single
// path-segment routes under /api/jobs/, and Hono matches in registration order
// — if this came after {id}, "/api/jobs/eligibility-codes" would be swallowed
// by {id} (id="eligibility-codes") and 404 as "Job not found" instead of ever
// reaching this handler. (Caught this exact bug via a live curl check.)
const EligibilityCodeRowSchema = z.object({
  id: z.number().int(),
  identifier: z.string(),
  status: z.string(),
  eligibility_code: z.string(),
  eligibility_code_expiry: z.string(),
  customer_name: z.string().nullable(),
  technician_name: z.string().nullable(),
  code_status: z.enum(["active", "expiring_soon", "expired", "submitted"]),
  days_remaining: z.number().int().nullable(),
});

const listEligibilityCodesRoute = createRoute({
  method: "get",
  path: "/api/jobs/eligibility-codes",
  responses: {
    200: {
      description: "CleanBC eligibility code tracker",
      content: { "application/json": { schema: z.object({ rows: z.array(EligibilityCodeRowSchema), warning_days_configured: z.boolean() }) } },
    },
  },
});

app.openapi(listEligibilityCodesRoute, async (c) => {
  const { rows, warningDaysConfigured } = await listEligibilityCodes(actorOrganizationId(c));
  // P1 fix (mem:risks/technician-job-read-scoping): this tracker previously
  // exposed every CleanBC job's customer name, technician name, and code
  // company-wide to any authenticated role, including technicians —
  // narrowed to the caller's own jobs for that role, same as every other
  // job-list read. technician_id was only added to the row shape for this
  // filter; it's stripped back out below since the response schema never
  // included it and the client UI never rendered it.
  const me = currentUser(c);
  let visible = rows;
  if (me.role === "technician") {
    const techId = await actorTechnicianId({ id: me.id, role: me.role });
    visible = techId === null ? [] : rows.filter((r) => r.technician_id === techId);
  }
  const scrubbed = visible.map((r) => ({
    id: r.id, identifier: r.identifier, status: r.status,
    eligibility_code: r.eligibility_code, eligibility_code_expiry: r.eligibility_code_expiry,
    customer_name: r.customer_name, technician_name: r.technician_name,
    code_status: r.code_status, days_remaining: r.days_remaining,
  }));
  return c.json({ rows: scrubbed, warning_days_configured: warningDaysConfigured }, 200);
});

const getJob = createRoute({
  method: "get",
  path: "/api/jobs/{id}",
  request: { params: IdParam },
  responses: {
    200: { description: "Job detail", content: { "application/json": { schema: z.object({ job: JobSchema }) } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(getJob, async (c) => {
  const { id } = c.req.valid("param");
  const job = await get<Job>(
    `SELECT j.*, c.name as customer_name, c.phone as customer_phone,
       t.name as technician_name, t.color as technician_color,
       st.name as service_type_name, st.color as service_type_color
     FROM jobs j
     LEFT JOIN customers c ON j.customer_id = c.id
     LEFT JOIN technicians t ON j.technician_id = t.id
     LEFT JOIN service_types st ON j.service_type_id = st.id
     WHERE j.id = ? AND j.organization_id = ?`,
    [id, actorOrganizationId(c)]
  );
  if (!job) return c.json({ error: "Job not found" }, 404);
  // P1 fix (mem:risks/technician-job-read-scoping): reuses the exact same
  // ownership predicate compliance sub-resources already use — a technician
  // may read a job only if it's assigned to them, admin/dispatcher unchanged.
  const me = currentUser(c);
  if (!(await canActorAccessJobCompliance({ id: me.id, role: me.role }, job))) {
    return c.json({ error: "You are not permitted to view this job" }, 403);
  }
  const notes = await query<JobNote>(
    "SELECT * FROM job_notes WHERE job_id = ? ORDER BY created_at DESC", [id]
  );
  const checklist = await query<ChecklistItem>(
    "SELECT * FROM job_checklist WHERE job_id = ? ORDER BY sort_order ASC", [id]
  );
  const jobMaterials = await query<JobMaterial>(
    `SELECT jm.*, m.name as material_name, m.unit as material_unit
     FROM job_materials jm LEFT JOIN materials m ON jm.material_id = m.id
     WHERE jm.job_id = ? ORDER BY jm.id ASC`, [id]
  );
  return c.json({ job: { ...job, job_notes: notes, checklist, job_materials: jobMaterials } }, 200);
});

const createJob = createRoute({
  method: "post",
  path: "/api/jobs",
  request: {
    body: {
      content: { "application/json": { schema: z.object({
        customer_id: z.number().int(),
        technician_id: z.number().int().nullable().optional(),
        service_type_id: z.number().int().nullable().optional(),
        job_type: z.enum(JOB_TYPES as [JobType, ...JobType[]]).optional(),
        priority: z.string().optional(),
        scheduled_date: z.string(),
        scheduled_time: z.string().optional(),
        duration: z.number().int().optional(),
        price: z.number().optional(),
        address: z.string().optional(),
        notes: z.string().optional(),
        is_recurring: z.number().int().optional(),
        recurrence_interval: z.string().optional(),
      }).strict() } },
    },
  },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: JobSchema } } },
    400: { description: "Invalid scheduling data", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Customer not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Scheduling conflict", content: { "application/json": { schema: ScheduleConflictSchema } } },
  },
});

app.openapi(createJob, async (c) => {
  // Phase 7.2 security fix: this route previously had NO role check at
  // all — any authenticated role, including technician, could create a job
  // for any customer and assign it to any active technician. The RBAC gate
  // runs FIRST, before nextIdentifier() or any database write (nextIdentifier()
  // itself mutates the _meta counter), matching every other write route in
  // this file and specifically the "RBAC before mutation" requirement — see
  // mem:risks/job-creation-rbac. `.strict()` added to match updateJob's
  // existing convention on this same resource: an unrecognized field
  // (status/actor_user_id/role/etc.) is now rejected with 400 rather than
  // silently stripped, though it was already never trusted either way
  // (schema never declared those fields, so Zod's default non-strict
  // behavior already discarded them before this fix — this only makes that
  // discard loud instead of silent).
  const me = currentUser(c);
  if (me.role === "technician") {
    return c.json({ error: "Technicians cannot create jobs — contact a dispatcher" }, 403);
  }

  const data = c.req.valid("json");
  const organizationId = actorOrganizationId(c);

  try {
    validateScheduleFields(data);
  } catch (err) {
    if (err instanceof ScheduleValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
  if (data.technician_id !== undefined && data.technician_id !== null) {
    try {
      await assertTechnicianAssignable(organizationId, data.technician_id);
    } catch (err) {
      if (err instanceof ScheduleValidationError) return c.json({ error: err.message }, 400);
      throw err;
    }
  }

  // Phase 11.5: the customer this job is for must belong to the actor's own
  // organization — otherwise a caller could attach a job to another
  // organization's customer entirely.
  const ownedCustomer = await get<{ address: string; city: string; state: string; zip: string }>(
    "SELECT address, city, state, zip FROM customers WHERE id = ? AND organization_id = ?", [data.customer_id, organizationId]
  );
  if (!ownedCustomer) return c.json({ error: "Customer not found" }, 404);

  const identifier = await nextIdentifier();
  // Status is never client-supplied at creation — it's always the entry status
  // for the job's workflow (see src/server/workflow.ts), so a job can never be
  // created already sitting at, say, "completed" or "gov_portal_submitted".
  const jobType: JobType = data.job_type ?? "STANDARD";
  const initialStatus = entryStatus(jobType);

  // If address is empty, use customer address (already org-verified above)
  let address = data.address || "";
  if (!address) {
    address = [ownedCustomer.address, ownedCustomer.city, ownedCustomer.state, ownedCustomer.zip].filter(Boolean).join(", ");
  }

  // Default price/duration from service type — also org-verified, so a
  // client can't probe another organization's service-type pricing via
  // this route either.
  let duration = data.duration || 60;
  let price = data.price || 0;
  if (data.service_type_id && (!data.duration || !data.price)) {
    const st = await get<{ default_duration: number; default_price: number }>(
      "SELECT default_duration, default_price FROM service_types WHERE id = ? AND organization_id = ?", [data.service_type_id, organizationId]
    );
    if (st) {
      if (!data.duration) duration = st.default_duration;
      if (!data.price) price = st.default_price;
    }
  }

  // Conflict-checked only once technician_id is known AND duration is fully
  // resolved (service-type defaults included) — an unavoidable identifier
  // may already have been allocated above if this rejects, same pre-existing
  // cost as any other post-nextIdentifier() creation failure in this route
  // (e.g. a nonexistent customer_id), not a new regression.
  if (data.technician_id) {
    try {
      await checkScheduleConflict(data.technician_id, data.scheduled_date, data.scheduled_time || "09:00", duration, null);
    } catch (err) {
      if (err instanceof ScheduleConflictError) return c.json({ error: err.message, conflict: err.conflict }, 409);
      throw err;
    }
  }

  await run(
    `INSERT INTO jobs (identifier, organization_id, customer_id, technician_id, service_type_id, status, job_type, priority,
       scheduled_date, scheduled_time, duration, price, address, notes, is_recurring, recurrence_interval)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      identifier,
      organizationId,
      data.customer_id,
      data.technician_id ?? null,
      data.service_type_id ?? null,
      initialStatus,
      jobType,
      data.priority || "normal",
      data.scheduled_date,
      data.scheduled_time || "09:00",
      duration,
      price,
      address,
      data.notes || "",
      data.is_recurring || 0,
      data.recurrence_interval || "",
    ]
  );

  const job = await get<Job>(
    `SELECT j.*, c.name as customer_name, c.phone as customer_phone,
       t.name as technician_name, t.color as technician_color,
       st.name as service_type_name, st.color as service_type_color
     FROM jobs j
     LEFT JOIN customers c ON j.customer_id = c.id
     LEFT JOIN technicians t ON j.technician_id = t.id
     LEFT JOIN service_types st ON j.service_type_id = st.id
     WHERE j.identifier = ?`,
    [identifier]
  );
  // Audit trail entry for the job's initial status — not a "transition" through
  // transitionJob() (there's no prior status to move from), but job_status_history
  // should still read as a complete record from creation onward. `me` is the
  // same real session user resolved at the top of this handler (never a
  // client-supplied actor id).
  await run(
    "INSERT INTO job_status_history (job_id, from_status, to_status, actor_user_id, reason) VALUES (?, NULL, ?, ?, ?)",
    [job!.id, initialStatus, me.id, "Job created"]
  );
  // Google Calendar sync is best-effort: syncJobToAllConnectedUsers never throws,
  // so a Google outage or misconfiguration can never stop a job from being created.
  await syncJobToAllConnectedUsers(googleEnv(c), job!.id);
  // Phase 9.1 — appointment confirmation. Every job has a scheduled_date
  // (NOT NULL) and a scheduled_time (defaults to "09:00") the moment it's
  // created, regardless of whether a technician is assigned yet — "you're
  // booked for this date/time" is true independent of internal staffing,
  // so this is not gated on technician_id. Best-effort: a notification
  // problem must never fail or roll back a successful job creation.
  await safeEnqueue(async () => {
    const contact = await getCustomerContact(job!.customer_id);
    if (!contact) return;
    await enqueueAppointmentConfirmation({
      jobId: job!.id, jobIdentifier: job!.identifier,
      customerId: job!.customer_id, customerName: contact.name, customerEmail: contact.email, customerPhone: contact.phone,
      scheduledDate: job!.scheduled_date, scheduledTime: job!.scheduled_time,
    });
  });
  return c.json(job!, 201);
});

const updateJob = createRoute({
  method: "put",
  path: "/api/jobs/{id}",
  request: {
    params: IdParam,
    body: {
      content: { "application/json": { schema: z.object({
        customer_id: z.number().int().optional(),
        technician_id: z.number().int().nullable().optional(),
        service_type_id: z.number().int().nullable().optional(),
        priority: z.string().optional(),
        scheduled_date: z.string().optional(),
        scheduled_time: z.string().optional(),
        duration: z.number().int().optional(),
        price: z.number().optional(),
        address: z.string().optional(),
        notes: z.string().optional(),
        completion_notes: z.string().optional(),
        is_recurring: z.number().int().optional(),
        recurrence_interval: z.string().optional(),
      }).strict() } },
    },
  },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: OkSchema } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Scheduling conflict", content: { "application/json": { schema: ScheduleConflictSchema } } },
  },
});

// Fields that change WHEN or WHO works a job — kept separate from ordinary fields
// so they can be gated by role independently of them (see updateJob below). Status
// is not in either bucket: it's not part of this route's schema at all (rejected by
// .strict() above) because it can ONLY change through POST /api/jobs/{id}/transition.
const SCHEDULING_FIELDS = new Set(["scheduled_date", "scheduled_time", "duration", "technician_id"]);

app.openapi(updateJob, async (c) => {
  // P0/P1 security fix (mem:risks/job-update-ownership-bypass): this route
  // previously only gated SCHEDULING_FIELDS for a technician actor — every
  // OTHER field (customer_id, price, notes, priority, address,
  // completion_notes, is_recurring, recurrence_interval) had no check
  // whatsoever, so a technician could rewrite any job's price/notes/
  // customer relationship, including a job they aren't even assigned to
  // and cannot read. Traced every client call site (job-detail.tsx,
  // schedule-edit-modal.tsx, technician mobile) before this fix: NONE of
  // them ever call PUT /api/jobs/{id} on behalf of a technician actor —
  // there is no legitimate technician use of this route today, ownership
  // of the job included. A field-level or ownership-scoped allowlist would
  // therefore be inventing a permission that doesn't exist anywhere in this
  // codebase; the correct, smallest, safest fix is an unconditional block,
  // matching this task's own explicit guidance for exactly this situation.
  // Runs first, before any query (including the existence lookup) or
  // mutation — a technician gets 403 without the route ever touching the
  // database, so no identifier/audit/Calendar side effect can ever fire
  // for a denied request.
  const me = currentUser(c);
  if (me.role === "technician") {
    return c.json({ error: "Technicians cannot edit jobs — contact a dispatcher" }, 403);
  }

  const { id } = c.req.valid("param");
  const data = c.req.valid("json");
  const organizationId = actorOrganizationId(c);
  const existing = await get<Job>("SELECT * FROM jobs WHERE id = ? AND organization_id = ?", [id, organizationId]);
  if (!existing) return c.json({ error: "Job not found" }, 404);
  // Phase 11.5: a client-supplied customer_id reassignment must stay within
  // the job's own organization — otherwise a job could be attached to
  // another organization's customer entirely.
  if (data.customer_id !== undefined) {
    const ownedCustomer = await get<{ id: number }>(
      "SELECT id FROM customers WHERE id = ? AND organization_id = ?", [data.customer_id, organizationId]
    );
    if (!ownedCustomer) return c.json({ error: "Customer not found" }, 404);
  }

  // Phase 7 — Advanced Scheduler: only computed/validated when this request
  // actually touches a scheduling field — an ordinary field-only edit (notes,
  // price, priority, ...) never runs any of this and never writes a
  // job_schedule_history row (scheduleChanged() below is what enforces that).
  // Note: admin/dispatcher only ever reach this point — a technician actor
  // is already fully blocked above, so SCHEDULING_FIELDS no longer needs a
  // role check of its own here.
  const touchesSchedule = Object.keys(data).some((k) => SCHEDULING_FIELDS.has(k) && data[k as keyof typeof data] !== undefined);
  let scheduleBefore: ScheduleSnapshot | null = null;
  let scheduleAfter: ScheduleSnapshot | null = null;
  if (touchesSchedule) {
    try {
      validateScheduleFields(data);
    } catch (err) {
      if (err instanceof ScheduleValidationError) return c.json({ error: err.message }, 400);
      throw err;
    }

    // "Effective state" resolution — same pattern as the referral-attribution
    // validator (src/server/customers.ts): a partial PUT only sends the
    // field(s) actually changing, so the conflict check must reflect the
    // job's true post-update state, not just the literal fields in this
    // one request.
    scheduleBefore = {
      technician_id: existing.technician_id, scheduled_date: existing.scheduled_date,
      scheduled_time: existing.scheduled_time, duration: existing.duration,
    };
    scheduleAfter = {
      technician_id: data.technician_id !== undefined ? data.technician_id : existing.technician_id,
      scheduled_date: data.scheduled_date !== undefined ? data.scheduled_date : existing.scheduled_date,
      scheduled_time: data.scheduled_time !== undefined ? data.scheduled_time : existing.scheduled_time,
      duration: data.duration !== undefined ? data.duration : existing.duration,
    };

    // Only re-validated when technician_id is actually being SET/changed in
    // THIS request — an unrelated edit to a job whose already-assigned
    // technician later went inactive must keep working (no silent
    // reassignment, no forced failure — see scheduling.ts).
    if (data.technician_id !== undefined && data.technician_id !== null) {
      try {
        await assertTechnicianAssignable(actorOrganizationId(c), data.technician_id);
      } catch (err) {
        if (err instanceof ScheduleValidationError) return c.json({ error: err.message }, 400);
        throw err;
      }
    }

    if (scheduleAfter.technician_id !== null) {
      try {
        await checkScheduleConflict(
          scheduleAfter.technician_id, scheduleAfter.scheduled_date, scheduleAfter.scheduled_time,
          scheduleAfter.duration, Number(id)
        );
      } catch (err) {
        if (err instanceof ScheduleConflictError) return c.json({ error: err.message, conflict: err.conflict }, 409);
        throw err;
      }
    }
  }

  const fields: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined) {
      fields.push(`${k} = ?`);
      vals.push(v);
    }
  }
  // Phase 10.0 — if the Job's own service address actually changes, any
  // coordinates resolved for the OLD address must never be silently
  // trusted as still describing the new one (see
  // mem:phase10/maps-routing-architecture-audit's address-change
  // semantics). Server-side, not left to the UI to remember. Compared
  // against the existing row, not just "address is present in this
  // request" — an edit that resubmits the same unchanged address must not
  // discard a perfectly good, already-resolved geocode.
  const addressChanged = data.address !== undefined && data.address !== existing.address;
  if (addressChanged) {
    fields.push("latitude = NULL", "longitude = NULL", "geocoded_at = NULL", "geocode_status = 'pending'");
  }
  if (fields.length > 0) {
    fields.push("updated_at = datetime('now')");
    await run(`UPDATE jobs SET ${fields.join(", ")} WHERE id = ?`, [...vals, id]);
    if (scheduleBefore && scheduleAfter && scheduleChanged(scheduleBefore, scheduleAfter)) {
      await recordScheduleHistory(Number(id), scheduleBefore, scheduleAfter, me.id, "Updated via PUT /api/jobs/{id}");
      // Phase 9.1 — appointment rescheduled. Only fires when scheduling data
      // actually changed (scheduleChanged() above is the same predicate
      // job_schedule_history itself uses) — reassigning only the technician
      // with no date/time change still reaches here (scheduleChanged() also
      // covers technician_id), which is intentional: the customer's own
      // appointment slot notification concept is about "who/when", not just
      // "when". Independent of Google Calendar sync below — both react to
      // the same mutation but neither depends on the other.
      await safeEnqueue(async () => {
        const contact = await getCustomerContact(existing.customer_id);
        const historyId = await latestScheduleHistoryId(Number(id));
        if (!contact || historyId === null) return;
        await enqueueAppointmentRescheduled({
          jobId: Number(id), jobIdentifier: existing.identifier,
          customerId: existing.customer_id, customerName: contact.name, customerEmail: contact.email, customerPhone: contact.phone,
          oldDate: scheduleBefore.scheduled_date, oldTime: scheduleBefore.scheduled_time,
          newDate: scheduleAfter.scheduled_date, newTime: scheduleAfter.scheduled_time,
          scheduleHistoryId: historyId,
        });
      });
    }
    // Covers rescheduled/reassigned/edited — the sync engine diffs against the
    // stored mapping to decide create vs. update vs. delete, so no duplicates.
    // Status changes never reach this route (see the .strict() schema above), so
    // this is the ONLY sync call a non-status edit triggers — transitionJob()
    // triggers its own single sync call for status changes, never both at once.
    await syncJobToAllConnectedUsers(googleEnv(c), Number(id));
  }
  return c.json({ ok: true }, 200);
});

const deleteJob = createRoute({
  method: "delete",
  path: "/api/jobs/{id}",
  request: { params: IdParam },
  responses: {
    200: { description: "Deleted", content: { "application/json": { schema: OkSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(deleteJob, async (c) => {
  const me = currentUser(c);
  if (me.role === "technician") return c.json({ error: "Forbidden" }, 403);

  const { id } = c.req.valid("param");
  const owned = await get<{ id: number }>(
    "SELECT id FROM jobs WHERE id = ? AND organization_id = ?", [id, actorOrganizationId(c)]
  );
  if (!owned) return c.json({ ok: true }, 200); // matches this route's pre-existing no-op-on-unknown-id behavior
  // Must run before the local delete: calendar_event_mappings cascades away with the
  // job row, taking the external_event_id with it, so Google cleanup has to happen first.
  await deleteJobFromAllCalendars(googleEnv(c), Number(id));
  await run("DELETE FROM jobs WHERE id = ?", [id]);
  return c.json({ ok: true }, 200);
});

// ── Job Workflow (status transitions) ───────────────────────────────
// The ONLY way a job's status can change — see src/server/workflow.ts for the
// authoritative transition rules. PUT /api/jobs/{id} above cannot touch status
// at all (rejected by its .strict() schema).

async function loadWorkflowJob(organizationId: number, id: string | number) {
  return get<{ id: number; status: string; job_type: string; technician_id: number | null; eligibility_code: string; eligibility_code_expiry: string }>(
    "SELECT id, status, job_type, technician_id, eligibility_code, eligibility_code_expiry FROM jobs WHERE id = ? AND organization_id = ?",
    [id, organizationId]
  );
}

const getJobTransitions = createRoute({
  method: "get",
  path: "/api/jobs/{id}/transitions",
  request: { params: IdParam },
  responses: {
    200: { description: "Allowed next statuses for this job, for this actor", content: { "application/json": { schema: z.object({ allowed: z.array(z.string()) }) } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(getJobTransitions, async (c) => {
  const { id } = c.req.valid("param");
  const job = await loadWorkflowJob(actorOrganizationId(c), id);
  if (!job) return c.json({ error: "Job not found" }, 404);
  const me = currentUser(c);
  const allowed = await allowedTransitionsForActor({ id: me.id, role: me.role }, job);
  return c.json({ allowed }, 200);
});

const getJobCanComplete = createRoute({
  method: "get",
  path: "/api/jobs/{id}/can-complete",
  request: { params: IdParam },
  responses: {
    200: {
      description: "Whether this job currently satisfies completion requirements",
      content: { "application/json": { schema: z.object({
        allowed: z.boolean(),
        requirements: z.array(z.object({ key: z.string(), label: z.string(), satisfied: z.boolean() })),
      }) } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(getJobCanComplete, async (c) => {
  const { id } = c.req.valid("param");
  const job = await loadWorkflowJob(actorOrganizationId(c), id);
  if (!job) return c.json({ error: "Job not found" }, 404);
  return c.json(await canCompleteJob(job), 200);
});

const transitionJobRoute = createRoute({
  method: "post",
  path: "/api/jobs/{id}/transition",
  request: {
    params: IdParam,
    body: {
      content: { "application/json": { schema: z.object({
        to_status: z.string(),
        reason: z.string().optional(),
        eligibility_code: z.string().optional(),
        eligibility_code_expiry: z.string().optional(),
      }) } },
    },
  },
  responses: {
    200: { description: "Transitioned", content: { "application/json": { schema: z.object({ job: JobSchema }) } } },
    400: { description: "Missing required data", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Invalid transition for the job's current status", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(transitionJobRoute, async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const me = currentUser(c);
  const organizationId = actorOrganizationId(c);
  const actor: Actor = { id: me.id, role: me.role };
  const attemptingCompletion = body.to_status === "completed";
  // job_compliance_audit.job_id is a real FK (this D1 database enforces
  // foreign keys — verified, not assumed) — never record an event against an
  // id that might not exist. A cheap existence check up front avoids that
  // without duplicating transitionJob()'s own (more thorough) lookup.
  const jobExists = attemptingCompletion
    ? !!(await get<{ id: number }>("SELECT id FROM jobs WHERE id = ? AND organization_id = ?", [id, organizationId]))
    : false;

  // Compliance auditability (Phase 4): the completion gate itself lives in
  // workflow.ts's canCompleteJob(), called from inside transitionJob() below —
  // this route only records that an attempt happened and how it resolved, it
  // does not duplicate any validation. Recorded for "completed" specifically
  // since that's the only transition Phase 4 added requirements to.
  if (jobExists) await recordComplianceEvent(Number(id), "completion_attempted", me.id, {});

  try {
    await transitionJob(c.env.DB, Number(id), actor, {
      toStatus: body.to_status,
      organizationId,
      reason: body.reason,
      eligibilityCode: body.eligibility_code,
      eligibilityCodeExpiry: body.eligibility_code_expiry,
    });
  } catch (err) {
    if (err instanceof WorkflowError) {
      if (jobExists) {
        await recordComplianceEvent(Number(id), "completion_rejected", me.id, { reason: err.message });
      }
      const statusMap = { not_found: 404, invalid_transition: 409, forbidden: 403, missing_data: 400 } as const;
      return c.json({ error: err.message }, statusMap[err.code]);
    }
    throw err;
  }

  if (attemptingCompletion) {
    await recordComplianceEvent(Number(id), "completion_succeeded", me.id, {});
    // Phase 5: idempotent invoice generation — best-effort, non-fatal. The
    // job has already legitimately reached "completed" by this point (the
    // transition above succeeded); a failure here must not undo that or fail
    // this response, since transitionJob()'s own db.batch() already
    // committed. Recovery if this ever throws: the existing "Create Invoice"
    // button (POST /api/jobs/{id}/invoice) calls the exact same idempotent
    // generateInvoiceForJob() and is always safe to retry.
    try {
      await generateInvoiceForJob(c.env.DB, Number(id), me.id);
    } catch {
      // swallowed deliberately — see comment above
    }
  }

  const job = await get<Job>(
    `SELECT j.*, c.name as customer_name, c.phone as customer_phone,
       t.name as technician_name, t.color as technician_color,
       st.name as service_type_name, st.color as service_type_color
     FROM jobs j
     LEFT JOIN customers c ON j.customer_id = c.id
     LEFT JOIN technicians t ON j.technician_id = t.id
     LEFT JOIN service_types st ON j.service_type_id = st.id
     WHERE j.id = ? AND j.organization_id = ?`,
    [id, organizationId]
  );
  // Phase 9.1 — cancellation / post-job survey notifications. Both use the
  // specific job_status_history row id for THIS transition (not job.id
  // alone) since a job can legitimately reach either status more than once
  // (cancel -> reopen -> cancel again; completed after a cancel+reopen) —
  // see notifications.ts's doc comments. Independent of transitionJob()'s
  // own history write and of Google Calendar sync below.
  if (body.to_status === "cancelled" || body.to_status === "completed") {
    await safeEnqueue(async () => {
      const contact = await getCustomerContact(job!.customer_id);
      const historyId = await latestStatusHistoryId(Number(id), body.to_status);
      if (!contact || historyId === null) return;
      const jobInfo = {
        jobId: Number(id), jobIdentifier: job!.identifier,
        customerId: job!.customer_id, customerName: contact.name, customerEmail: contact.email, customerPhone: contact.phone,
      };
      if (body.to_status === "cancelled") {
        await enqueueAppointmentCancelled({ ...jobInfo, statusHistoryId: historyId });
      } else {
        await enqueuePostJobSurvey({ ...jobInfo, statusHistoryId: historyId });
      }
    });
  }
  // The only sync call this route triggers — see the comment on PUT /api/jobs/{id}
  // above for why a single status-changing request never fires sync twice.
  await syncJobToAllConnectedUsers(googleEnv(c), Number(id));
  return c.json({ job: job! }, 200);
});

// ── Job notification history (Phase 9.3) ─────────────────────────────
// Blanket technician block, NOT the usual own-job read-scoping every other
// Job route uses — Section 17 of this phase's spec explicitly says not to
// broaden technician access to company-wide-shaped notification data
// without an explicit approval, and none was given for Job Detail
// specifically. This is intentionally MORE restrictive than ordinary job
// reads, not an oversight.

const getJobNotifications = createRoute({
  method: "get",
  path: "/api/jobs/{id}/notifications",
  request: { params: IdParam, query: NotificationHistoryQuery },
  responses: {
    200: { description: "Notification history", content: { "application/json": { schema: z.any() } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(getJobNotifications, async (c) => {
  const me = currentUser(c);
  if (me.role === "technician") return c.json({ error: "Forbidden" }, 403);
  const { id } = c.req.valid("param");
  const job = await get<{ id: number }>("SELECT id FROM jobs WHERE id = ? AND organization_id = ?", [id, actorOrganizationId(c)]);
  if (!job) return c.json({ error: "Job not found" }, 404);
  const { limit, offset } = parseHistoryPagination(c.req.valid("query"));
  const page = await getJobNotificationHistory(Number(id), limit, offset);
  return c.json(page, 200);
});

// ── Technician Compliance (photos, report, signature) ───────────────
// Extends the Phase 2 completion gate — canCompleteJob() in workflow.ts reads
// these tables directly, so nothing here duplicates transition validation.
// RBAC reuses canActorAccessJobCompliance() from workflow.ts (assigned
// technician only, or admin/dispatcher) rather than reimplementing the
// technicians.user_id ownership check. Reads (list photos, view report,
// audit) are open to any authenticated role, matching how job details are
// already visible broadly — only writes are ownership-gated, same split as
// every other phase. Photo/signature bytes live in R2 (src/server/storage.ts);
// D1 only ever stores object keys, never raw bytes or credentials.

async function loadComplianceJob(organizationId: number, id: string | number) {
  return get<{ id: number; technician_id: number | null; status: string }>(
    "SELECT id, technician_id, status FROM jobs WHERE id = ? AND organization_id = ?", [id, organizationId]
  );
}

function completedOrLater(status: string): boolean {
  return status === "completed" || isTerminalStatus(status);
}

// Phase 9.1 — "Technician on the way" (approved decision: a manual
// technician action, deliberately NOT auto-tied to the "in_progress"
// transition). Server/domain capability only — no UI this phase (Phase
// 9.3). RBAC reuses canActorAccessJobCompliance() verbatim (admin/
// dispatcher, or the job's own assigned technician) — the exact same
// ownership rule every other technician-facing job mutation in this file
// already uses, not a new authorization mechanism. Body is a genuinely
// empty `.strict()` object, same "no arbitrary messaging" discipline as
// Lead conversion's POST /api/leads/{id}/convert — there is nothing
// legitimate for a client to send.
const onTheWayRoute = createRoute({
  method: "post",
  path: "/api/jobs/{id}/on-the-way",
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: z.object({}).strict() } } },
  },
  responses: {
    200: { description: "Notification enqueued (best-effort)", content: { "application/json": { schema: OkSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(onTheWayRoute, async (c) => {
  const { id } = c.req.valid("param");
  const job = await loadComplianceJob(actorOrganizationId(c), id);
  if (!job) return c.json({ error: "Job not found" }, 404);

  const me = currentUser(c);
  if (!(await canActorAccessJobCompliance({ id: me.id, role: me.role }, job))) {
    return c.json({ error: "You are not permitted to send this notification for this job" }, 403);
  }

  // No status mutation, no workflow interaction whatsoever — this route
  // touches nothing but the notification outbox. Best-effort: this action
  // always reports success to the caller even if the notification itself
  // was skipped (no phone on file, SMS not opted in, etc.) — the technician
  // does not need to know or care about consent internals.
  await safeEnqueue(async () => {
    const full = await get<{ customer_id: number; identifier: string; technician_id: number | null }>(
      "SELECT customer_id, identifier, technician_id FROM jobs WHERE id = ? AND organization_id = ?", [id, actorOrganizationId(c)]
    );
    if (!full) return;
    const [contact, tech] = await Promise.all([
      getCustomerContact(full.customer_id),
      full.technician_id
        ? get<{ name: string }>("SELECT name FROM technicians WHERE id = ?", [full.technician_id])
        : Promise.resolve(null),
    ]);
    if (!contact) return;
    await enqueueOnTheWay({
      jobId: Number(id), jobIdentifier: full.identifier,
      customerId: full.customer_id, customerName: contact.name, customerEmail: contact.email, customerPhone: contact.phone,
      technicianName: tech?.name || "Your technician",
      triggeredOnDate: new Date().toISOString().slice(0, 10),
    });
  });

  return c.json({ ok: true }, 200);
});

// Phase 10.1 — the one narrow operational trigger for real geocoding
// (mem:phase10/maps-routing-architecture-audit's approved 10.1 boundary: no
// arbitrary-address proxy, no lat/lng/provider mass assignment). RBAC is a
// plain role check, admin/dispatcher only — deliberately NOT
// canActorAccessJobCompliance()'s ownership rule: geocoding is an
// operational/dispatch concern, not a technician-facing action, and a
// technician has no legitimate reason to trigger a paid external API call.
// Runs BEFORE the job existence lookup (same discipline as updateJob's
// P0/P1 fix) so a denied technician produces zero DB queries and zero
// provider calls, not just zero provider calls. Body is a genuinely empty
// `.strict()` object — same "no arbitrary messaging" shape as
// POST /api/jobs/{id}/on-the-way and POST /api/leads/{id}/convert. The
// server loads the Job's own `address` itself (via geocodeJob() ->
// provider); a client can never supply address/latitude/longitude/
// provider/api_key/actor_user_id/force — there is no field on this route
// for any of them to bind to.
const geocodeJobResponseSchema = z.object({
  ok: z.boolean(),
  geocode_status: z.enum(["pending", "geocoded", "failed"]),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
}).openapi("GeocodeJobResult");

const geocodeJobRoute = createRoute({
  method: "post",
  path: "/api/jobs/{id}/geocode",
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: z.object({}).strict() } } },
  },
  responses: {
    200: { description: "Geocode result (existing coordinates if already geocoded and unchanged)", content: { "application/json": { schema: geocodeJobResponseSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(geocodeJobRoute, async (c) => {
  const me = currentUser(c);
  if (me.role === "technician") return c.json({ error: "Forbidden" }, 403);

  const { id } = c.req.valid("param");
  const job = await get<{ id: number; latitude: number | null; longitude: number | null; geocode_status: string }>(
    "SELECT id, latitude, longitude, geocode_status FROM jobs WHERE id = ? AND organization_id = ?", [id, actorOrganizationId(c)]
  );
  if (!job) return c.json({ error: "Job not found" }, 404);

  // Idempotency / cost control (Section 13): a Job that is already
  // successfully geocoded is returned as-is, with ZERO provider calls.
  // Safe to rely on unconditionally — Phase 10.0's updateJob address-change
  // handler already clears latitude/longitude/geocode_status back to
  // pending the instant the Job's own address actually changes, so
  // "currently geocoded" here always means "geocoded for the CURRENT
  // address", never a stale result for an address that's since changed.
  let geocodeStatus: "pending" | "geocoded" | "failed";
  let latitude: number | null;
  let longitude: number | null;

  if (job.geocode_status === "geocoded" && job.latitude !== null && job.longitude !== null) {
    geocodeStatus = "geocoded";
    latitude = job.latitude;
    longitude = job.longitude;
  } else {
    // Disclosed residual race (Section 14): this idempotency check is NOT
    // an atomic claim. Two genuinely simultaneous first-time geocode
    // requests for the same pending Job can both pass this check and both
    // call the real provider (one extra paid call), since there is no
    // migration-free way to add a real mutual-exclusion claim without
    // either a new table (Calendar sync's calendar_sync_claims pattern) or
    // a persisted in-flight status value with no stale-reclaim timestamp to
    // recover a crashed claim — both would need a migration, out of this
    // phase's explicit scope. Both calls are independently safe
    // (deterministic persistGeocodeResult() writes, no partial/corrupt
    // state possible, last write wins with an equivalent result) — this is
    // a cost-duplication risk, not a data-integrity one. Classified P3:
    // rare (requires a genuine double-submit within the same short
    // window), self-limiting, no customer-facing impact. See
    // mem:phase10/maps-routing-architecture-audit.
    const provider = buildGeocodingProvider(c.env);
    geocodeStatus = await geocodeJob(Number(id), provider);
    const after = await get<{ latitude: number | null; longitude: number | null }>(
      "SELECT latitude, longitude FROM jobs WHERE id = ?", [id]
    );
    latitude = after?.latitude ?? null;
    longitude = after?.longitude ?? null;
  }

  return c.json({ ok: true, geocode_status: geocodeStatus, latitude, longitude }, 200);
});

const JobMediaSchema = z.object({
  id: z.number().int(),
  job_id: z.number().int(),
  kind: z.enum(MEDIA_KINDS as [MediaKind, ...MediaKind[]]),
  content_type: z.string(),
  size_bytes: z.number().int(),
  uploaded_by: z.number().int().nullable(),
  created_at: z.string(),
}).openapi("JobMedia");

const listJobMediaRoute = createRoute({
  method: "get",
  path: "/api/jobs/{id}/photos",
  request: { params: IdParam },
  responses: {
    200: { description: "Compliance photos for this job", content: { "application/json": { schema: z.object({ photos: z.array(JobMediaSchema) }) } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(listJobMediaRoute, async (c) => {
  const { id } = c.req.valid("param");
  const job = await loadComplianceJob(actorOrganizationId(c), id);
  if (!job) return c.json({ error: "Job not found" }, 404);
  // P1 fix (mem:risks/technician-job-read-scoping): sibling of
  // getComplianceAuditRoute's fix — this read had the identical gap, only
  // the upload/delete mutations were previously ownership-checked.
  const me = currentUser(c);
  if (!(await canActorAccessJobCompliance({ id: me.id, role: me.role }, job))) {
    return c.json({ error: "You are not permitted to view this job's photos" }, 403);
  }
  const rows = await listJobMedia(Number(id));
  const photos = rows.map((r) => ({
    id: r.id, job_id: r.job_id, kind: r.kind, content_type: r.content_type,
    size_bytes: r.size_bytes, uploaded_by: r.uploaded_by, created_at: r.created_at,
  }));
  return c.json({ photos }, 200);
});

// Plain routes below: multipart upload and binary download aren't JSON
// contracts (same rationale as the Google Calendar connect/callback routes
// above) — still sit under the "/api/*" auth middleware regardless.

app.post("/api/jobs/:id/photos", async (c) => {
  const me = currentUser(c);
  const idParam = c.req.param("id");
  const job = await loadComplianceJob(actorOrganizationId(c), idParam);
  if (!job) return c.json({ error: "Job not found" }, 404);
  const actor: Actor = { id: me.id, role: me.role };
  if (!(await canActorAccessJobCompliance(actor, job))) {
    return c.json({ error: "You are not permitted to upload compliance media for this job" }, 403);
  }

  const body = await c.req.parseBody();
  const kind = body["kind"];
  const file = body["file"];
  if (typeof kind !== "string" || !(MEDIA_KINDS as string[]).includes(kind)) {
    return c.json({ error: `kind must be one of: ${MEDIA_KINDS.join(", ")}` }, 400);
  }
  if (!(file instanceof File)) {
    return c.json({ error: "A file is required" }, 400);
  }

  try {
    assertUploadAllowed(file.size, file.type);
  } catch (err) {
    if (err instanceof StorageError) return c.json({ error: err.message }, 400);
    throw err;
  }

  const id = Number(idParam);
  const key = buildMediaKey(id, kind, file.name);
  await putObject(c.env, key, await file.arrayBuffer(), file.type);

  const row = await insertJobMedia({
    jobId: id, kind: kind as MediaKind, storageKey: key, contentType: file.type, sizeBytes: file.size, uploadedBy: me.id,
  });
  await recordComplianceEvent(id, "photo_uploaded", me.id, { kind, media_id: row.id, size_bytes: file.size });

  return c.json({
    id: row.id, job_id: row.job_id, kind: row.kind, content_type: row.content_type,
    size_bytes: row.size_bytes, uploaded_by: row.uploaded_by, created_at: row.created_at,
  }, 201);
});

app.get("/api/jobs/:id/photos/:photoId/file", async (c) => {
  const idParam = c.req.param("id");
  const job = await loadComplianceJob(actorOrganizationId(c), idParam);
  if (!job) return c.json({ error: "Job not found" }, 404);
  // P1 fix (mem:risks/technician-job-read-scoping): serves the actual photo
  // bytes — same sibling gap as the other compliance reads above, arguably
  // the most sensitive one since it's the raw evidence file itself.
  const me = currentUser(c);
  if (!(await canActorAccessJobCompliance({ id: me.id, role: me.role }, job))) {
    return c.json({ error: "You are not permitted to view this photo" }, 403);
  }
  const media = await getJobMedia(Number(c.req.param("photoId")));
  if (!media || media.job_id !== Number(idParam) || media.deleted_at) return c.json({ error: "Photo not found" }, 404);
  const obj = await getObject(c.env, media.storage_key);
  if (!obj) return c.json({ error: "File not found in storage" }, 404);
  // Served on the app's own origin from user-supplied bytes, so even though
  // uploads are content-type-allowlisted to raster images (see storage.ts),
  // these headers are defense in depth against a bypass being interpreted as
  // active content by the browser.
  return new Response(obj.body, {
    headers: {
      "Content-Type": media.content_type || "application/octet-stream",
      "Content-Disposition": "inline; filename=\"photo\"",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
});

app.delete("/api/jobs/:id/photos/:photoId", async (c) => {
  const me = currentUser(c);
  const idParam = c.req.param("id");
  const job = await loadComplianceJob(actorOrganizationId(c), idParam);
  if (!job) return c.json({ error: "Job not found" }, 404);
  const actor: Actor = { id: me.id, role: me.role };
  if (!(await canActorAccessJobCompliance(actor, job))) return c.json({ error: "Forbidden" }, 403);
  if (completedOrLater(job.status)) {
    return c.json({ error: "Cannot delete compliance media after a job has been completed" }, 400);
  }

  const media = await getJobMedia(Number(c.req.param("photoId")));
  if (!media || media.job_id !== Number(idParam)) return c.json({ error: "Photo not found" }, 404);

  const deleted = await softDeleteJobMedia(media.id);
  if (!deleted) return c.json({ error: "Photo already deleted" }, 404);
  // Soft-delete only — the R2 object is kept, not erased, so the evidence is
  // still recoverable even after being removed from the completion count.
  await recordComplianceEvent(Number(idParam), "photo_deleted", me.id, { media_id: media.id, kind: media.kind });
  return c.json({ ok: true }, 200);
});

const CompletionReportSchema = z.object({
  job_id: z.number().int(),
  work_performed: z.string(),
  findings: z.string(),
  notes: z.string(),
  materials_used: z.string(),
  status: z.enum(["draft", "submitted"]),
  submitted_by: z.number().int().nullable(),
  submitted_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
}).openapi("JobCompletionReport");

const getCompletionReportRoute = createRoute({
  method: "get",
  path: "/api/jobs/{id}/completion-report",
  request: { params: IdParam },
  responses: {
    200: { description: "Completion report, or null if none saved yet", content: { "application/json": { schema: CompletionReportSchema.nullable() } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(getCompletionReportRoute, async (c) => {
  const { id } = c.req.valid("param");
  const job = await loadComplianceJob(actorOrganizationId(c), id);
  if (!job) return c.json({ error: "Job not found" }, 404);
  // P1 fix (mem:risks/technician-job-read-scoping): same sibling gap as
  // listJobMediaRoute above.
  const me = currentUser(c);
  if (!(await canActorAccessJobCompliance({ id: me.id, role: me.role }, job))) {
    return c.json({ error: "You are not permitted to view this job's completion report" }, 403);
  }
  return c.json(await getCompletionReport(Number(id)), 200);
});

const putCompletionReportRoute = createRoute({
  method: "put",
  path: "/api/jobs/{id}/completion-report",
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: z.object({
      work_performed: z.string().optional(),
      findings: z.string().optional(),
      notes: z.string().optional(),
      materials_used: z.string().optional(),
    }).strict() } } },
  },
  responses: {
    200: { description: "Saved as a draft", content: { "application/json": { schema: CompletionReportSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(putCompletionReportRoute, async (c) => {
  const { id } = c.req.valid("param");
  const data = c.req.valid("json");
  const me = currentUser(c);
  const job = await loadComplianceJob(actorOrganizationId(c), id);
  if (!job) return c.json({ error: "Job not found" }, 404);
  const actor: Actor = { id: me.id, role: me.role };
  if (!(await canActorAccessJobCompliance(actor, job))) return c.json({ error: "Forbidden" }, 403);

  const report = await upsertCompletionReport(Number(id), {
    workPerformed: data.work_performed, findings: data.findings, notes: data.notes, materialsUsed: data.materials_used,
  });
  await recordComplianceEvent(Number(id), "report_saved", me.id, {});
  return c.json(report, 200);
});

const submitCompletionReportRoute = createRoute({
  method: "post",
  path: "/api/jobs/{id}/completion-report/submit",
  request: { params: IdParam },
  responses: {
    200: { description: "Submitted", content: { "application/json": { schema: CompletionReportSchema } } },
    400: { description: "Report is not ready to submit", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(submitCompletionReportRoute, async (c) => {
  const { id } = c.req.valid("param");
  const me = currentUser(c);
  const job = await loadComplianceJob(actorOrganizationId(c), id);
  if (!job) return c.json({ error: "Job not found" }, 404);
  const actor: Actor = { id: me.id, role: me.role };
  if (!(await canActorAccessJobCompliance(actor, job))) return c.json({ error: "Forbidden" }, 403);

  try {
    const report = await submitCompletionReport(Number(id), me.id);
    await recordComplianceEvent(Number(id), "report_submitted", me.id, {});
    return c.json(report, 200);
  } catch (err) {
    if (err instanceof ComplianceError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

const JobSignatureSchema = z.object({
  id: z.number().int(),
  job_id: z.number().int(),
  signer_name: z.string(),
  signer_relationship: z.string(),
  captured_by: z.number().int().nullable(),
  captured_at: z.string(),
}).openapi("JobSignature");

const listSignaturesRoute = createRoute({
  method: "get",
  path: "/api/jobs/{id}/signatures",
  request: { params: IdParam },
  responses: {
    200: { description: "Customer signatures on file for this job", content: { "application/json": { schema: z.object({ signatures: z.array(JobSignatureSchema) }) } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(listSignaturesRoute, async (c) => {
  const { id } = c.req.valid("param");
  const job = await loadComplianceJob(actorOrganizationId(c), id);
  if (!job) return c.json({ error: "Job not found" }, 404);
  // P1 fix (mem:risks/technician-job-read-scoping): same sibling gap as
  // listJobMediaRoute above.
  const me = currentUser(c);
  if (!(await canActorAccessJobCompliance({ id: me.id, role: me.role }, job))) {
    return c.json({ error: "You are not permitted to view this job's signatures" }, 403);
  }
  const signatures = await listJobSignatures(Number(id));
  return c.json({
    signatures: signatures.map((s) => ({
      id: s.id, job_id: s.job_id, signer_name: s.signer_name,
      signer_relationship: s.signer_relationship, captured_by: s.captured_by, captured_at: s.captured_at,
    })),
  }, 200);
});

const captureSignatureRoute = createRoute({
  method: "post",
  path: "/api/jobs/{id}/signature",
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: z.object({
      signer_name: z.string().min(1),
      signer_relationship: z.string().optional(),
      signature_data_url: z.string(),
    }) } } },
  },
  responses: {
    201: { description: "Captured", content: { "application/json": { schema: JobSignatureSchema } } },
    400: { description: "Invalid signature data", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(captureSignatureRoute, async (c) => {
  const { id } = c.req.valid("param");
  const data = c.req.valid("json");
  const me = currentUser(c);
  const job = await loadComplianceJob(actorOrganizationId(c), id);
  if (!job) return c.json({ error: "Job not found" }, 404);
  const actor: Actor = { id: me.id, role: me.role };
  if (!(await canActorAccessJobCompliance(actor, job))) return c.json({ error: "Forbidden" }, 403);

  const match = data.signature_data_url.match(/^data:(image\/(?:png|jpeg|webp));base64,([a-zA-Z0-9+/=]+)$/);
  if (!match) return c.json({ error: "signature_data_url must be a base64 image data URL" }, 400);
  const [, contentType, base64] = match;
  const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));

  try {
    assertUploadAllowed(bytes.byteLength, contentType);
  } catch (err) {
    if (err instanceof StorageError) return c.json({ error: err.message }, 400);
    throw err;
  }

  const key = buildMediaKey(Number(id), "signature", `signature.${contentType.split("/")[1]}`);
  await putObject(c.env, key, bytes.buffer as ArrayBuffer, contentType);

  const row = await insertJobSignature({
    jobId: Number(id), storageKey: key, signerName: data.signer_name,
    signerRelationship: data.signer_relationship ?? "", capturedBy: me.id,
  });
  await recordComplianceEvent(Number(id), "signature_captured", me.id, { signature_id: row.id, signer_name: data.signer_name });
  return c.json({
    id: row.id, job_id: row.job_id, signer_name: row.signer_name,
    signer_relationship: row.signer_relationship, captured_by: row.captured_by, captured_at: row.captured_at,
  }, 201);
});

const ComplianceAuditRowSchema = z.object({
  id: z.number().int(),
  job_id: z.number().int(),
  event_type: z.string(),
  actor_user_id: z.number().int().nullable(),
  details: z.string(),
  created_at: z.string(),
}).openapi("JobComplianceAuditRow");

const getComplianceAuditRoute = createRoute({
  method: "get",
  path: "/api/jobs/{id}/compliance-audit",
  request: { params: IdParam },
  responses: {
    200: { description: "Compliance audit trail for this job", content: { "application/json": { schema: z.object({ audit: z.array(ComplianceAuditRowSchema) }) } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(getComplianceAuditRoute, async (c) => {
  const { id } = c.req.valid("param");
  const job = await loadComplianceJob(actorOrganizationId(c), id);
  if (!job) return c.json({ error: "Job not found" }, 404);
  // P1 fix (mem:risks/technician-job-read-scoping): this read route was the
  // one gap in an otherwise fully ownership-scoped compliance sub-resource
  // set (uploads/report/signature already gate on this same predicate).
  const me = currentUser(c);
  if (!(await canActorAccessJobCompliance({ id: me.id, role: me.role }, job))) {
    return c.json({ error: "You are not permitted to view this job's compliance audit" }, 403);
  }
  const audit = await getComplianceAudit(Number(id));
  return c.json({ audit }, 200);
});

// ── Rebate Eligibility (CleanBC / BC Hydro) ─────────────────────────
// Layered entirely on top of the workflow engine above and Global Settings —
// see src/server/rebate.ts. Does not touch transition validation; the
// eligibility_code/expiry gate on "eligibility_approved" is unchanged from
// Phase 2. Reads (eligibility check results, audit history, the tracker list)
// are ownership-scoped for technicians (job/customer must be theirs — see
// mem:risks/technician-job-read-scoping), same as job details; writes (running
// a check, correcting a code/expiry after approval) are admin/dispatcher only
// — same split as job-schedule editing in Phase 2.

const RebateCriterionSchema = z.object({ key: z.string(), label: z.string(), satisfied: z.boolean().nullable(), detail: z.string() });
const RebateEligibilityResultSchema = z.object({
  job_type: z.string(),
  allowed: z.boolean().nullable(),
  criteria: z.array(RebateCriterionSchema),
  thresholds_used: z.record(z.string(), z.number().nullable()),
});

const getCustomerRebateEligibilityRoute = createRoute({
  method: "get",
  path: "/api/customers/{id}/rebate-eligibility",
  request: { params: IdParam, query: z.object({ job_type: z.enum(JOB_TYPES as [JobType, ...JobType[]]) }) },
  responses: {
    200: { description: "Live eligibility calculation (not persisted)", content: { "application/json": { schema: RebateEligibilityResultSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(getCustomerRebateEligibilityRoute, async (c) => {
  const { id } = c.req.valid("param");
  const { job_type } = c.req.valid("query");
  // P1 fix (mem:risks/technician-job-read-scoping): keyed purely by
  // customer_id with no job in the URL at all — without this check a
  // technician could probe rebate-eligibility PII (house size, household
  // income) for ANY customer, including ones they have no job with
  // whatsoever. Same job-ownership rule as listCustomers/getCustomer.
  const me = currentUser(c);
  // Phase 11.5: existence is org-scoped first — a customer belonging to
  // another organization is treated identically to a nonexistent one, same
  // safe-404 convention as every other cross-tenant lookup in this file.
  const customerOrgRow = await get<{ id: number }>(
    "SELECT id FROM customers WHERE id = ? AND organization_id = ?", [id, actorOrganizationId(c)]
  );
  if (!customerOrgRow) return c.json({ error: "Customer not found" }, 404);
  if (me.role === "technician") {
    const techId = await actorTechnicianId({ id: me.id, role: me.role });
    const owns = techId !== null
      ? await get<{ id: number }>("SELECT id FROM jobs WHERE customer_id = ? AND technician_id = ? LIMIT 1", [id, techId])
      : null;
    if (!owns) return c.json({ error: "You are not permitted to view this customer" }, 403);
  }
  const profile = await getCustomerRebateProfile(Number(id));
  if (!profile) return c.json({ error: "Customer not found" }, 404);
  const result = await evaluateRebateEligibility(actorOrganizationId(c), job_type, profile);
  return c.json(result, 200);
});

const eligibilityCheckRoute = createRoute({
  method: "post",
  path: "/api/jobs/{id}/eligibility-check",
  request: { params: IdParam },
  responses: {
    200: { description: "Checked and recorded", content: { "application/json": { schema: RebateEligibilityResultSchema } } },
    400: { description: "Job is not a rebate job type", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(eligibilityCheckRoute, async (c) => {
  const me = currentUser(c);
  if (me.role === "technician") return c.json({ error: "Technicians cannot run eligibility checks" }, 403);
  const { id } = c.req.valid("param");
  const job = await get<{ id: number; customer_id: number; job_type: string }>(
    "SELECT id, customer_id, job_type FROM jobs WHERE id = ? AND organization_id = ?", [id, actorOrganizationId(c)]
  );
  if (!job) return c.json({ error: "Job not found" }, 404);
  if (!isJobType(job.job_type) || job.job_type === "STANDARD") {
    return c.json({ error: "Only CleanBC and BC Hydro jobs have rebate eligibility criteria" }, 400);
  }
  const profile = await getCustomerRebateProfile(job.customer_id);
  if (!profile) return c.json({ error: "Customer not found" }, 404);
  const result = await recordEligibilityCheck(actorOrganizationId(c), Number(id), me.id, job.job_type, profile);
  return c.json(result, 200);
});

const RebateAuditRowSchema = z.object({
  id: z.number().int(),
  job_id: z.number().int(),
  event_type: z.string(),
  actor_user_id: z.number().int().nullable(),
  details: z.string(),
  created_at: z.string(),
});

const getJobRebateAuditRoute = createRoute({
  method: "get",
  path: "/api/jobs/{id}/rebate-audit",
  request: { params: IdParam },
  responses: {
    200: { description: "Rebate audit history for this job", content: { "application/json": { schema: z.object({ audit: z.array(RebateAuditRowSchema) }) } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(getJobRebateAuditRoute, async (c) => {
  const { id } = c.req.valid("param");
  const job = await loadComplianceJob(actorOrganizationId(c), id);
  if (!job) return c.json({ error: "Job not found" }, 404);
  // P1 fix (mem:risks/technician-job-read-scoping): this used to be
  // deliberately open to any authenticated role "same as job details" (see
  // the section comment above) — now that job details are ownership-scoped
  // for technicians, this follows the same rule for the same reason.
  const me = currentUser(c);
  if (!(await canActorAccessJobCompliance({ id: me.id, role: me.role }, job))) {
    return c.json({ error: "You are not permitted to view this job's rebate audit" }, 403);
  }
  const audit = await getJobRebateAudit(Number(id));
  return c.json({ audit }, 200);
});

const updateJobEligibilityRoute = createRoute({
  method: "put",
  path: "/api/jobs/{id}/eligibility",
  request: {
    params: IdParam,
    body: {
      content: { "application/json": { schema: z.object({
        eligibility_code: z.string().optional(),
        eligibility_code_expiry: z.string().optional(),
      }).strict() } },
    },
  },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: OkSchema } } },
    400: { description: "Job is not CleanBC, or has no eligibility code yet", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(updateJobEligibilityRoute, async (c) => {
  const me = currentUser(c);
  if (me.role === "technician") return c.json({ error: "Technicians cannot edit eligibility code information" }, 403);
  const { id } = c.req.valid("param");
  const data = c.req.valid("json");
  const job = await get<{ id: number; job_type: string; eligibility_code: string; eligibility_code_expiry: string }>(
    "SELECT id, job_type, eligibility_code, eligibility_code_expiry FROM jobs WHERE id = ? AND organization_id = ?",
    [id, actorOrganizationId(c)]
  );
  if (!job) return c.json({ error: "Job not found" }, 404);
  if (job.job_type !== "CLEANBC") return c.json({ error: "Only CleanBC jobs have an eligibility code" }, 400);
  if (!job.eligibility_code) return c.json({ error: "This job has not been through eligibility approval yet" }, 400);

  const fields: string[] = [];
  const vals: unknown[] = [];
  if (data.eligibility_code !== undefined && data.eligibility_code !== job.eligibility_code) {
    fields.push("eligibility_code = ?");
    vals.push(data.eligibility_code);
    await recordEligibilityFieldChange(Number(id), me.id, "code", job.eligibility_code, data.eligibility_code);
  }
  if (data.eligibility_code_expiry !== undefined && data.eligibility_code_expiry !== job.eligibility_code_expiry) {
    fields.push("eligibility_code_expiry = ?");
    vals.push(data.eligibility_code_expiry);
    await recordEligibilityFieldChange(Number(id), me.id, "expiry", job.eligibility_code_expiry, data.eligibility_code_expiry);
  }
  if (fields.length > 0) {
    fields.push("updated_at = datetime('now')");
    await run(`UPDATE jobs SET ${fields.join(", ")} WHERE id = ?`, [...vals, id]);
  }
  return c.json({ ok: true }, 200);
});


// ── Job Notes ──────────────────────────────────────────────────────

const addJobNote = createRoute({
  method: "post",
  path: "/api/jobs/{id}/notes",
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: z.object({ content: z.string() }) } } },
  },
  responses: {
    201: { description: "Note added", content: { "application/json": { schema: JobNoteSchema } } },
    404: { description: "Job not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(addJobNote, async (c) => {
  const { id } = c.req.valid("param");
  const { content } = c.req.valid("json");
  // Phase 11.5: the job must belong to the actor's own organization —
  // previously this route trusted a bare numeric job id with no ownership
  // check at all.
  const ownedJob = await get<{ id: number }>(
    "SELECT id FROM jobs WHERE id = ? AND organization_id = ?", [id, actorOrganizationId(c)]
  );
  if (!ownedJob) return c.json({ error: "Job not found" }, 404);
  await run("INSERT INTO job_notes (job_id, content) VALUES (?, ?)", [id, content]);
  const note = await get<JobNote>(
    "SELECT * FROM job_notes WHERE job_id = ? ORDER BY id DESC LIMIT 1", [id]
  );
  return c.json(note!, 201);
});

const deleteJobNote = createRoute({
  method: "delete",
  path: "/api/notes/{id}",
  request: { params: IdParam },
  responses: {
    200: { description: "Deleted", content: { "application/json": { schema: OkSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(deleteJobNote, async (c) => {
  const me = currentUser(c);
  if (me.role === "technician") return c.json({ error: "Forbidden" }, 403);

  const { id } = c.req.valid("param");
  await run(
    "DELETE FROM job_notes WHERE id = ? AND job_id IN (SELECT id FROM jobs WHERE organization_id = ?)",
    [id, actorOrganizationId(c)]
  );
  return c.json({ ok: true }, 200);
});

// ── Customers ──────────────────────────────────────────────────────

const listCustomers = createRoute({
  method: "get",
  path: "/api/customers",
  request: {
    query: z.object({
      page: z.string().optional(),
      limit: z.string().optional(),
      search: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Paginated customer list",
      content: { "application/json": { schema: z.object({ customers: z.array(CustomerSchema), total: z.number().int() }) } },
    },
  },
});

app.openapi(listCustomers, async (c) => {
  const q = c.req.valid("query");
  const page = parseInt(q.page || "1", 10);
  const limit = parseInt(q.limit || "50", 10);
  const offset = (page - 1) * limit;

  const conditions: string[] = ["c.organization_id = ?"];
  const params: unknown[] = [actorOrganizationId(c)];
  if (q.search) {
    conditions.push("(c.name LIKE ? OR c.email LIKE ? OR c.phone LIKE ? OR c.address LIKE ?)");
    const s = `%${q.search}%`;
    params.push(s, s, s, s);
  }
  // P1 fix (mem:risks/technician-job-read-scoping): a technician may only
  // see customers tied to a job assigned to them — otherwise this endpoint
  // exposes every customer's PII to any technician regardless of the
  // job-level scoping added elsewhere, since it doesn't go through jobs at
  // all by default. Same session-derived ownership resolver as everywhere
  // else — never trust a client-supplied id for this.
  const me = currentUser(c);
  if (me.role === "technician") {
    const techId = await actorTechnicianId({ id: me.id, role: me.role });
    if (techId === null) return c.json({ customers: [], total: 0 }, 200);
    conditions.push("c.id IN (SELECT customer_id FROM jobs WHERE technician_id = ?)");
    params.push(techId);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const countRow = await get<{ count: number }>(`SELECT COUNT(*) as count FROM customers c ${where}`, params);
  const customers = await query<Customer>(
    `SELECT c.*, COALESCE(jc.cnt, 0) as job_count, ${CUSTOMER_REBATE_PROFILE_OVERRIDE_COLUMNS}
     FROM customers c
     LEFT JOIN (SELECT customer_id, COUNT(*) as cnt FROM jobs GROUP BY customer_id) jc ON jc.customer_id = c.id
     ${CUSTOMER_REBATE_PROFILE_JOIN}
     ${where}
     ORDER BY c.name ASC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return c.json({ customers, total: countRow?.count || 0 }, 200);
});

const listAllCustomers = createRoute({
  method: "get",
  path: "/api/customers/all",
  responses: {
    200: {
      description: "All customers (for dropdowns)",
      content: { "application/json": { schema: z.object({ customers: z.array(z.object({ id: z.number().int(), name: z.string(), address: z.string() })) }) } },
    },
  },
});

app.openapi(listAllCustomers, async (c) => {
  const me = currentUser(c);
  const organizationId = actorOrganizationId(c);
  if (me.role === "technician") {
    const techId = await actorTechnicianId({ id: me.id, role: me.role });
    if (techId === null) return c.json({ customers: [] }, 200);
    const customers = await query<Pick<Customer, "id" | "name" | "address">>(
      `SELECT id, name, address FROM customers
       WHERE organization_id = ? AND id IN (SELECT customer_id FROM jobs WHERE technician_id = ?)
       ORDER BY name ASC`, [organizationId, techId]
    );
    return c.json({ customers }, 200);
  }
  const customers = await query<Pick<Customer, "id" | "name" | "address">>(
    "SELECT id, name, address FROM customers WHERE organization_id = ? ORDER BY name ASC", [organizationId]
  );
  return c.json({ customers }, 200);
});

const getCustomer = createRoute({
  method: "get",
  path: "/api/customers/{id}",
  request: { params: IdParam },
  responses: {
    200: { description: "Customer detail", content: { "application/json": { schema: z.object({ customer: CustomerSchema, jobs: z.array(JobSchema) }) } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(getCustomer, async (c) => {
  const { id } = c.req.valid("param");
  // LEFT JOIN resolves the referring customer's display name so the client
  // never has to make a second request just to show "Referred by John Smith"
  // — referred_by_customer_name is null unless referral_source is actually
  // "Existing Customer" (see src/server/customers.ts, which guarantees
  // referred_by_customer_id is null for every other source).
  const customer = await get<Customer>(
    `SELECT c.*, rb.name as referred_by_customer_name, ${CUSTOMER_REBATE_PROFILE_OVERRIDE_COLUMNS}
     FROM customers c
     LEFT JOIN customers rb ON c.referred_by_customer_id = rb.id
     ${CUSTOMER_REBATE_PROFILE_JOIN}
     WHERE c.id = ? AND c.organization_id = ?`, [id, actorOrganizationId(c)]
  );
  if (!customer) return c.json({ error: "Customer not found" }, 404);

  // P1 fix (mem:risks/technician-job-read-scoping): a technician may view a
  // customer only if at least one of that customer's jobs is assigned to
  // them — and even then, the `jobs` list below must itself be narrowed to
  // just their own job(s) with this customer, not every job this customer
  // has ever had (which could belong to other technicians entirely).
  const me = currentUser(c);
  let techId: number | null = null;
  if (me.role === "technician") {
    techId = await actorTechnicianId({ id: me.id, role: me.role });
    if (techId === null) return c.json({ error: "You are not permitted to view this customer" }, 403);
    const owns = await get<{ id: number }>("SELECT id FROM jobs WHERE customer_id = ? AND technician_id = ? LIMIT 1", [id, techId]);
    if (!owns) return c.json({ error: "You are not permitted to view this customer" }, 403);
  }

  const jobs = await query<Job>(
    `SELECT j.*, t.name as technician_name, t.color as technician_color,
       st.name as service_type_name, st.color as service_type_color
     FROM jobs j
     LEFT JOIN technicians t ON j.technician_id = t.id
     LEFT JOIN service_types st ON j.service_type_id = st.id
     WHERE j.customer_id = ? ${techId !== null ? "AND j.technician_id = ?" : ""}
     ORDER BY j.scheduled_date DESC
     LIMIT 50`,
    techId !== null ? [id, techId] : [id]
  );
  return c.json({ customer, jobs }, 200);
});

const createCustomer = createRoute({
  method: "post",
  path: "/api/customers",
  request: {
    body: {
      content: { "application/json": { schema: z.object({
        name: z.string(),
        email: z.string().optional(),
        phone: z.string().optional(),
        address: z.string().optional(),
        city: z.string().optional(),
        state: z.string().optional(),
        zip: z.string().optional(),
        notes: z.string().optional(),
        referral_source: z.string().optional(),
        referral_name: z.string().optional(),
        referred_by_customer_id: z.number().int().nullable().optional(),
        house_size: z.number().int().nullable().optional(),
        primary_heating_source: z.string().optional(),
        number_of_adults: z.number().int().nullable().optional(),
        number_of_children: z.number().int().nullable().optional(),
        household_income: z.number().nullable().optional(),
      }) } },
    },
  },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: CustomerSchema } } },
    400: { description: "Invalid referral attribution", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(createCustomer, async (c) => {
  const data = c.req.valid("json");
  const me = currentUser(c);
  if (me.role === "technician" && Object.keys(data).some((k) => REBATE_PROFILE_FIELDS.has(k))) {
    return c.json({ error: "Technicians cannot set customer referral/rebate information" }, 403);
  }
  let referral;
  try {
    // A brand-new customer has no id yet, so self-referral (selfId) can
    // never apply here — that check only matters for updateCustomer.
    referral = await resolveReferralAttribution(actorOrganizationId(c), data, null, null);
  } catch (err) {
    if (err instanceof CustomerValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
  // Phase 11.3: the 5 rebate-profile fields are no longer written to
  // `customers` — they live in bc_rebate_customer_profiles (see
  // customer-profile.ts). Only create a profile row when the request
  // actually supplied at least one, matching the original "do not assume
  // these fields apply to every customer" design.
  const insertResult = await run(
    `INSERT INTO customers (organization_id, name, email, phone, address, city, state, zip, notes,
       referral_source, referral_name, referred_by_customer_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      actorOrganizationId(c), data.name, data.email || "", data.phone || "", data.address || "",
      data.city || "", data.state || "", data.zip || "", data.notes || "",
      referral.referral_source, referral.referral_name, referral.referred_by_customer_id,
    ]
  );
  const customerId = insertResult.lastInsertRowid;
  if (Object.keys(data).some((k) => REBATE_COLUMN_FIELDS.has(k))) {
    await upsertCustomerRebateProfile(customerId, {
      house_size: data.house_size ?? null,
      primary_heating_source: data.primary_heating_source || "",
      number_of_adults: data.number_of_adults ?? null,
      number_of_children: data.number_of_children ?? null,
      household_income: data.household_income ?? null,
    });
  }
  const customer = await get<Customer>(
    `SELECT c.*, ${CUSTOMER_REBATE_PROFILE_OVERRIDE_COLUMNS}
     FROM customers c ${CUSTOMER_REBATE_PROFILE_JOIN}
     WHERE c.id = ?`,
    [customerId]
  );
  return c.json(customer!, 201);
});

const updateCustomer = createRoute({
  method: "put",
  path: "/api/customers/{id}",
  request: {
    params: IdParam,
    body: {
      content: { "application/json": { schema: z.object({
        name: z.string().optional(),
        email: z.string().optional(),
        phone: z.string().optional(),
        address: z.string().optional(),
        city: z.string().optional(),
        state: z.string().optional(),
        zip: z.string().optional(),
        notes: z.string().optional(),
        referral_source: z.string().optional(),
        referral_name: z.string().optional(),
        referred_by_customer_id: z.number().int().nullable().optional(),
        house_size: z.number().int().nullable().optional(),
        primary_heating_source: z.string().optional(),
        number_of_adults: z.number().int().nullable().optional(),
        number_of_children: z.number().int().nullable().optional(),
        household_income: z.number().nullable().optional(),
      }) } },
    },
  },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: OkSchema } } },
    400: { description: "Invalid referral attribution", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const REFERRAL_FIELDS = new Set(["referral_source", "referral_name", "referred_by_customer_id"]);

app.openapi(updateCustomer, async (c) => {
  const { id } = c.req.valid("param");
  const data = c.req.valid("json");
  const me = currentUser(c);
  if (me.role === "technician" && Object.keys(data).some((k) => REBATE_PROFILE_FIELDS.has(k) && data[k as keyof typeof data] !== undefined)) {
    return c.json({ error: "Technicians cannot edit customer referral/rebate information" }, 403);
  }
  // Phase 11.5: organization ownership checked first, before any query or
  // mutation — same "RBAC/existence before any write" discipline already
  // established for this exact route class (see mem:risks/job-update-
  // ownership-bypass). Unlike jobs (which already 404'd on an unknown id
  // pre-Phase-11.5), this route's pre-existing contract was a silent no-op
  // on an unknown id (no existence check ran at all) — preserved here by
  // returning the same 200 no-op for "doesn't exist" and "exists in another
  // organization" alike, matching updateTechnician/updateServiceType/
  // updateMaterial's identical pattern in this same diff.
  const ownedCustomer = await get<{ id: number }>(
    "SELECT id FROM customers WHERE id = ? AND organization_id = ?", [id, actorOrganizationId(c)]
  );
  if (!ownedCustomer) return c.json({ ok: true }, 200); // matches this route's pre-existing no-op-on-unknown-id behavior

  const fields: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(data)) {
    // Phase 11.3: rebate-profile fields are excluded here too — they're
    // resolved and written to bc_rebate_customer_profiles below, the same
    // way referral fields are excluded and resolved separately above.
    if (v !== undefined && !REFERRAL_FIELDS.has(k) && !REBATE_COLUMN_FIELDS.has(k)) {
      fields.push(`${k} = ?`);
      vals.push(v);
    }
  }

  // Phase 11.3: same partial-PUT-aware "effective state" pattern as the
  // referral-attribution resolution above — only touched when the request
  // includes at least one of the 5 rebate fields, so an unrelated edit
  // (e.g. just the phone number) never creates a profile row for a
  // customer that never had rebate data. Untouched fields fall back to the
  // existing profile row's value (or the same blank defaults a brand-new
  // profile would have), never silently zeroed.
  let touchedRebateProfile = false;
  if (Object.keys(data).some((k) => REBATE_COLUMN_FIELDS.has(k))) {
    // getCustomerRebateProfile returns null only when the customer itself
    // doesn't exist — matches this route's pre-existing behavior of never
    // erroring on a nonexistent id unless the touched fields require an
    // existence check (see the referral-fields branch below); silently
    // skipping here (rather than 404ing) preserves that exact no-op-on-
    // unknown-id precedent instead of introducing a new failure mode.
    const existingProfile = await getCustomerRebateProfile(Number(id));
    if (existingProfile) {
      const effective: CustomerRebateProfile = {
        house_size: data.house_size !== undefined ? data.house_size : existingProfile.house_size,
        primary_heating_source: data.primary_heating_source !== undefined ? data.primary_heating_source : existingProfile.primary_heating_source,
        number_of_adults: data.number_of_adults !== undefined ? data.number_of_adults : existingProfile.number_of_adults,
        number_of_children: data.number_of_children !== undefined ? data.number_of_children : existingProfile.number_of_children,
        household_income: data.household_income !== undefined ? data.household_income : existingProfile.household_income,
      };
      await upsertCustomerRebateProfile(Number(id), effective);
      touchedRebateProfile = true;
    }
  }

  // Referral fields are resolved together, not field-by-field, whenever the
  // request touches ANY of the 3 — the effective post-update referral_source
  // (which might come from this request or from the existing row) governs
  // whether referral_name/referred_by_customer_id are required, forbidden,
  // or must be force-cleared as stale data from a prior source. Untouched
  // requests (e.g. just editing the phone number) never run this at all, so
  // unrelated fields are never at risk of being touched.
  if (Object.keys(data).some((k) => REFERRAL_FIELDS.has(k))) {
    const existing = await get<{ referral_source: string; referral_name: string; referred_by_customer_id: number | null }>(
      "SELECT referral_source, referral_name, referred_by_customer_id FROM customers WHERE id = ?", [id]
    );
    if (!existing) return c.json({ error: "Customer not found" }, 404);
    try {
      const referral = await resolveReferralAttribution(actorOrganizationId(c), data, existing, Number(id));
      fields.push("referral_source = ?", "referral_name = ?", "referred_by_customer_id = ?");
      vals.push(referral.referral_source, referral.referral_name, referral.referred_by_customer_id);
    } catch (err) {
      if (err instanceof CustomerValidationError) return c.json({ error: err.message }, 400);
      throw err;
    }
  }

  if (fields.length > 0) {
    fields.push("updated_at = datetime('now')");
    await run(`UPDATE customers SET ${fields.join(", ")} WHERE id = ?`, [...vals, id]);
  } else if (touchedRebateProfile) {
    // Only rebate-profile fields changed (now stored in a different table)
    // — still bump customers.updated_at, matching the pre-Phase-11.3
    // contract where any successful field change (rebate fields included)
    // touched this timestamp.
    await run("UPDATE customers SET updated_at = datetime('now') WHERE id = ?", [id]);
  }
  return c.json({ ok: true }, 200);
});

const deleteCustomer = createRoute({
  method: "delete",
  path: "/api/customers/{id}",
  request: { params: IdParam },
  responses: {
    200: { description: "Deleted", content: { "application/json": { schema: OkSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(deleteCustomer, async (c) => {
  const me = currentUser(c);
  if (me.role === "technician") return c.json({ error: "Forbidden" }, 403);

  const { id } = c.req.valid("param");
  await run("DELETE FROM customers WHERE id = ? AND organization_id = ?", [id, actorOrganizationId(c)]);
  return c.json({ ok: true }, 200);
});

// ── Notification preferences & history (Phase 9.3) ──────────────────────
// Same RBAC discipline as every other domain: the check runs first, before
// any query (including existence lookups). Customer/Lead preferences use a
// plain technician blanket-block (no ownership scoping exists for either
// domain — see mem:architecture/auth); Invoice history reuses
// canManageFinancials() verbatim rather than inventing a parallel check.

const getCustomerNotificationPreferences = createRoute({
  method: "get",
  path: "/api/customers/{id}/notification-preferences",
  request: { params: IdParam },
  responses: {
    200: { description: "Effective notification preferences", content: { "application/json": { schema: z.any() } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(getCustomerNotificationPreferences, async (c) => {
  const me = currentUser(c);
  if (me.role === "technician") return c.json({ error: "Forbidden" }, 403);
  const { id } = c.req.valid("param");
  const customer = await get<{ id: number }>("SELECT id FROM customers WHERE id = ? AND organization_id = ?", [id, actorOrganizationId(c)]);
  if (!customer) return c.json({ error: "Customer not found" }, 404);
  const preferences = await getPreferencesView("customer", Number(id));
  return c.json({ preferences, sms_consent_sources: CONSENT_SOURCES }, 200);
});

const PreferenceUpdateBody = z.object({
  email_enabled: z.boolean().optional(),
  sms_enabled: z.boolean().optional(),
  sms_consent_source: z.string().optional(),
}).strict();

const updateCustomerNotificationPreferences = createRoute({
  method: "put",
  path: "/api/customers/{id}/notification-preferences",
  request: { params: IdParam, body: { content: { "application/json": { schema: PreferenceUpdateBody } } } },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: z.any() } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(updateCustomerNotificationPreferences, async (c) => {
  const me = currentUser(c);
  if (me.role === "technician") return c.json({ error: "Forbidden" }, 403);
  const { id } = c.req.valid("param");
  const customer = await get<{ id: number }>("SELECT id FROM customers WHERE id = ? AND organization_id = ?", [id, actorOrganizationId(c)]);
  if (!customer) return c.json({ error: "Customer not found" }, 404);
  const data = c.req.valid("json");
  try {
    const preferences = await updatePreferences("customer", Number(id), {
      emailEnabled: data.email_enabled, smsEnabled: data.sms_enabled, smsConsentSource: data.sms_consent_source,
    });
    // Phase 9.5 browser verification fix: this response used to omit
    // sms_consent_sources (unlike the GET route below), so the client's
    // setData(res) after ANY mutation (even a plain email toggle) wiped out
    // the consent-source list it had loaded from the initial GET — the next
    // time the user opened the Enable SMS modal, `data.sms_consent_sources
    // .map(...)` threw "Cannot read properties of undefined (reading
    // 'map')", crashing the whole component. Reproduced live in a real
    // Chromium browser (page crashed exactly on this call whenever any
    // mutation preceded opening the modal — which is unavoidable in the
    // required enable->disable->re-enable flow). Fixed by mirroring the GET
    // response shape here, same as the Lead route below.
    return c.json({ preferences, sms_consent_sources: CONSENT_SOURCES }, 200);
  } catch (err) {
    if (err instanceof PreferenceUpdateError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

const getCustomerNotifications = createRoute({
  method: "get",
  path: "/api/customers/{id}/notifications",
  request: { params: IdParam, query: NotificationHistoryQuery },
  responses: {
    200: { description: "Notification history", content: { "application/json": { schema: z.any() } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(getCustomerNotifications, async (c) => {
  const me = currentUser(c);
  if (me.role === "technician") return c.json({ error: "Forbidden" }, 403);
  const { id } = c.req.valid("param");
  const customer = await get<{ id: number }>("SELECT id FROM customers WHERE id = ? AND organization_id = ?", [id, actorOrganizationId(c)]);
  if (!customer) return c.json({ error: "Customer not found" }, 404);
  const { limit, offset } = parseHistoryPagination(c.req.valid("query"));
  const page = await getCustomerNotificationHistory(Number(id), limit, offset);
  return c.json(page, 200);
});

// ── Leads (Phase 8.2) ────────────────────────────────────────────────
// RBAC policy (no approved decision names a Salesperson role, so this is the
// baseline from the Phase 8 approved decisions + this phase's own explicit
// instruction): admin/dispatcher get full, identical Lead management parity;
// technician gets a blanket 403 on every Lead route, no exceptions, no
// ownership scoping — Leads are a front-office/sales concern with no
// field-work component, same reasoning already applied to Global Settings
// and rebate-rule configuration. The check runs FIRST in every handler,
// before any database query (including existence lookups) or mutation —
// same "RBAC before mutation, and before any query at all" discipline as
// updateJob's P0/P1 fix (mem:risks/job-update-ownership-bypass), so a
// blocked technician gets 403 for a nonexistent Lead id too, never 404.
// This is a plain inline check per route (not a shared middleware, not a
// new authorization framework) — matching this file's existing convention
// for every other domain, not a second Lead-specific authorization
// mechanism.
//
// transitionLead() (src/server/lead-workflow.ts, Phase 8.1) remains the sole
// authority for the transition matrix, lost-reason rules, history writes,
// and concurrency handling — this route layer never reimplements any of
// that, only maps LeadWorkflowError.code to an HTTP status (mirrors
// transitionJobRoute's WorkflowError mapping below).
//
// Referral attribution (referral_source/referral_name/referred_by_customer_id)
// reuses resolveReferralAttribution() from customers.ts UNMODIFIED — the
// exact same 3 columns, the exact same conditional-validity/stale-clearing
// rules, and the exact same `customers` table `referred_by_customer_id`
// points into. `selfId` is always passed as `null` for a Lead (never the
// Lead's own id): self-referral protection is a Customer-to-Customer concept
// (a customer can't refer themselves) and does not apply across the
// Lead/Customer id namespaces — passing a Lead id as `selfId` would risk
// spuriously rejecting a valid referral if a Customer happened to share that
// numeric id.
const LEAD_SELECT = `SELECT l.*, u.name as assigned_user_name, rb.name as referred_by_customer_name
  FROM leads l
  LEFT JOIN users u ON l.assigned_user_id = u.id
  LEFT JOIN customers rb ON l.referred_by_customer_id = rb.id`;

// Phase 8.5 security/integrity sweep: originally mirrored nextIdentifier()'s
// (job counter) read-then-write pattern, which races under concurrent
// creation — two callers can read the same counter value and mint the same
// identifier, exactly the bug nextInvoiceIdentifier() (financial.ts) was
// fixed to avoid via a single atomic UPDATE...RETURNING statement (one
// indivisible SQLite operation — no other statement can interleave between
// the read and the write). Adopted that proven pattern here, scoped to the
// Lead counter only; the Job counter's own identical race remains separate,
// already-documented technical debt (mem:project/fsm-upgrade-plan), not
// fixed in this phase per its explicit "do not redesign every existing
// counter" scope limit.
async function nextLeadIdentifier(): Promise<string> {
  const prefix = await get<{ value: string }>("SELECT value FROM _meta WHERE key = 'lead_prefix'");
  const counter = await get<{ value: string }>(
    "UPDATE _meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'lead_counter' RETURNING value"
  );
  return `${prefix?.value || "LEAD"}-${counter!.value}`;
}

/** A Lead's assigned_user_id is a front-office/sales ownership concept (see
 *  migration 0010's comment, which explicitly deferred this check to Phase
 *  8.2) — restricted to admin/dispatcher users. Mirrors
 *  validateTechnicianUserId()'s existence+role-appropriateness shape (below,
 *  in the Technicians section) but with the opposite role criterion: a
 *  technician is never a valid Lead assignee, the inverse of "a technician
 *  link must actually be a technician." */
async function validateLeadAssigneeUserId(organizationId: number, userId: number): Promise<string | null> {
  const user = await get<{ id: number; role: string }>(
    "SELECT id, role FROM users WHERE id = ? AND organization_id = ?", [userId, organizationId]
  );
  if (!user) return "Assigned user not found";
  if (user.role === "technician") return "Assigned user must be an admin or dispatcher";
  return null;
}

const listLeads = createRoute({
  method: "get",
  path: "/api/leads",
  request: {
    query: z.object({
      page: z.string().optional(),
      limit: z.string().optional(),
      search: z.string().optional(),
      status: z.string().optional(),
      assigned_user_id: z.string().optional(),
      referral_source: z.string().optional(),
    }),
  },
  responses: {
    200: { description: "Paginated lead list", content: { "application/json": { schema: z.object({ leads: z.array(LeadSchema), total: z.number().int() }) } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(listLeads, async (c) => {
  const me = currentUser(c);
  if (me.role === "technician") return c.json({ error: "Technicians cannot view leads" }, 403);

  const q = c.req.valid("query");
  // Phase 8.5: a malformed (non-numeric) page/limit used to parseInt() to
  // NaN and get bound straight into the SQL LIMIT/OFFSET, which D1 rejects
  // with a raw SQLITE_MISMATCH 500 instead of a clean, expected response —
  // found live during this phase's security sweep. Clamped defensively
  // (same class of gap likely exists on listJobs/listCustomers/listInvoices
  // too, all of which parse page/limit identically — out of this phase's
  // Lead-only scope to fix there, documented as separate technical debt).
  const parsedPage = parseInt(q.page || "1", 10);
  const page = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  const parsedLimit = parseInt(q.limit || "50", 10);
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 200) : 50;
  const offset = (page - 1) * limit;

  const conditions: string[] = ["l.organization_id = ?"];
  const params: unknown[] = [actorOrganizationId(c)];
  if (q.search) {
    conditions.push("(l.identifier LIKE ? OR l.name LIKE ? OR l.phone LIKE ? OR l.email LIKE ?)");
    const s = `%${q.search}%`;
    params.push(s, s, s, s);
  }
  if (q.status) {
    conditions.push("l.status = ?");
    params.push(q.status);
  }
  if (q.assigned_user_id) {
    conditions.push("l.assigned_user_id = ?");
    params.push(q.assigned_user_id);
  }
  if (q.referral_source) {
    conditions.push("l.referral_source = ?");
    params.push(q.referral_source);
  }
  const where = `WHERE ${conditions.join(" AND ")}`;

  const countRow = await get<{ count: number }>(`SELECT COUNT(*) as count FROM leads l ${where}`, params);
  // Deterministic, pagination-safe ordering: created_at alone can tie within
  // the same second (real in tests and in bulk imports), so id DESC is a
  // required tiebreaker, not decoration.
  const leads = await query<Lead>(
    `${LEAD_SELECT} ${where} ORDER BY l.created_at DESC, l.id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return c.json({ leads, total: countRow?.count || 0 }, 200);
});

const getLead = createRoute({
  method: "get",
  path: "/api/leads/{id}",
  request: { params: IdParam },
  responses: {
    200: { description: "Lead detail", content: { "application/json": { schema: z.object({ lead: LeadSchema }) } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(getLead, async (c) => {
  const me = currentUser(c);
  if (me.role === "technician") return c.json({ error: "Technicians cannot view leads" }, 403);

  const { id } = c.req.valid("param");
  const lead = await get<Lead>(`${LEAD_SELECT} WHERE l.id = ? AND l.organization_id = ?`, [id, actorOrganizationId(c)]);
  if (!lead) return c.json({ error: "Lead not found" }, 404);
  return c.json({ lead }, 200);
});

const getLeadStatusHistoryRoute = createRoute({
  method: "get",
  path: "/api/leads/{id}/status-history",
  request: { params: IdParam },
  responses: {
    200: { description: "Lead status history", content: { "application/json": { schema: z.object({ history: z.array(LeadStatusHistorySchema) }) } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(getLeadStatusHistoryRoute, async (c) => {
  const me = currentUser(c);
  if (me.role === "technician") return c.json({ error: "Technicians cannot view leads" }, 403);

  const { id } = c.req.valid("param");
  const lead = await get<{ id: number }>("SELECT id FROM leads WHERE id = ? AND organization_id = ?", [id, actorOrganizationId(c)]);
  if (!lead) return c.json({ error: "Lead not found" }, 404);

  const history = await query<z.infer<typeof LeadStatusHistorySchema>>(
    "SELECT * FROM lead_status_history WHERE lead_id = ? ORDER BY created_at DESC, id DESC", [id]
  );
  return c.json({ history }, 200);
});

const createLead = createRoute({
  method: "post",
  path: "/api/leads",
  request: {
    body: {
      content: { "application/json": { schema: z.object({
        name: z.string(),
        phone: z.string().optional(),
        email: z.string().optional(),
        address: z.string().optional(),
        city: z.string().optional(),
        state: z.string().optional(),
        zip: z.string().optional(),
        assigned_user_id: z.number().int().nullable().optional(),
        referral_source: z.string().optional(),
        referral_name: z.string().optional(),
        referred_by_customer_id: z.number().int().nullable().optional(),
        program_interest: z.string().nullable().optional(),
        estimated_value_cents: z.number().int().nullable().optional(),
        estimate_notes: z.string().optional(),
        notes: z.string().optional(),
      }).strict() } },
    },
  },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: LeadSchema } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(createLead, async (c) => {
  const me = currentUser(c);
  if (me.role === "technician") return c.json({ error: "Technicians cannot create leads" }, 403);

  const data = c.req.valid("json");
  if (!data.name.trim()) return c.json({ error: "Name is required" }, 400);

  if (data.assigned_user_id !== undefined && data.assigned_user_id !== null) {
    const err = await validateLeadAssigneeUserId(actorOrganizationId(c), data.assigned_user_id);
    if (err) return c.json({ error: err }, 400);
  }

  let referral;
  try {
    // A brand-new Lead has no id yet — same reasoning as createCustomer.
    referral = await resolveReferralAttribution(actorOrganizationId(c), data, null, null);
  } catch (err) {
    if (err instanceof CustomerValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }

  // Identifier generation (and its counter mutation) happens ONLY after every
  // validation above has already passed — unlike createJob (which allocates
  // an identifier before its conflict-check for reasons specific to resolving
  // service-type defaults first), nothing about Lead creation requires
  // touching the counter before validation is fully settled, so a rejected
  // create never advances lead_counter.
  const identifier = await nextLeadIdentifier();

  // status is always the workflow's entry status ("new") — never client-
  // supplied; lost_reason/lost_reason_note/converted_* are entirely
  // workflow-/conversion-owned and are not part of this schema at all.
  await run(
    `INSERT INTO leads (identifier, organization_id, name, phone, email, address, city, state, zip, status,
       assigned_user_id, referral_source, referral_name, referred_by_customer_id,
       program_interest, estimated_value_cents, estimate_notes, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      identifier, actorOrganizationId(c), data.name, data.phone || "", data.email || "", data.address || "",
      data.city || "", data.state || "", data.zip || "",
      data.assigned_user_id ?? null,
      referral.referral_source, referral.referral_name, referral.referred_by_customer_id,
      data.program_interest ?? null, data.estimated_value_cents ?? null, data.estimate_notes || "",
      data.notes || "",
    ]
  );
  const lead = await get<Lead>(`${LEAD_SELECT} WHERE l.identifier = ?`, [identifier]);
  // Initial history row — same precedent as createJob: no prior status to
  // transition FROM, so this is a direct insert, not a transitionLead() call
  // (transitionLead() requires an existing row to read a "from" status out
  // of). `me` is the real session user resolved at the top of this handler.
  await run(
    "INSERT INTO lead_status_history (lead_id, old_status, new_status, actor_user_id, reason) VALUES (?, NULL, 'new', ?, ?)",
    [lead!.id, me.id, "Lead created"]
  );
  return c.json(lead!, 201);
});

const updateLead = createRoute({
  method: "put",
  path: "/api/leads/{id}",
  request: {
    params: IdParam,
    body: {
      content: { "application/json": { schema: z.object({
        name: z.string().optional(),
        phone: z.string().optional(),
        email: z.string().optional(),
        address: z.string().optional(),
        city: z.string().optional(),
        state: z.string().optional(),
        zip: z.string().optional(),
        assigned_user_id: z.number().int().nullable().optional(),
        referral_source: z.string().optional(),
        referral_name: z.string().optional(),
        referred_by_customer_id: z.number().int().nullable().optional(),
        program_interest: z.string().nullable().optional(),
        estimated_value_cents: z.number().int().nullable().optional(),
        estimate_notes: z.string().optional(),
        notes: z.string().optional(),
      }).strict() } },
      // id/identifier/status/lost_reason/lost_reason_note/converted_customer_id/
      // converted_at/converted_by/created_at/updated_at/actor identity fields
      // are all deliberately absent from this schema — .strict() rejects them
      // with a 400 rather than silently discarding them, same convention as
      // updateJob's exclusion of `status`. Status can ONLY change through
      // POST /api/leads/{id}/transition.
    },
  },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: OkSchema } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const LEAD_REFERRAL_FIELDS = new Set(["referral_source", "referral_name", "referred_by_customer_id"]);

app.openapi(updateLead, async (c) => {
  const me = currentUser(c);
  if (me.role === "technician") return c.json({ error: "Technicians cannot edit leads" }, 403);

  const { id } = c.req.valid("param");
  const data = c.req.valid("json");

  const existing = await get<{ referral_source: string; referral_name: string; referred_by_customer_id: number | null }>(
    "SELECT referral_source, referral_name, referred_by_customer_id FROM leads WHERE id = ? AND organization_id = ?",
    [id, actorOrganizationId(c)]
  );
  if (!existing) return c.json({ error: "Lead not found" }, 404);

  if (data.name !== undefined && !data.name.trim()) return c.json({ error: "Name is required" }, 400);

  if (data.assigned_user_id !== undefined && data.assigned_user_id !== null) {
    const err = await validateLeadAssigneeUserId(actorOrganizationId(c), data.assigned_user_id);
    if (err) return c.json({ error: err }, 400);
  }

  const fields: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined && !LEAD_REFERRAL_FIELDS.has(k)) {
      fields.push(`${k} = ?`);
      vals.push(v);
    }
  }

  // Referral fields resolved together whenever the request touches ANY of
  // the 3 — same "effective post-update state, stale values force-cleared"
  // pattern as updateCustomer, reusing the identical validator.
  if (Object.keys(data).some((k) => LEAD_REFERRAL_FIELDS.has(k))) {
    try {
      const referral = await resolveReferralAttribution(actorOrganizationId(c), data, existing, null);
      fields.push("referral_source = ?", "referral_name = ?", "referred_by_customer_id = ?");
      vals.push(referral.referral_source, referral.referral_name, referral.referred_by_customer_id);
    } catch (err) {
      if (err instanceof CustomerValidationError) return c.json({ error: err.message }, 400);
      throw err;
    }
  }

  if (fields.length > 0) {
    fields.push("updated_at = datetime('now')");
    await run(`UPDATE leads SET ${fields.join(", ")} WHERE id = ?`, [...vals, id]);
  }
  return c.json({ ok: true }, 200);
});

const transitionLeadRoute = createRoute({
  method: "post",
  path: "/api/leads/{id}/transition",
  request: {
    params: IdParam,
    body: {
      content: { "application/json": { schema: z.object({
        to_status: z.string(),
        reason: z.string().optional(),
        lost_reason: z.string().optional(),
        lost_reason_note: z.string().optional(),
      }).strict() } },
      // .strict() here is a deliberate strengthening beyond transitionJobRoute's
      // own (non-strict) body schema — this task explicitly requires unknown/
      // mass-assignment fields to be rejected, not silently stripped, and a
      // client-supplied actor_user_id/role on this route is exactly the kind
      // of field that must never be silently accepted even if unused.
    },
  },
  responses: {
    200: { description: "Transitioned", content: { "application/json": { schema: z.object({ lead: LeadSchema }) } } },
    400: { description: "Missing or invalid data", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Invalid transition or stale-state conflict", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(transitionLeadRoute, async (c) => {
  const me = currentUser(c);
  if (me.role === "technician") return c.json({ error: "Technicians cannot manage leads" }, 403);

  const { id } = c.req.valid("param");
  const body = c.req.valid("json");

  try {
    // The real, authenticated session actor is the only source of identity
    // ever passed here — never anything from `body` (the schema above
    // structurally has no actor field to even read).
    await transitionLead(c.env.DB, Number(id), {
      toStatus: body.to_status,
      actorUserId: me.id,
      organizationId: actorOrganizationId(c),
      reason: body.reason,
      lostReason: body.lost_reason,
      lostReasonNote: body.lost_reason_note,
    });
  } catch (err) {
    if (err instanceof LeadWorkflowError) {
      const statusMap = { not_found: 404, invalid_transition: 409, missing_data: 400, conflict: 409 } as const;
      return c.json({ error: err.message }, statusMap[err.code]);
    }
    throw err;
  }

  const lead = await get<Lead>(`${LEAD_SELECT} WHERE l.id = ?`, [id]);
  return c.json({ lead: lead! }, 200);
});

// Phase 8.3 — Lead conversion. Request body is intentionally empty
// (`.strict()` on `{}`) — this v1 has no client-supplied duplicate-
// resolution field (see lead-conversion.ts's module doc: an ambiguous
// multi-customer match is a deterministic 409, not something the client can
// resolve inline yet), so there is nothing legitimate for a client to send
// at all; anything sent is rejected rather than silently ignored, same
// mass-assignment discipline as every other Lead route.
const convertLeadRoute = createRoute({
  method: "post",
  path: "/api/leads/{id}/convert",
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: z.object({}).strict() } } },
  },
  responses: {
    200: { description: "Converted — existing customer reused (idempotent-style: returns the prior conversion result)", content: { "application/json": { schema: z.object({ lead: LeadSchema, customer: CustomerSchema, created: z.boolean() }) } } },
    201: { description: "Converted — new customer created", content: { "application/json": { schema: z.object({ lead: LeadSchema, customer: CustomerSchema, created: z.boolean() }) } } },
    400: { description: "Invalid referral attribution", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Already converted, invalid Lead state, ambiguous Customer match, or concurrency conflict", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(convertLeadRoute, async (c) => {
  const me = currentUser(c);
  if (me.role === "technician") return c.json({ error: "Technicians cannot manage leads" }, 403);

  const { id } = c.req.valid("param");

  let outcome;
  try {
    // The real, authenticated session actor is the only source of identity
    // ever passed here — the request schema above has no actor field at
    // all to even read one from.
    outcome = await convertLead(c.env.DB, Number(id), { actorUserId: me.id, organizationId: actorOrganizationId(c) });
  } catch (err) {
    if (err instanceof LeadConversionError) {
      const statusMap = { not_found: 404, invalid_state: 409, ambiguous_match: 409, conflict: 409 } as const;
      return c.json({ error: err.message }, statusMap[err.code]);
    }
    if (err instanceof CustomerValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }

  const lead = await get<Lead>(`${LEAD_SELECT} WHERE l.id = ?`, [id]);
  const customer = await get<Customer>(
    `SELECT c.*, rb.name as referred_by_customer_name, ${CUSTOMER_REBATE_PROFILE_OVERRIDE_COLUMNS}
     FROM customers c LEFT JOIN customers rb ON c.referred_by_customer_id = rb.id
     ${CUSTOMER_REBATE_PROFILE_JOIN}
     WHERE c.id = ?`,
    [outcome.customerId]
  );
  return c.json({ lead: lead!, customer: customer!, created: outcome.created }, outcome.created ? 201 : 200);
});

// ── Lead notification preferences & history (Phase 9.3) ─────────────
// Same blanket technician-block as every other Lead route. A converted
// Lead and its resulting Customer remain separate records with
// potentially separate preference rows — this phase does not merge them.

const getLeadNotificationPreferences = createRoute({
  method: "get",
  path: "/api/leads/{id}/notification-preferences",
  request: { params: IdParam },
  responses: {
    200: { description: "Effective notification preferences", content: { "application/json": { schema: z.any() } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(getLeadNotificationPreferences, async (c) => {
  const me = currentUser(c);
  if (me.role === "technician") return c.json({ error: "Technicians cannot manage leads" }, 403);
  const { id } = c.req.valid("param");
  const lead = await get<{ id: number }>("SELECT id FROM leads WHERE id = ? AND organization_id = ?", [id, actorOrganizationId(c)]);
  if (!lead) return c.json({ error: "Lead not found" }, 404);
  const preferences = await getPreferencesView("lead", Number(id));
  return c.json({ preferences, sms_consent_sources: CONSENT_SOURCES }, 200);
});

const updateLeadNotificationPreferences = createRoute({
  method: "put",
  path: "/api/leads/{id}/notification-preferences",
  request: { params: IdParam, body: { content: { "application/json": { schema: PreferenceUpdateBody } } } },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: z.any() } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(updateLeadNotificationPreferences, async (c) => {
  const me = currentUser(c);
  if (me.role === "technician") return c.json({ error: "Technicians cannot manage leads" }, 403);
  const { id } = c.req.valid("param");
  const lead = await get<{ id: number }>("SELECT id FROM leads WHERE id = ? AND organization_id = ?", [id, actorOrganizationId(c)]);
  if (!lead) return c.json({ error: "Lead not found" }, 404);
  const data = c.req.valid("json");
  try {
    const preferences = await updatePreferences("lead", Number(id), {
      emailEnabled: data.email_enabled, smsEnabled: data.sms_enabled, smsConsentSource: data.sms_consent_source,
    });
    // Phase 9.5 browser verification fix — see the identical Customer route
    // above for the full explanation (missing sms_consent_sources here used
    // to crash the Enable SMS modal after any prior preference mutation).
    return c.json({ preferences, sms_consent_sources: CONSENT_SOURCES }, 200);
  } catch (err) {
    if (err instanceof PreferenceUpdateError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

const getLeadNotifications = createRoute({
  method: "get",
  path: "/api/leads/{id}/notifications",
  request: { params: IdParam, query: NotificationHistoryQuery },
  responses: {
    200: { description: "Notification history", content: { "application/json": { schema: z.any() } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(getLeadNotifications, async (c) => {
  const me = currentUser(c);
  if (me.role === "technician") return c.json({ error: "Technicians cannot manage leads" }, 403);
  const { id } = c.req.valid("param");
  const lead = await get<{ id: number }>("SELECT id FROM leads WHERE id = ? AND organization_id = ?", [id, actorOrganizationId(c)]);
  if (!lead) return c.json({ error: "Lead not found" }, 404);
  const { limit, offset } = parseHistoryPagination(c.req.valid("query"));
  const page = await getLeadNotificationHistory(Number(id), limit, offset);
  return c.json(page, 200);
});

// ── Technicians ────────────────────────────────────────────────────

/** A technician's linked login (for the Phase 8 mobile flow) must point at a real,
 *  unassigned user with role "technician" — otherwise a dispatcher could silently
 *  link a technician profile to someone else's admin/dispatcher account. Returns
 *  an error string to surface as a 400, or null if `userId` is valid to assign. */
async function validateTechnicianUserId(organizationId: number, userId: number | null, excludeTechnicianId?: number): Promise<string | null> {
  if (userId === null) return null;
  const user = await get<{ id: number; role: string }>(
    "SELECT id, role FROM users WHERE id = ? AND organization_id = ?", [userId, organizationId]
  );
  if (!user) return "Linked user not found";
  if (user.role !== "technician") return "Linked user must have the Technician role";
  const existing = await get<{ id: number }>(
    "SELECT id FROM technicians WHERE user_id = ? AND id != ?", [userId, excludeTechnicianId ?? -1]
  );
  if (existing) return "That user is already linked to another technician profile";
  return null;
}

const listTechnicians = createRoute({
  method: "get",
  path: "/api/technicians",
  responses: {
    200: {
      description: "All technicians",
      content: { "application/json": { schema: z.object({ technicians: z.array(TechnicianSchema) }) } },
    },
  },
});

app.openapi(listTechnicians, async (c) => {
  const technicians = await query<Technician>(
    `SELECT t.*, u.email as user_email, COALESCE(jc.cnt, 0) as job_count
     FROM technicians t
     LEFT JOIN users u ON u.id = t.user_id
     LEFT JOIN (SELECT technician_id, COUNT(*) as cnt FROM jobs WHERE status IN (${ACTIVE_STATUSES.map(() => "?").join(",")}) GROUP BY technician_id) jc ON jc.technician_id = t.id
     WHERE t.organization_id = ?
     ORDER BY t.name ASC`,
    [...ACTIVE_STATUSES, actorOrganizationId(c)]
  );
  return c.json({ technicians }, 200);
});

const listAllTechnicians = createRoute({
  method: "get",
  path: "/api/technicians/all",
  responses: {
    200: {
      description: "Active technicians (for dropdowns)",
      content: { "application/json": { schema: z.object({ technicians: z.array(z.object({ id: z.number().int(), name: z.string(), color: z.string() })) }) } },
    },
  },
});

app.openapi(listAllTechnicians, async (c) => {
  const technicians = await query<Pick<Technician, "id" | "name" | "color">>(
    "SELECT id, name, color FROM technicians WHERE organization_id = ? AND active = 1 ORDER BY name ASC",
    [actorOrganizationId(c)]
  );
  return c.json({ technicians }, 200);
});

const createTechnician = createRoute({
  method: "post",
  path: "/api/technicians",
  request: {
    body: {
      content: { "application/json": { schema: z.object({
        name: z.string(),
        email: z.string().optional(),
        phone: z.string().optional(),
        color: z.string().optional(),
        user_id: z.number().int().nullable().optional(),
      }) } },
    },
  },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: TechnicianSchema } } },
    400: { description: "Invalid linked user", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(createTechnician, async (c) => {
  const data = c.req.valid("json");
  const organizationId = actorOrganizationId(c);
  const userIdError = await validateTechnicianUserId(organizationId, data.user_id ?? null);
  if (userIdError) return c.json({ error: userIdError }, 400);
  const insertResult = await run(
    "INSERT INTO technicians (organization_id, name, email, phone, color, user_id) VALUES (?, ?, ?, ?, ?, ?)",
    [organizationId, data.name, data.email || "", data.phone || "", data.color || "#16a34a", data.user_id ?? null]
  );
  const tech = await get<Technician>("SELECT * FROM technicians WHERE id = ?", [insertResult.lastInsertRowid]);
  return c.json(tech!, 201);
});

const updateTechnician = createRoute({
  method: "put",
  path: "/api/technicians/{id}",
  request: {
    params: IdParam,
    body: {
      content: { "application/json": { schema: z.object({
        name: z.string().optional(),
        email: z.string().optional(),
        phone: z.string().optional(),
        color: z.string().optional(),
        active: z.number().int().optional(),
        user_id: z.number().int().nullable().optional(),
      }) } },
    },
  },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: OkSchema } } },
    400: { description: "Invalid linked user", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(updateTechnician, async (c) => {
  const { id } = c.req.valid("param");
  const data = c.req.valid("json");
  const organizationId = actorOrganizationId(c);
  const owned = await get<{ id: number }>(
    "SELECT id FROM technicians WHERE id = ? AND organization_id = ?", [id, organizationId]
  );
  if (!owned) return c.json({ ok: true }, 200); // matches this route's pre-existing no-op-on-unknown-id behavior
  if (data.user_id !== undefined) {
    const userIdError = await validateTechnicianUserId(organizationId, data.user_id, Number(id));
    if (userIdError) return c.json({ error: userIdError }, 400);
  }
  const fields: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined) {
      fields.push(`${k} = ?`);
      vals.push(v);
    }
  }
  if (fields.length > 0) {
    await run(`UPDATE technicians SET ${fields.join(", ")} WHERE id = ?`, [...vals, id]);
  }
  return c.json({ ok: true }, 200);
});

const deleteTechnician = createRoute({
  method: "delete",
  path: "/api/technicians/{id}",
  request: { params: IdParam },
  responses: {
    200: { description: "Deleted", content: { "application/json": { schema: OkSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(deleteTechnician, async (c) => {
  const me = currentUser(c);
  // Admin-only, not dispatcher: a technician row is a staff/personnel record
  // (can be linked to a login via technicians.user_id), same sensitivity class
  // as /api/users/* which is also admin-only — not an "operational record" a
  // dispatcher manages day to day.
  if (me.role !== "admin") return c.json({ error: "Forbidden" }, 403);

  const { id } = c.req.valid("param");
  await run("DELETE FROM technicians WHERE id = ? AND organization_id = ?", [id, actorOrganizationId(c)]);
  return c.json({ ok: true }, 200);
});

// ── Assets / Equipment (Phase 11.4) ──────────────────────────────────
//
// Core term is "Asset"; UI may label it "Equipment" for HVAC users (see
// customer-assets.tsx/job-assets.tsx). ASSET_TYPE_REGISTRY is composed here
// (index.ts is an allowed architecture-guard composition root) from Core's
// own empty base plus the HVAC module's contributed type list — mirrors
// Phase 11.2's JOB_TYPE_REGISTRY pattern for "avoid an HVAC-only Core
// union," but needs no composition-root exception in assets.ts itself:
// there's no per-type engine behavior to close over, just a flat label
// lookup used for validation (below) and the GET /api/assets/types listing
// endpoint. src/server/assets.ts (Core) never imports this registry or any
// modules/** path.
const ASSET_TYPE_REGISTRY: Record<string, { label: string }> = { ...HVAC_ASSET_TYPES };
const ASSET_TYPES = Object.keys(ASSET_TYPE_REGISTRY);

const AssetSchema = z.object({
  id: z.number().int(),
  customer_id: z.number().int(),
  asset_type: z.string(),
  display_name: z.string(),
  manufacturer: z.string(),
  model: z.string(),
  serial_number: z.string(),
  installation_date: z.string().nullable(),
  status: z.string(),
  notes: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
}).openapi("Asset");

/** organization_id is deliberately never part of this schema (request or
 *  response) — mass-assignment protection matching every other tenant-
 *  scoped resource in this app; it is always server-derived from
 *  actorOrganizationId(c), never client-supplied. */
const AssetInputSchema = z.object({
  customer_id: z.number().int(),
  asset_type: z.enum(ASSET_TYPES as [string, ...string[]]).optional(),
  display_name: z.string().max(200).optional(),
  manufacturer: z.string().max(200).optional(),
  model: z.string().max(200).optional(),
  serial_number: z.string().max(200).optional(),
  installation_date: z.string().nullable().optional(),
  status: z.enum(ASSET_STATUSES as [string, ...string[]]).optional(),
  notes: z.string().max(2000).optional(),
}).strict();

const AssetUpdateInputSchema = AssetInputSchema.partial().strict();

/** createAsset/updateAsset can only ever throw "invalid_customer" (404) or
 *  "invalid_date" (400) — narrowly typed per call site (rather than one
 *  generically-typed helper covering every AssetError code) so each
 *  route's actual, smaller set of possible response statuses matches what
 *  its own OpenAPI `responses` declares. updateAsset has its own, wider
 *  mapping below (it can also throw "reparent_blocked", 409). */
function createAssetErrorResponse(err: AssetError): { body: { error: string }; status: 400 | 404 } {
  if (err.code === "invalid_customer") return { body: { error: "Customer not found" }, status: 404 };
  return { body: { error: err.message }, status: 400 };
}

function updateAssetErrorResponse(err: AssetError): { body: { error: string }; status: 400 | 404 | 409 } {
  if (err.code === "invalid_customer") return { body: { error: "Customer not found" }, status: 404 };
  if (err.code === "reparent_blocked") return { body: { error: err.message }, status: 409 };
  return { body: { error: err.message }, status: 400 };
}

const listAssetTypes = createRoute({
  method: "get",
  path: "/api/assets/types",
  responses: {
    200: {
      description: "Known asset types (Core + HVAC module contributions)",
      content: { "application/json": { schema: z.object({ types: z.array(z.object({ key: z.string(), label: z.string() })) }) } },
    },
  },
});

app.openapi(listAssetTypes, async (c) => {
  const types = Object.entries(ASSET_TYPE_REGISTRY).map(([key, v]) => ({ key, label: v.label }));
  return c.json({ types }, 200);
});

const listAssetsRoute = createRoute({
  method: "get",
  path: "/api/assets",
  request: {
    query: z.object({
      customer_id: z.string().optional(),
      asset_type: z.string().optional(),
      status: z.string().optional(),
      manufacturer: z.string().max(200).optional(),
      search: z.string().max(200).optional(),
      limit: z.string().optional(),
      offset: z.string().optional(),
    }),
  },
  responses: {
    200: { description: "Assets", content: { "application/json": { schema: z.object({ assets: z.array(AssetSchema), total: z.number().int() }) } } },
    400: { description: "Search or manufacturer filter is too complex", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(listAssetsRoute, async (c) => {
  const me = currentUser(c);
  if (!canManageAssets({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);

  const q = c.req.valid("query");
  const limit = Math.min(Math.max(parseInt(q.limit || "50", 10) || 50, 1), 200);
  const offset = Math.max(parseInt(q.offset || "0", 10) || 0, 0);
  try {
    const { assets, total } = await listAssets(
      actorOrganizationId(c),
      {
        customer_id: q.customer_id ? Number(q.customer_id) : undefined,
        asset_type: q.asset_type,
        status: q.status,
        manufacturer: q.manufacturer,
        search: q.search,
      },
      limit, offset
    );
    return c.json({ assets, total }, 200);
  } catch (err) {
    // Security-review finding (Phase 11.4): a wildcard-dense manufacturer/
    // search value must produce this clean 400, never an uncaught D1 "LIKE
    // pattern too complex" 500 — see assertSearchableFilter in assets.ts.
    if (err instanceof AssetError && err.code === "invalid_filter") return c.json({ error: err.message }, 400);
    throw err;
  }
});

const createAssetRoute = createRoute({
  method: "post",
  path: "/api/assets",
  request: { body: { content: { "application/json": { schema: AssetInputSchema } } } },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: z.object({ asset: AssetSchema }) } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Customer not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(createAssetRoute, async (c) => {
  const me = currentUser(c);
  if (!canManageAssets({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);

  const data = c.req.valid("json");
  try {
    const asset = await createAsset(actorOrganizationId(c), data);
    return c.json({ asset }, 201);
  } catch (err) {
    if (err instanceof AssetError) {
      const { body, status } = createAssetErrorResponse(err);
      return c.json(body, status);
    }
    throw err;
  }
});

const getAssetRoute = createRoute({
  method: "get",
  path: "/api/assets/{id}",
  request: { params: IdParam },
  responses: {
    200: { description: "Asset detail", content: { "application/json": { schema: z.object({ asset: AssetSchema }) } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(getAssetRoute, async (c) => {
  const me = currentUser(c);
  if (!canManageAssets({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);

  const { id } = c.req.valid("param");
  const asset = await getAsset(actorOrganizationId(c), Number(id));
  if (!asset) return c.json({ error: "Asset not found" }, 404);
  return c.json({ asset }, 200);
});

const updateAssetRoute = createRoute({
  method: "put",
  path: "/api/assets/{id}",
  request: { params: IdParam, body: { content: { "application/json": { schema: AssetUpdateInputSchema } } } },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: z.object({ asset: AssetSchema }) } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Cannot reassign to a different customer while linked to a job", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(updateAssetRoute, async (c) => {
  const me = currentUser(c);
  if (!canManageAssets({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);

  const { id } = c.req.valid("param");
  const data = c.req.valid("json");
  try {
    const asset = await updateAsset(actorOrganizationId(c), Number(id), data);
    if (!asset) return c.json({ error: "Asset not found" }, 404);
    return c.json({ asset }, 200);
  } catch (err) {
    if (err instanceof AssetError) {
      const { body, status } = updateAssetErrorResponse(err);
      return c.json(body, status);
    }
    throw err;
  }
});

const deleteAssetRoute = createRoute({
  method: "delete",
  path: "/api/assets/{id}",
  request: { params: IdParam },
  responses: {
    200: { description: "Deleted", content: { "application/json": { schema: OkSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Still linked to a job — retire instead", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(deleteAssetRoute, async (c) => {
  const me = currentUser(c);
  if (!canDeleteAsset({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);

  const { id } = c.req.valid("param");
  try {
    const deleted = await deleteAsset(actorOrganizationId(c), Number(id));
    if (!deleted) return c.json({ error: "Asset not found" }, 404);
    return c.json({ ok: true }, 200);
  } catch (err) {
    // deleteAsset only ever throws AssetError("referenced", ...) — the
    // "asset doesn't exist" case is a plain `false` return, handled above.
    if (err instanceof AssetError) return c.json({ error: err.message }, 409);
    throw err;
  }
});

// ── Job <-> Asset linking ─────────────────────────────────────────────

const listJobAssetsRoute = createRoute({
  method: "get",
  path: "/api/jobs/{id}/assets",
  request: { params: IdParam },
  responses: {
    200: { description: "Assets linked to this job", content: { "application/json": { schema: z.object({ assets: z.array(AssetSchema) }) } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(listJobAssetsRoute, async (c) => {
  const { id } = c.req.valid("param");
  const job = await get<{ id: number; technician_id: number | null }>(
    "SELECT id, technician_id FROM jobs WHERE id = ? AND organization_id = ?", [id, actorOrganizationId(c)]
  );
  if (!job) return c.json({ error: "Job not found" }, 404);
  // Same ownership predicate as getJob (mem:risks/technician-job-read-scoping)
  // — admin/dispatcher any job in their org, a technician only their own
  // assigned job. A technician never gets general Asset list/detail access
  // (canManageAssets above), only this job-scoped, read-only view.
  const me = currentUser(c);
  if (!(await canActorAccessJobCompliance({ id: me.id, role: me.role }, job))) {
    return c.json({ error: "You are not permitted to view this job" }, 403);
  }
  const assets = await listAssetsForJob(actorOrganizationId(c), Number(id));
  return c.json({ assets: assets ?? [] }, 200);
});

const linkJobAssetRoute = createRoute({
  method: "post",
  path: "/api/jobs/{id}/assets",
  request: { params: IdParam, body: { content: { "application/json": { schema: z.object({ asset_id: z.number().int() }).strict() } } } },
  responses: {
    201: { description: "Linked", content: { "application/json": { schema: z.object({ ok: z.boolean() }) } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Cross-customer mismatch or already linked", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(linkJobAssetRoute, async (c) => {
  const me = currentUser(c);
  // Blanket technician block, matching updateJob's own precedent (mem:risks/
  // job-update-ownership-bypass) — no legitimate technician use case exists
  // for modifying a job's linked equipment, even their own assigned job.
  if (me.role === "technician") return c.json({ error: "Forbidden" }, 403);

  const { id } = c.req.valid("param");
  const { asset_id } = c.req.valid("json");
  try {
    await linkAssetToJob(actorOrganizationId(c), Number(id), asset_id);
    return c.json({ ok: true }, 201);
  } catch (err) {
    if (err instanceof AssetError) {
      if (err.code === "not_found") return c.json({ error: err.message }, 404);
      if (err.code === "cross_customer" || err.code === "already_linked") return c.json({ error: err.message }, 409);
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
});

const unlinkJobAssetRoute = createRoute({
  method: "delete",
  path: "/api/jobs/{id}/assets/{assetId}",
  request: { params: z.object({ id: z.string(), assetId: z.string() }) },
  responses: {
    200: { description: "Unlinked", content: { "application/json": { schema: OkSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(unlinkJobAssetRoute, async (c) => {
  const me = currentUser(c);
  if (me.role === "technician") return c.json({ error: "Forbidden" }, 403);

  const { id, assetId } = c.req.valid("param");
  const result = await unlinkAssetFromJob(actorOrganizationId(c), Number(id), Number(assetId));
  if (result === "job_not_found") return c.json({ error: "Job not found" }, 404);
  return c.json({ ok: true }, 200);
});

// ── Quotes / Estimates (Phase 12) ─────────────────────────────────────
//
// Domain/API term "Quote" (Section 5); UI may say "Quote / Estimate". RBAC
// mirrors Leads/Financial exactly (admin/dispatcher manage, technician
// blanket-blocked — canManageQuotes in quotes.ts) since Quotes are a
// front-office/sales concern with no field-work component. Server always
// computes totals (Section 10/23/28) — no route below ever accepts a
// total_cents/subtotal_cents/tax_amount_cents/discount_cents field from the
// client; only the INPUTS to that computation (line items, discount type/
// value, tax rate) are ever client-settable, and only while status='draft'
// (enforced independently inside quotes.ts, not just here).

const QuoteLineItemSchema = z.object({
  id: z.number().int(),
  description: z.string(),
  category: z.string(),
  quantity: z.number(),
  unit: z.string(),
  unit_price_cents: z.number().int(),
  total_cents: z.number().int(),
  sort_order: z.number().int(),
  asset_id: z.number().int().nullable(),
}).openapi("QuoteLineItem");

const QuoteVersionSchema = z.object({
  id: z.number().int(),
  quote_id: z.number().int(),
  version_number: z.number().int(),
  subtotal_cents: z.number().int(),
  discount_type: z.string(),
  discount_percent: z.number(),
  discount_cents: z.number().int(),
  tax_rate: z.number(),
  tax_amount_cents: z.number().int(),
  total_cents: z.number().int(),
  notes: z.string(),
  expires_at: z.string().nullable(),
  created_by: z.number().int().nullable(),
  created_at: z.string(),
}).openapi("QuoteVersion");

const QuoteSchema = z.object({
  id: z.number().int(),
  identifier: z.string(),
  customer_id: z.number().int(),
  lead_id: z.number().int().nullable(),
  status: z.string(),
  current_version_id: z.number().int().nullable(),
  accepted_by: z.number().int().nullable(),
  accepted_at: z.string().nullable(),
  accepted_version_id: z.number().int().nullable(),
  rejected_reason: z.string(),
  created_by: z.number().int().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  customer_name: z.string().nullable(),
  lead_identifier: z.string().nullable(),
}).openapi("Quote");

const QuoteStatusHistorySchema = z.object({
  id: z.number().int(),
  quote_id: z.number().int(),
  old_status: z.string().nullable(),
  new_status: z.string(),
  actor_user_id: z.number().int().nullable(),
  reason: z.string(),
  created_at: z.string(),
}).openapi("QuoteStatusHistory");

const LineItemInputSchema = z.object({
  description: z.string().max(500).optional(),
  category: z.enum(LINE_ITEM_CATEGORIES as unknown as [string, ...string[]]).optional(),
  // Matches InvoiceLineInputSchema's quantity.positive() precedent; a
  // negative quantity or price would drive computeQuoteTotals() negative
  // despite its own discount-cap logic (that only clamps discount, not
  // negative line inputs) — a price REDUCTION belongs in the discount
  // fields, never in a line item itself.
  quantity: z.number().positive().optional(),
  unit: z.string().max(50).optional(),
  unit_price_cents: z.number().int().min(0).optional(),
  sort_order: z.number().int().optional(),
  asset_id: z.number().int().nullable().optional(),
}).strict();

/** organization_id, every totals field, version_number, accepted_by/
 *  accepted_at, and the audit actor are all deliberately absent from this
 *  schema — mass-assignment protection (Section 28), matching the
 *  established Asset/Job convention exactly. */
const CreateQuoteInputSchema = z.object({
  customer_id: z.number().int(),
  lead_id: z.number().int().nullable().optional(),
  discount_type: z.enum(DISCOUNT_TYPES as unknown as [string, ...string[]]).optional(),
  discount_percent: z.number().min(0).max(100).optional(),
  discount_cents: z.number().int().min(0).optional(),
  tax_rate: z.number().min(0).max(100).optional(),
  notes: z.string().max(2000).optional(),
  expires_at: z.string().nullable().optional(),
  line_items: z.array(LineItemInputSchema).optional(),
}).strict();

const UpdateVersionInputSchema = z.object({
  discount_type: z.enum(DISCOUNT_TYPES as unknown as [string, ...string[]]).optional(),
  discount_percent: z.number().min(0).max(100).optional(),
  discount_cents: z.number().int().min(0).optional(),
  tax_rate: z.number().min(0).max(100).optional(),
  notes: z.string().max(2000).optional(),
  expires_at: z.string().nullable().optional(),
}).strict();

function quoteErrorToResponse(err: QuoteError): { body: { error: string }; status: 400 | 404 | 409 } {
  if (err.code === "not_found" || err.code === "invalid_customer" || err.code === "invalid_lead" || err.code === "invalid_asset") {
    return { body: { error: err.message }, status: 404 };
  }
  if (err.code === "not_draft" || err.code === "referenced" || err.code === "conflict") {
    return { body: { error: err.message }, status: 409 };
  }
  return { body: { error: err.message }, status: 400 };
}

const listQuotesRoute = createRoute({
  method: "get",
  path: "/api/quotes",
  request: {
    query: z.object({
      status: z.string().optional(),
      customer_id: z.string().optional(),
      lead_id: z.string().optional(),
      search: z.string().max(200).optional(),
      limit: z.string().optional(),
      offset: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Quotes",
      content: { "application/json": { schema: z.object({ quotes: z.array(QuoteSchema.extend({ total_cents: z.number().int().nullable() })), total: z.number().int() }) } },
    },
    400: { description: "Invalid search filter", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(listQuotesRoute, async (c) => {
  const me = currentUser(c);
  if (!canManageQuotes({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);

  const q = c.req.valid("query");
  const limit = Math.min(Math.max(parseInt(q.limit || "50", 10) || 50, 1), 200);
  const offset = Math.max(parseInt(q.offset || "0", 10) || 0, 0);
  try {
    const { quotes, total } = await listQuotes(
      actorOrganizationId(c),
      {
        status: q.status,
        customer_id: q.customer_id ? Number(q.customer_id) : undefined,
        lead_id: q.lead_id ? Number(q.lead_id) : undefined,
        search: q.search,
      },
      limit, offset
    );
    return c.json({ quotes, total }, 200);
  } catch (err) {
    if (err instanceof QuoteError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

const createQuoteRoute = createRoute({
  method: "post",
  path: "/api/quotes",
  request: { body: { content: { "application/json": { schema: CreateQuoteInputSchema } } } },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: z.object({ quote: QuoteSchema }) } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Customer or lead not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Conflict", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(createQuoteRoute, async (c) => {
  const me = currentUser(c);
  if (!canManageQuotes({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);

  const data = c.req.valid("json");
  try {
    const quote = await createQuote(actorOrganizationId(c), me.id, data);
    return c.json({ quote }, 201);
  } catch (err) {
    if (err instanceof QuoteError) {
      const { body, status } = quoteErrorToResponse(err);
      return c.json(body, status);
    }
    throw err;
  }
});

const getQuoteRoute = createRoute({
  method: "get",
  path: "/api/quotes/{id}",
  request: { params: IdParam },
  responses: {
    200: {
      description: "Quote detail",
      content: { "application/json": { schema: z.object({ quote: QuoteSchema, version: QuoteVersionSchema.extend({ line_items: z.array(QuoteLineItemSchema) }).nullable() }) } },
    },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(getQuoteRoute, async (c) => {
  const me = currentUser(c);
  if (!canManageQuotes({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);

  const { id } = c.req.valid("param");
  const quote = await getQuote(actorOrganizationId(c), Number(id));
  if (!quote) return c.json({ error: "Quote not found" }, 404);
  const version = quote.current_version_id !== null ? await getQuoteVersion(quote.id, quote.current_version_id) : null;
  return c.json({ quote, version }, 200);
});

const deleteQuoteRoute = createRoute({
  method: "delete",
  path: "/api/quotes/{id}",
  request: { params: IdParam },
  responses: {
    200: { description: "Deleted", content: { "application/json": { schema: OkSchema } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Cannot delete a quote with transition history", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(deleteQuoteRoute, async (c) => {
  const me = currentUser(c);
  if (!canManageQuotes({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);

  const { id } = c.req.valid("param");
  try {
    const deleted = await deleteQuote(actorOrganizationId(c), Number(id));
    if (!deleted) return c.json({ error: "Quote not found" }, 404);
    return c.json({ ok: true }, 200);
  } catch (err) {
    if (err instanceof QuoteError) {
      const { body, status } = quoteErrorToResponse(err);
      return c.json(body, status);
    }
    throw err;
  }
});

const updateQuoteVersionRoute = createRoute({
  method: "put",
  path: "/api/quotes/{id}/version",
  request: { params: IdParam, body: { content: { "application/json": { schema: UpdateVersionInputSchema } } } },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: z.object({ version: QuoteVersionSchema }) } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Quote is not in draft status", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(updateQuoteVersionRoute, async (c) => {
  const me = currentUser(c);
  if (!canManageQuotes({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);

  const { id } = c.req.valid("param");
  const data = c.req.valid("json");
  try {
    const version = await updateQuoteVersion(actorOrganizationId(c), Number(id), data);
    return c.json({ version }, 200);
  } catch (err) {
    if (err instanceof QuoteError) {
      const { body, status } = quoteErrorToResponse(err);
      return c.json(body, status);
    }
    throw err;
  }
});

const addLineItemRoute = createRoute({
  method: "post",
  path: "/api/quotes/{id}/line-items",
  request: { params: IdParam, body: { content: { "application/json": { schema: LineItemInputSchema } } } },
  responses: {
    201: { description: "Added", content: { "application/json": { schema: z.object({ version: QuoteVersionSchema }) } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Quote is not in draft status", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(addLineItemRoute, async (c) => {
  const me = currentUser(c);
  if (!canManageQuotes({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);

  const { id } = c.req.valid("param");
  const data = c.req.valid("json");
  try {
    const version = await addLineItem(actorOrganizationId(c), Number(id), data);
    return c.json({ version }, 201);
  } catch (err) {
    if (err instanceof QuoteError) {
      const { body, status } = quoteErrorToResponse(err);
      return c.json(body, status);
    }
    throw err;
  }
});

const updateLineItemRoute = createRoute({
  method: "put",
  path: "/api/quotes/{id}/line-items/{lineItemId}",
  request: { params: z.object({ id: z.string(), lineItemId: z.string() }), body: { content: { "application/json": { schema: LineItemInputSchema } } } },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: z.object({ version: QuoteVersionSchema }) } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Quote is not in draft status", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(updateLineItemRoute, async (c) => {
  const me = currentUser(c);
  if (!canManageQuotes({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);

  const { id, lineItemId } = c.req.valid("param");
  const data = c.req.valid("json");
  try {
    const version = await updateLineItem(actorOrganizationId(c), Number(id), Number(lineItemId), data);
    return c.json({ version }, 200);
  } catch (err) {
    if (err instanceof QuoteError) {
      const { body, status } = quoteErrorToResponse(err);
      return c.json(body, status);
    }
    throw err;
  }
});

const deleteLineItemRoute = createRoute({
  method: "delete",
  path: "/api/quotes/{id}/line-items/{lineItemId}",
  request: { params: z.object({ id: z.string(), lineItemId: z.string() }) },
  responses: {
    200: { description: "Removed", content: { "application/json": { schema: z.object({ version: QuoteVersionSchema }) } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Quote is not in draft status", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(deleteLineItemRoute, async (c) => {
  const me = currentUser(c);
  if (!canManageQuotes({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);

  const { id, lineItemId } = c.req.valid("param");
  try {
    const version = await deleteLineItem(actorOrganizationId(c), Number(id), Number(lineItemId));
    return c.json({ version }, 200);
  } catch (err) {
    if (err instanceof QuoteError) {
      const { body, status } = quoteErrorToResponse(err);
      return c.json(body, status);
    }
    throw err;
  }
});

const listQuoteVersionsRoute = createRoute({
  method: "get",
  path: "/api/quotes/{id}/versions",
  request: { params: IdParam },
  responses: {
    200: { description: "Version history", content: { "application/json": { schema: z.object({ versions: z.array(QuoteVersionSchema) }) } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(listQuoteVersionsRoute, async (c) => {
  const me = currentUser(c);
  if (!canManageQuotes({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);

  const { id } = c.req.valid("param");
  const quote = await getQuote(actorOrganizationId(c), Number(id));
  if (!quote) return c.json({ error: "Quote not found" }, 404);
  const versions = await listQuoteVersions(quote.id);
  return c.json({ versions }, 200);
});

const getQuoteVersionRoute = createRoute({
  method: "get",
  path: "/api/quotes/{id}/versions/{versionId}",
  request: { params: z.object({ id: z.string(), versionId: z.string() }) },
  responses: {
    200: { description: "Version detail", content: { "application/json": { schema: z.object({ version: QuoteVersionSchema.extend({ line_items: z.array(QuoteLineItemSchema) }) }) } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(getQuoteVersionRoute, async (c) => {
  const me = currentUser(c);
  if (!canManageQuotes({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);

  const { id, versionId } = c.req.valid("param");
  const quote = await getQuote(actorOrganizationId(c), Number(id));
  if (!quote) return c.json({ error: "Quote not found" }, 404);
  const version = await getQuoteVersion(quote.id, Number(versionId));
  if (!version) return c.json({ error: "Version not found" }, 404);
  return c.json({ version }, 200);
});

const createQuoteRevisionRoute = createRoute({
  method: "post",
  path: "/api/quotes/{id}/revisions",
  request: { params: IdParam, body: { content: { "application/json": { schema: z.object({}).strict() } } } },
  responses: {
    201: { description: "Revision created", content: { "application/json": { schema: z.object({ version: QuoteVersionSchema }) } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "A revision cannot be created from the current status", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(createQuoteRevisionRoute, async (c) => {
  const me = currentUser(c);
  if (!canManageQuotes({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);

  const { id } = c.req.valid("param");
  const organizationId = actorOrganizationId(c);
  const quote = await getQuote(organizationId, Number(id));
  if (!quote) return c.json({ error: "Quote not found" }, 404);
  if (!canCreateRevisionFrom(quote.status)) {
    return c.json({ error: `Cannot create a revision from status "${quote.status}"` }, 409);
  }
  try {
    const version = await createQuoteRevision(organizationId, quote.id, me.id);
    return c.json({ version }, 201);
  } catch (err) {
    if (err instanceof QuoteError) {
      const { body, status } = quoteErrorToResponse(err);
      return c.json(body, status);
    }
    throw err;
  }
});

const getQuoteTransitionsRoute = createRoute({
  method: "get",
  path: "/api/quotes/{id}/transitions",
  request: { params: IdParam },
  responses: {
    200: { description: "Allowed next statuses", content: { "application/json": { schema: z.object({ allowed: z.array(z.string()), can_create_revision: z.boolean() }) } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(getQuoteTransitionsRoute, async (c) => {
  const me = currentUser(c);
  if (!canManageQuotes({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);

  const { id } = c.req.valid("param");
  const quote = await getQuote(actorOrganizationId(c), Number(id));
  if (!quote) return c.json({ error: "Quote not found" }, 404);
  return c.json({ allowed: resolveAllowedQuoteTransitions(quote.status), can_create_revision: canCreateRevisionFrom(quote.status) }, 200);
});

const transitionQuoteRoute = createRoute({
  method: "post",
  path: "/api/quotes/{id}/transition",
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: z.object({ to_status: z.enum(QUOTE_STATUSES as unknown as [string, ...string[]]), reason: z.string().max(2000).optional() }).strict() } } },
  },
  responses: {
    200: { description: "Transitioned", content: { "application/json": { schema: z.object({ quote: QuoteSchema }) } } },
    400: { description: "Invalid transition or missing data", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Conflict — quote changed since last read, or has expired", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(transitionQuoteRoute, async (c) => {
  const me = currentUser(c);
  if (!canManageQuotes({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);

  const { id } = c.req.valid("param");
  const { to_status, reason } = c.req.valid("json");
  try {
    await transitionQuote(c.env.DB, Number(id), { toStatus: to_status, actorUserId: me.id, organizationId: actorOrganizationId(c), reason });
    const quote = await getQuote(actorOrganizationId(c), Number(id));
    if (!quote) return c.json({ error: "Quote not found" }, 404);
    return c.json({ quote }, 200);
  } catch (err) {
    if (err instanceof QuoteWorkflowError) {
      if (err.code === "not_found") return c.json({ error: err.message }, 404);
      if (err.code === "conflict" || err.code === "expired") return c.json({ error: err.message }, 409);
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
});

const getQuoteStatusHistoryRoute = createRoute({
  method: "get",
  path: "/api/quotes/{id}/status-history",
  request: { params: IdParam },
  responses: {
    200: { description: "Status history", content: { "application/json": { schema: z.object({ history: z.array(QuoteStatusHistorySchema) }) } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(getQuoteStatusHistoryRoute, async (c) => {
  const me = currentUser(c);
  if (!canManageQuotes({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);

  const { id } = c.req.valid("param");
  const quote = await getQuote(actorOrganizationId(c), Number(id));
  if (!quote) return c.json({ error: "Quote not found" }, 404);
  const history = await getQuoteStatusHistory(quote.id);
  return c.json({ history }, 200);
});

// ── Contracts / E-Sign (Phase 13) ────────────────────────────────────
// Server-authoritative status/version/hash fields throughout — Contract
// commercial terms are a SNAPSHOT of the Quote's accepted version (Section
// 32), captured once and never recomputed here. No input schema below
// accepts organization_id/status/current_version_id/
// accepted_quote_version_id/document_hash/signed_document_*/token/
// token_hash/created_by/actor fields from the client.

const ContractSignerSchema = z.object({
  id: z.number().int(),
  contract_id: z.number().int(),
  name: z.string(),
  email: z.string(),
  phone: z.string(),
  role: z.string(),
  sort_order: z.number().int(),
  created_at: z.string(),
}).openapi("ContractSigner");

const ContractVersionSchema = z.object({
  id: z.number().int(),
  contract_id: z.number().int(),
  version_number: z.number().int(),
  title: z.string(),
  body: z.string(),
  template_version_id: z.number().int().nullable(),
  commercial_snapshot: z.string(),
  customer_snapshot: z.string(),
  company_snapshot: z.string(),
  effective_date: z.string().nullable(),
  expires_at: z.string().nullable(),
  document_hash: z.string().nullable(),
  hash_algorithm: z.string(),
  signed_document_hash: z.string().nullable(),
  signed_at: z.string().nullable(),
  created_by: z.number().int().nullable(),
  created_at: z.string(),
}).openapi("ContractVersion");

const ContractSchema = z.object({
  id: z.number().int(),
  identifier: z.string(),
  customer_id: z.number().int(),
  quote_id: z.number().int(),
  accepted_quote_version_id: z.number().int(),
  status: z.string(),
  current_version_id: z.number().int().nullable(),
  voided_at: z.string().nullable(),
  void_reason: z.string(),
  created_by: z.number().int().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  customer_name: z.string().nullable(),
  quote_identifier: z.string().nullable(),
}).openapi("Contract");

// token_hash is deliberately never in this schema — see contracts.ts's
// SIGNATURE_REQUEST_COLUMNS (the storage function itself never selects it
// into any row that could reach this point).
const SignatureRequestSchema = z.object({
  id: z.number().int(),
  contract_id: z.number().int(),
  contract_version_id: z.number().int(),
  signer_id: z.number().int(),
  status: z.string(),
  provider: z.string(),
  provider_request_id: z.string().nullable(),
  expires_at: z.string(),
  consent_text_version: z.string(),
  consent_at: z.string().nullable(),
  signed_at: z.string().nullable(),
  signature_method: z.string().nullable(),
  signer_ip: z.string().nullable(),
  signer_user_agent: z.string().nullable(),
  declined_reason: z.string(),
  created_by: z.number().int().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
}).openapi("SignatureRequest");

const SignatureEventSchema = z.object({
  id: z.number().int(),
  signature_request_id: z.number().int(),
  event_type: z.string(),
  actor_user_id: z.number().int().nullable(),
  ip_address: z.string().nullable(),
  user_agent: z.string().nullable(),
  metadata: z.string(),
  created_at: z.string(),
}).openapi("SignatureEvent");

const ContractStatusHistorySchema = z.object({
  id: z.number().int(),
  contract_id: z.number().int(),
  old_status: z.string().nullable(),
  new_status: z.string(),
  actor_user_id: z.number().int().nullable(),
  reason: z.string(),
  created_at: z.string(),
}).openapi("ContractStatusHistory");

const ContractTemplateSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  active: z.number().int(),
  current_version_id: z.number().int().nullable(),
  created_by: z.number().int().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
}).openapi("ContractTemplate");

const ContractTemplateVersionSchema = z.object({
  id: z.number().int(),
  template_id: z.number().int(),
  version_number: z.number().int(),
  title: z.string(),
  body: z.string(),
  created_by: z.number().int().nullable(),
  created_at: z.string(),
}).openapi("ContractTemplateVersion");

const EvidenceRequestSchema = SignatureRequestSchema.extend({
  signer: ContractSignerSchema.optional(),
  events: z.array(SignatureEventSchema),
});
const EvidencePackageSchema = z.object({
  contract_identifier: z.string(),
  version_number: z.number().int(),
  document_hash: z.string().nullable(),
  signed_document_hash: z.string().nullable(),
  requests: z.array(EvidenceRequestSchema),
}).openapi("EvidencePackage");

const CreateContractInputSchema = z.object({
  quote_id: z.number().int(),
  template_version_id: z.number().int().nullable().optional(),
  title: z.string().max(200).optional(),
  effective_date: z.string().nullable().optional(),
  expires_at: z.string().nullable().optional(),
}).strict();

const UpdateContractVersionInputSchema = z.object({
  title: z.string().max(200).optional(),
  body: z.string().max(50000).optional(),
  effective_date: z.string().nullable().optional(),
  expires_at: z.string().nullable().optional(),
}).strict();

const SignerInputSchema = z.object({
  name: z.string().max(200).optional(),
  email: z.string().max(200).optional(),
  phone: z.string().max(50).optional(),
  role: z.enum(SIGNER_ROLES as unknown as [string, ...string[]]).optional(),
}).strict();

const CreateContractTemplateInputSchema = z.object({
  name: z.string().min(1).max(200),
  body: z.string().max(50000),
}).strict();

const CreateContractTemplateVersionInputSchema = z.object({
  title: z.string().max(200).optional(),
  body: z.string().max(50000),
}).strict();

const ConsentInputSchema = z.object({
  consent_text_version: z.string().min(1).max(50),
}).strict();

// 2,900,000 chars comfortably covers the 2MB decoded-PNG cap
// (assertUploadAllowed) after base64's ~4/3 inflation plus the
// "data:image/png;base64," prefix, with headroom — and, critically,
// rejects a wildly oversized payload via cheap zod validation BEFORE
// decodeSignatureImage() ever calls atob() on the whole string (P2 found
// by independent security review: atob() ran on the full attacker-
// controlled payload before the size check, on the PUBLIC unauthenticated
// signing endpoint, with no other body-size limit in front of it).
const SubmitSignatureInputSchema = z.object({
  signer_name: z.string().min(1).max(200),
  signature_method: z.enum(SIGNATURE_METHODS as unknown as [string, ...string[]]),
  signature_image_data_url: z.string().max(2_900_000).optional(),
}).strict();

const DeclineSignatureInputSchema = z.object({
  reason: z.string().max(2000).optional(),
}).strict();

function contractErrorToResponse(err: ContractError): { body: { error: string }; status: 400 | 404 | 409 } {
  if (err.code === "not_found" || err.code === "invalid_quote") return { body: { error: err.message }, status: 404 };
  if (err.code === "not_draft" || err.code === "referenced" || err.code === "conflict" || err.code === "invalid_signer") return { body: { error: err.message }, status: 409 };
  return { body: { error: err.message }, status: 400 };
}

/** Cloudflare's own edge-set header — never client-spoofable in practice
 *  (Cloudflare overwrites any client-supplied value at the edge before the
 *  Worker ever sees the request). Falls back to empty string only in local
 *  dev/test where no real Cloudflare edge sits in front of the Worker. */
function clientIp(c: Context<Env>): string {
  return c.req.header("CF-Connecting-IP") ?? "";
}
function clientUserAgent(c: Context<Env>): string {
  return c.req.header("user-agent") ?? "";
}

const listContractsRoute = createRoute({
  method: "get",
  path: "/api/contracts",
  request: {
    query: z.object({
      status: z.string().optional(),
      customer_id: z.string().optional(),
      quote_id: z.string().optional(),
      search: z.string().max(200).optional(),
      limit: z.string().optional(),
      offset: z.string().optional(),
    }),
  },
  responses: {
    200: { description: "Contracts", content: { "application/json": { schema: z.object({ contracts: z.array(ContractSchema), total: z.number().int() }) } } },
    400: { description: "Invalid search filter", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(listContractsRoute, async (c) => {
  const me = currentUser(c);
  if (!canManageContracts({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);

  const q = c.req.valid("query");
  const limit = Math.min(Math.max(parseInt(q.limit || "50", 10) || 50, 1), 200);
  const offset = Math.max(parseInt(q.offset || "0", 10) || 0, 0);
  try {
    const { contracts, total } = await listContracts(
      actorOrganizationId(c),
      { status: q.status, customer_id: q.customer_id ? Number(q.customer_id) : undefined, quote_id: q.quote_id ? Number(q.quote_id) : undefined, search: q.search },
      limit, offset
    );
    return c.json({ contracts, total }, 200);
  } catch (err) {
    if (err instanceof ContractError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

const createContractRoute = createRoute({
  method: "post",
  path: "/api/contracts",
  request: { body: { content: { "application/json": { schema: CreateContractInputSchema } } } },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: z.object({ contract: ContractSchema }) } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Quote not found or not accepted", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Conflict", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(createContractRoute, async (c) => {
  const me = currentUser(c);
  if (!canManageContracts({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);

  const data = c.req.valid("json");
  try {
    const contract = await createContract(actorOrganizationId(c), me.id, data);
    return c.json({ contract }, 201);
  } catch (err) {
    if (err instanceof ContractError) {
      const { body, status } = contractErrorToResponse(err);
      return c.json(body, status);
    }
    throw err;
  }
});

const getContractRoute = createRoute({
  method: "get",
  path: "/api/contracts/{id}",
  request: { params: IdParam },
  responses: {
    200: { description: "Contract detail", content: { "application/json": { schema: z.object({ contract: ContractSchema, version: ContractVersionSchema.nullable() }) } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(getContractRoute, async (c) => {
  const me = currentUser(c);
  if (!canManageContracts({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);

  const { id } = c.req.valid("param");
  const contract = await getContract(actorOrganizationId(c), Number(id));
  if (!contract) return c.json({ error: "Contract not found" }, 404);
  const version = contract.current_version_id !== null ? await getContractVersion(contract.id, contract.current_version_id) : null;
  return c.json({ contract, version }, 200);
});

const deleteContractRoute = createRoute({
  method: "delete",
  path: "/api/contracts/{id}",
  request: { params: IdParam },
  responses: {
    200: { description: "Deleted", content: { "application/json": { schema: OkSchema } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Cannot delete a contract with transition history", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(deleteContractRoute, async (c) => {
  const me = currentUser(c);
  if (!canManageContracts({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);

  const { id } = c.req.valid("param");
  try {
    const deleted = await deleteContract(actorOrganizationId(c), Number(id));
    if (!deleted) return c.json({ error: "Contract not found" }, 404);
    return c.json({ ok: true }, 200);
  } catch (err) {
    if (err instanceof ContractError) {
      const { body, status } = contractErrorToResponse(err);
      return c.json(body, status);
    }
    throw err;
  }
});

const updateContractVersionRoute = createRoute({
  method: "put",
  path: "/api/contracts/{id}/version",
  request: { params: IdParam, body: { content: { "application/json": { schema: UpdateContractVersionInputSchema } } } },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: z.object({ version: ContractVersionSchema }) } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Contract is not in draft status", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(updateContractVersionRoute, async (c) => {
  const me = currentUser(c);
  if (!canManageContracts({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);

  const { id } = c.req.valid("param");
  const data = c.req.valid("json");
  try {
    const version = await updateContractVersion(actorOrganizationId(c), Number(id), data);
    return c.json({ version }, 200);
  } catch (err) {
    if (err instanceof ContractError) {
      const { body, status } = contractErrorToResponse(err);
      return c.json(body, status);
    }
    throw err;
  }
});

const createContractRevisionRoute = createRoute({
  method: "post",
  path: "/api/contracts/{id}/revisions",
  request: { params: IdParam, body: { content: { "application/json": { schema: z.object({}).strict() } } } },
  responses: {
    201: { description: "Revision created", content: { "application/json": { schema: z.object({ version: ContractVersionSchema }) } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "A revision cannot be created from the current status", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(createContractRevisionRoute, async (c) => {
  const me = currentUser(c);
  if (!canManageContracts({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);

  const { id } = c.req.valid("param");
  const organizationId = actorOrganizationId(c);
  const contract = await getContract(organizationId, Number(id));
  if (!contract) return c.json({ error: "Contract not found" }, 404);
  if (!canCreateContractRevisionFrom(contract.status)) {
    return c.json({ error: `Cannot create a revision from status "${contract.status}"` }, 409);
  }
  try {
    const version = await createContractRevision(organizationId, contract.id, me.id);
    return c.json({ version }, 201);
  } catch (err) {
    if (err instanceof ContractError) {
      const { body, status } = contractErrorToResponse(err);
      return c.json(body, status);
    }
    throw err;
  }
});

const listContractVersionsRoute = createRoute({
  method: "get",
  path: "/api/contracts/{id}/versions",
  request: { params: IdParam },
  responses: {
    200: { description: "Version history", content: { "application/json": { schema: z.object({ versions: z.array(ContractVersionSchema) }) } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(listContractVersionsRoute, async (c) => {
  const me = currentUser(c);
  if (!canManageContracts({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);

  const { id } = c.req.valid("param");
  const contract = await getContract(actorOrganizationId(c), Number(id));
  if (!contract) return c.json({ error: "Contract not found" }, 404);
  const versions = await listContractVersions(contract.id);
  return c.json({ versions }, 200);
});

const getContractVersionRoute = createRoute({
  method: "get",
  path: "/api/contracts/{id}/versions/{versionId}",
  request: { params: z.object({ id: z.string(), versionId: z.string() }) },
  responses: {
    200: { description: "Version detail", content: { "application/json": { schema: z.object({ version: ContractVersionSchema }) } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(getContractVersionRoute, async (c) => {
  const me = currentUser(c);
  if (!canManageContracts({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);

  const { id, versionId } = c.req.valid("param");
  const contract = await getContract(actorOrganizationId(c), Number(id));
  if (!contract) return c.json({ error: "Contract not found" }, 404);
  const version = await getContractVersion(contract.id, Number(versionId));
  if (!version) return c.json({ error: "Version not found" }, 404);
  return c.json({ version }, 200);
});

const getContractTransitionsRoute = createRoute({
  method: "get",
  path: "/api/contracts/{id}/transitions",
  request: { params: IdParam },
  responses: {
    200: { description: "Allowed next statuses", content: { "application/json": { schema: z.object({ allowed: z.array(z.string()), can_create_revision: z.boolean() }) } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(getContractTransitionsRoute, async (c) => {
  const me = currentUser(c);
  if (!canManageContracts({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);

  const { id } = c.req.valid("param");
  const contract = await getContract(actorOrganizationId(c), Number(id));
  if (!contract) return c.json({ error: "Contract not found" }, 404);
  return c.json({ allowed: resolveAllowedContractTransitions(contract.status), can_create_revision: canCreateContractRevisionFrom(contract.status) }, 200);
});

const transitionContractRoute = createRoute({
  method: "post",
  path: "/api/contracts/{id}/transition",
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: z.object({ to_status: z.enum(CONTRACT_STATUSES as unknown as [string, ...string[]]), reason: z.string().max(2000).optional() }).strict() } } },
  },
  responses: {
    200: { description: "Transitioned", content: { "application/json": { schema: z.object({ contract: ContractSchema }) } } },
    400: { description: "Invalid transition or missing data", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Conflict", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(transitionContractRoute, async (c) => {
  const me = currentUser(c);
  if (!canManageContracts({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);

  const { id } = c.req.valid("param");
  const { to_status, reason } = c.req.valid("json");
  try {
    await transitionContract(c.env.DB, Number(id), { toStatus: to_status, actorUserId: me.id, organizationId: actorOrganizationId(c), reason });
    const contract = await getContract(actorOrganizationId(c), Number(id));
    if (!contract) return c.json({ error: "Contract not found" }, 404);
    return c.json({ contract }, 200);
  } catch (err) {
    if (err instanceof ContractWorkflowError) {
      if (err.code === "not_found") return c.json({ error: err.message }, 404);
      if (err.code === "conflict") return c.json({ error: err.message }, 409);
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
});

const getContractStatusHistoryRoute = createRoute({
  method: "get",
  path: "/api/contracts/{id}/status-history",
  request: { params: IdParam },
  responses: {
    200: { description: "Status history", content: { "application/json": { schema: z.object({ history: z.array(ContractStatusHistorySchema) }) } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(getContractStatusHistoryRoute, async (c) => {
  const me = currentUser(c);
  if (!canManageContracts({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);

  const { id } = c.req.valid("param");
  const contract = await getContract(actorOrganizationId(c), Number(id));
  if (!contract) return c.json({ error: "Contract not found" }, 404);
  const history = await getContractStatusHistory(contract.id);
  return c.json({ history }, 200);
});

const listContractSignersRoute = createRoute({
  method: "get",
  path: "/api/contracts/{id}/signers",
  request: { params: IdParam },
  responses: {
    200: { description: "Signers", content: { "application/json": { schema: z.object({ signers: z.array(ContractSignerSchema) }) } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(listContractSignersRoute, async (c) => {
  const me = currentUser(c);
  if (!canManageContracts({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);

  const { id } = c.req.valid("param");
  const contract = await getContract(actorOrganizationId(c), Number(id));
  if (!contract) return c.json({ error: "Contract not found" }, 404);
  const signers = await listContractSigners(contract.id);
  return c.json({ signers }, 200);
});

const addContractSignerRoute = createRoute({
  method: "post",
  path: "/api/contracts/{id}/signers",
  request: { params: IdParam, body: { content: { "application/json": { schema: SignerInputSchema } } } },
  responses: {
    201: { description: "Added", content: { "application/json": { schema: z.object({ signer: ContractSignerSchema }) } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Conflict", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(addContractSignerRoute, async (c) => {
  const me = currentUser(c);
  if (!canManageContracts({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);

  const { id } = c.req.valid("param");
  const data = c.req.valid("json");
  try {
    const signer = await addContractSigner(actorOrganizationId(c), Number(id), data);
    return c.json({ signer }, 201);
  } catch (err) {
    if (err instanceof ContractError) {
      const { body, status } = contractErrorToResponse(err);
      return c.json(body, status);
    }
    throw err;
  }
});

const deleteContractSignerRoute = createRoute({
  method: "delete",
  path: "/api/contracts/{id}/signers/{signerId}",
  request: { params: z.object({ id: z.string(), signerId: z.string() }) },
  responses: {
    200: { description: "Removed", content: { "application/json": { schema: OkSchema } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Signer has an active or completed signature request", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(deleteContractSignerRoute, async (c) => {
  const me = currentUser(c);
  if (!canManageContracts({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);

  const { id, signerId } = c.req.valid("param");
  try {
    await deleteContractSigner(actorOrganizationId(c), Number(id), Number(signerId));
    return c.json({ ok: true }, 200);
  } catch (err) {
    if (err instanceof ContractError) {
      const { body, status } = contractErrorToResponse(err);
      return c.json(body, status);
    }
    throw err;
  }
});

const sendContractRoute = createRoute({
  method: "post",
  path: "/api/contracts/{id}/send",
  request: { params: IdParam, body: { content: { "application/json": { schema: z.object({}).strict() } } } },
  responses: {
    200: {
      description: "Sent for signature",
      content: { "application/json": { schema: z.object({ contract: ContractSchema, signing_links: z.array(z.object({ signer_id: z.number().int(), signer_name: z.string(), token: z.string() })) }) } },
    },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Contract is not in draft status, or has no signers", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(sendContractRoute, async (c) => {
  const me = currentUser(c);
  if (!canManageContracts({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);

  const { id } = c.req.valid("param");
  try {
    const result = await sendContractForSignature(c.env.DB, actorOrganizationId(c), Number(id), me.id);
    return c.json({ contract: result.contract, signing_links: result.signingLinks.map((l) => ({ signer_id: l.signerId, signer_name: l.signerName, token: l.token })) }, 200);
  } catch (err) {
    if (err instanceof ContractError) {
      const { body, status } = contractErrorToResponse(err);
      return c.json(body, status);
    }
    throw err;
  }
});

const listSignatureRequestsRoute = createRoute({
  method: "get",
  path: "/api/contracts/{id}/signature-requests",
  request: { params: IdParam },
  responses: {
    200: { description: "Signature requests", content: { "application/json": { schema: z.object({ requests: z.array(SignatureRequestSchema) }) } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(listSignatureRequestsRoute, async (c) => {
  const me = currentUser(c);
  if (!canManageContracts({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);

  const { id } = c.req.valid("param");
  const contract = await getContract(actorOrganizationId(c), Number(id));
  if (!contract) return c.json({ error: "Contract not found" }, 404);
  const requests = await listSignatureRequests(contract.id);
  return c.json({ requests }, 200);
});

const cancelSignatureRequestRoute = createRoute({
  method: "post",
  path: "/api/contracts/{id}/signature-requests/{requestId}/cancel",
  request: { params: z.object({ id: z.string(), requestId: z.string() }), body: { content: { "application/json": { schema: z.object({ reason: z.string().max(2000).optional() }).strict() } } } },
  responses: {
    200: { description: "Cancelled", content: { "application/json": { schema: OkSchema } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Cannot cancel a request that is already terminal", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(cancelSignatureRequestRoute, async (c) => {
  const me = currentUser(c);
  if (!canManageContracts({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);

  const { id, requestId } = c.req.valid("param");
  const { reason } = c.req.valid("json");
  try {
    await cancelSignatureRequest(c.env.DB, c.env, actorOrganizationId(c), Number(id), Number(requestId), me.id, reason ?? "");
    return c.json({ ok: true }, 200);
  } catch (err) {
    if (err instanceof ContractError) {
      const { body, status } = contractErrorToResponse(err);
      return c.json(body, status);
    }
    throw err;
  }
});

const resendSignatureRequestRoute = createRoute({
  method: "post",
  path: "/api/contracts/{id}/signature-requests/{requestId}/resend",
  request: { params: z.object({ id: z.string(), requestId: z.string() }), body: { content: { "application/json": { schema: z.object({}).strict() } } } },
  responses: {
    200: { description: "Resent", content: { "application/json": { schema: z.object({ signer_id: z.number().int(), signer_name: z.string(), token: z.string() }) } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Cannot resend a request that is already terminal", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(resendSignatureRequestRoute, async (c) => {
  const me = currentUser(c);
  if (!canManageContracts({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);

  const { id, requestId } = c.req.valid("param");
  try {
    const result = await resendSignatureRequest(c.env.DB, actorOrganizationId(c), Number(id), Number(requestId), me.id);
    return c.json({ signer_id: result.signerId, signer_name: result.signerName, token: result.token }, 200);
  } catch (err) {
    if (err instanceof ContractError) {
      const { body, status } = contractErrorToResponse(err);
      return c.json(body, status);
    }
    throw err;
  }
});

const getEvidencePackageRoute = createRoute({
  method: "get",
  path: "/api/contracts/{id}/evidence",
  request: { params: IdParam },
  responses: {
    200: { description: "Evidence package", content: { "application/json": { schema: z.object({ evidence: EvidencePackageSchema }) } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(getEvidencePackageRoute, async (c) => {
  const me = currentUser(c);
  if (!canManageContracts({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);

  const { id } = c.req.valid("param");
  const evidence = await getEvidencePackage(actorOrganizationId(c), Number(id));
  if (!evidence) return c.json({ error: "Contract not found" }, 404);
  return c.json({ evidence }, 200);
});

// Phase 13A — Signed Contract Document Access. Plain app.get (not
// app.openapi/createRoute), matching the existing job-photo file-serving
// precedent (GET /api/jobs/:id/photos/:photoId/file) — a binary/file
// response isn't a JSON contract. Still sits under the ordinary /api/*
// auth middleware (path-pattern matched, not registration-style matched).
// `?mode=download` forces a save-as; the default (no param, or any other
// value) serves inline for the "View" action — same route backs View,
// Download, and Print (the client opens this URL and calls print() on the
// resulting tab), since all three must show the exact same immutable bytes.
app.get("/api/contracts/:id/signed-document", async (c) => {
  const me = currentUser(c);
  if (!canManageContracts({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);

  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "Contract not found" }, 404);

  try {
    const artifact = await getSignedDocumentArtifact(c.env, actorOrganizationId(c), id);
    const disposition = c.req.query("mode") === "download" ? "attachment" : "inline";
    return new Response(artifact.bytes, {
      headers: {
        "Content-Type": artifact.contentType,
        "Content-Disposition": `${disposition}; filename="${artifact.filename}"`,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    if (err instanceof ContractError) {
      if (err.code === "not_found") return c.json({ error: "Contract not found" }, 404);
      if (err.code === "not_signed") return c.json({ error: "This contract has no signed document yet" }, 409);
      if (err.code === "hash_mismatch") return c.json({ error: "The signed document failed integrity verification" }, 500);
      return c.json({ error: "Unable to retrieve the signed document" }, 400);
    }
    throw err;
  }
});

// Phase 13A final document hardening — Section 37/38: aggregate customer
// signed-copy delivery status, and a manual retry for a failed one.
app.get("/api/contracts/:id/delivery-status", async (c) => {
  const me = currentUser(c);
  if (!canManageContracts({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "Contract not found" }, 404);
  const status = await getContractDeliveryStatus(actorOrganizationId(c), id);
  if (!status) return c.json({ error: "Contract not found" }, 404);
  return c.json({ delivery: status }, 200);
});

app.post("/api/contracts/:id/resend-signed-copy", async (c) => {
  const me = currentUser(c);
  if (!canManageContracts({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "Contract not found" }, 404);
  try {
    const result = await resendSignedCopy(actorOrganizationId(c), id);
    return c.json(result, 200);
  } catch (err) {
    if (err instanceof ContractError && err.code === "not_found") return c.json({ error: "Contract not found" }, 404);
    throw err;
  }
});

const listContractTemplatesRoute = createRoute({
  method: "get",
  path: "/api/contract-templates",
  responses: {
    200: { description: "Templates", content: { "application/json": { schema: z.object({ templates: z.array(ContractTemplateSchema) }) } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(listContractTemplatesRoute, async (c) => {
  const me = currentUser(c);
  if (!canManageContracts({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);
  const templates = await listContractTemplates(actorOrganizationId(c));
  return c.json({ templates }, 200);
});

const createContractTemplateRoute = createRoute({
  method: "post",
  path: "/api/contract-templates",
  request: { body: { content: { "application/json": { schema: CreateContractTemplateInputSchema } } } },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: z.object({ template: ContractTemplateSchema, version: ContractTemplateVersionSchema }) } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(createContractTemplateRoute, async (c) => {
  const me = currentUser(c);
  if (!canManageContracts({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);
  const { name, body } = c.req.valid("json");
  const { version, ...template } = await createContractTemplate(actorOrganizationId(c), me.id, name, body);
  return c.json({ template, version }, 201);
});

const createContractTemplateVersionRoute = createRoute({
  method: "post",
  path: "/api/contract-templates/{id}/versions",
  request: { params: IdParam, body: { content: { "application/json": { schema: CreateContractTemplateVersionInputSchema } } } },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: z.object({ version: ContractTemplateVersionSchema }) } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Conflict", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(createContractTemplateVersionRoute, async (c) => {
  const me = currentUser(c);
  if (!canManageContracts({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);
  const { id } = c.req.valid("param");
  const { title, body } = c.req.valid("json");
  try {
    const version = await createContractTemplateVersion(actorOrganizationId(c), Number(id), me.id, title ?? "", body);
    return c.json({ version }, 201);
  } catch (err) {
    if (err instanceof ContractError) {
      const { body: errBody, status } = contractErrorToResponse(err);
      return c.json(errBody, status);
    }
    throw err;
  }
});

// ── Public signing routes (Section 24-26) — token-gated, UNAUTHENTICATED.
// Every route here resolves organization/contract/version/signer identity
// EXCLUSIVELY through getSignatureRequestByToken()'s hashed-token lookup —
// never from any request parameter. Every failure mode (missing token,
// wrong token, expired, already-terminal) returns the SAME generic 404
// with the SAME generic message — no enumeration of which failure occurred.

const PublicSigningViewSchema = z.object({
  contract_identifier: z.string(),
  contract_status: z.string(),
  version_title: z.string(),
  version_body: z.string(),
  effective_date: z.string().nullable(),
  expires_at: z.string().nullable(),
  commercial_snapshot: z.string(),
  signer_name: z.string(),
  signer_email: z.string(),
  signer_role: z.string(),
  request_status: z.string(),
  consent_at: z.string().nullable(),
  signed_at: z.string().nullable(),
});

const GENERIC_SIGNING_LINK_ERROR = "This signing link is invalid or has expired";

const getPublicSigningViewRoute = createRoute({
  method: "get",
  path: "/api/public/contracts/sign/{token}",
  request: { params: z.object({ token: z.string() }) },
  responses: {
    200: { description: "Signing view", content: { "application/json": { schema: z.object({ view: PublicSigningViewSchema }) } } },
    404: { description: "Invalid or expired link", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(getPublicSigningViewRoute, async (c) => {
  const { token } = c.req.valid("param");
  const view = await getSignatureRequestByToken(token);
  if (!view) return c.json({ error: GENERIC_SIGNING_LINK_ERROR }, 404);
  return c.json({
    view: {
      contract_identifier: view.contract.identifier,
      contract_status: view.contract.status,
      version_title: view.version.title,
      version_body: view.version.body,
      effective_date: view.version.effective_date,
      expires_at: view.version.expires_at,
      commercial_snapshot: view.version.commercial_snapshot,
      signer_name: view.signer.name,
      signer_email: view.signer.email,
      signer_role: view.signer.role,
      request_status: view.request.status,
      consent_at: view.request.consent_at,
      signed_at: view.request.signed_at,
    },
  }, 200);
});

const consentRoute = createRoute({
  method: "post",
  path: "/api/public/contracts/sign/{token}/consent",
  request: { params: z.object({ token: z.string() }), body: { content: { "application/json": { schema: ConsentInputSchema } } } },
  responses: {
    200: { description: "Consent recorded", content: { "application/json": { schema: OkSchema } } },
    404: { description: "Invalid or expired link", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(consentRoute, async (c) => {
  const { token } = c.req.valid("param");
  const { consent_text_version } = c.req.valid("json");
  try {
    await recordConsent(token, consent_text_version, clientIp(c), clientUserAgent(c));
    return c.json({ ok: true }, 200);
  } catch {
    return c.json({ error: GENERIC_SIGNING_LINK_ERROR }, 404);
  }
});

const submitSignatureRoute = createRoute({
  method: "post",
  path: "/api/public/contracts/sign/{token}/sign",
  request: { params: z.object({ token: z.string() }), body: { content: { "application/json": { schema: SubmitSignatureInputSchema } } } },
  responses: {
    200: { description: "Signed", content: { "application/json": { schema: OkSchema } } },
    400: { description: "Consent required or invalid input", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Invalid or expired link", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Link already used", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(submitSignatureRoute, async (c) => {
  const { token } = c.req.valid("param");
  const { signer_name, signature_method, signature_image_data_url } = c.req.valid("json");
  try {
    // No organization_id is known or needed here — submitSignature()
    // resolves the exact contract/version/signer entirely from the token
    // itself (see its own doc comment in contracts.ts) before any write.
    await submitSignature(
      c.env.DB, c.env, token,
      { signerName: signer_name, signatureMethod: signature_method, signatureImageDataUrl: signature_image_data_url },
      clientIp(c), clientUserAgent(c)
    );
    return c.json({ ok: true }, 200);
  } catch (err) {
    if (err instanceof ContractError) {
      if (err.code === "invalid_token") return c.json({ error: GENERIC_SIGNING_LINK_ERROR }, 404);
      if (err.code === "conflict") return c.json({ error: err.message }, 409);
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
});

const declineRoute = createRoute({
  method: "post",
  path: "/api/public/contracts/sign/{token}/decline",
  request: { params: z.object({ token: z.string() }), body: { content: { "application/json": { schema: DeclineSignatureInputSchema } } } },
  responses: {
    200: { description: "Declined", content: { "application/json": { schema: OkSchema } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Invalid or expired link", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Link already used", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(declineRoute, async (c) => {
  const { token } = c.req.valid("param");
  const { reason } = c.req.valid("json");
  try {
    await declineSignature(c.env.DB, c.env, token, reason ?? "", clientIp(c), clientUserAgent(c));
    return c.json({ ok: true }, 200);
  } catch (err) {
    if (err instanceof ContractError) {
      if (err.code === "invalid_token") return c.json({ error: GENERIC_SIGNING_LINK_ERROR }, 404);
      if (err.code === "conflict") return c.json({ error: err.message }, 409);
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
});

// ── Service Types ──────────────────────────────────────────────────

const listServiceTypes = createRoute({
  method: "get",
  path: "/api/service-types",
  responses: {
    200: {
      description: "All service types",
      content: { "application/json": { schema: z.object({ service_types: z.array(ServiceTypeSchema) }) } },
    },
  },
});

app.openapi(listServiceTypes, async (c) => {
  const types = await query<ServiceType>(
    "SELECT * FROM service_types WHERE organization_id = ? ORDER BY name ASC", [actorOrganizationId(c)]
  );
  return c.json({ service_types: types }, 200);
});

const createServiceType = createRoute({
  method: "post",
  path: "/api/service-types",
  request: {
    body: {
      content: { "application/json": { schema: z.object({
        name: z.string(),
        description: z.string().optional(),
        default_duration: z.number().int().optional(),
        default_price: z.number().optional(),
        color: z.string().optional(),
      }) } },
    },
  },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: ServiceTypeSchema } } },
  },
});

app.openapi(createServiceType, async (c) => {
  const data = c.req.valid("json");
  const insertResult = await run(
    "INSERT INTO service_types (organization_id, name, description, default_duration, default_price, color) VALUES (?, ?, ?, ?, ?, ?)",
    [actorOrganizationId(c), data.name, data.description || "", data.default_duration || 60, data.default_price || 0, data.color || "#6b7280"]
  );
  const st = await get<ServiceType>("SELECT * FROM service_types WHERE id = ?", [insertResult.lastInsertRowid]);
  return c.json(st!, 201);
});

const updateServiceType = createRoute({
  method: "put",
  path: "/api/service-types/{id}",
  request: {
    params: IdParam,
    body: {
      content: { "application/json": { schema: z.object({
        name: z.string().optional(),
        description: z.string().optional(),
        default_duration: z.number().int().optional(),
        default_price: z.number().optional(),
        color: z.string().optional(),
      }) } },
    },
  },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: OkSchema } } },
  },
});

app.openapi(updateServiceType, async (c) => {
  const { id } = c.req.valid("param");
  const data = c.req.valid("json");
  const owned = await get<{ id: number }>(
    "SELECT id FROM service_types WHERE id = ? AND organization_id = ?", [id, actorOrganizationId(c)]
  );
  if (!owned) return c.json({ ok: true }, 200); // matches this route's pre-existing no-op-on-unknown-id behavior
  const fields: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined) {
      fields.push(`${k} = ?`);
      vals.push(v);
    }
  }
  if (fields.length > 0) {
    await run(`UPDATE service_types SET ${fields.join(", ")} WHERE id = ?`, [...vals, id]);
  }
  return c.json({ ok: true }, 200);
});

const deleteServiceType = createRoute({
  method: "delete",
  path: "/api/service-types/{id}",
  request: { params: IdParam },
  responses: {
    200: { description: "Deleted", content: { "application/json": { schema: OkSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(deleteServiceType, async (c) => {
  const me = currentUser(c);
  if (me.role === "technician") return c.json({ error: "Forbidden" }, 403);

  const { id } = c.req.valid("param");
  await run("DELETE FROM service_types WHERE id = ? AND organization_id = ?", [id, actorOrganizationId(c)]);
  return c.json({ ok: true }, 200);
});

// ── Schedule (calendar view) ───────────────────────────────────────

const getSchedule = createRoute({
  method: "get",
  path: "/api/schedule",
  request: {
    query: z.object({
      start: z.string(),
      end: z.string(),
      technician_id: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Jobs within date range",
      content: { "application/json": { schema: z.object({ jobs: z.array(JobSchema) }) } },
    },
  },
});

app.openapi(getSchedule, async (c) => {
  const q = c.req.valid("query");
  let where = "WHERE j.organization_id = ? AND j.scheduled_date >= ? AND j.scheduled_date <= ?";
  const params: unknown[] = [actorOrganizationId(c), q.start, q.end];
  // P1 fix (mem:risks/technician-job-read-scoping): same rule as listJobs —
  // a technician always gets forced to their own resolved id, a
  // client-supplied ?technician_id= is never trusted for that role.
  const me = currentUser(c);
  if (me.role === "technician") {
    const techId = await actorTechnicianId({ id: me.id, role: me.role });
    if (techId === null) return c.json({ jobs: [] }, 200);
    where += " AND j.technician_id = ?";
    params.push(techId);
  } else if (q.technician_id) {
    where += " AND j.technician_id = ?";
    params.push(q.technician_id);
  }
  const jobs = await query<Job>(
    `SELECT j.*, c.name as customer_name, c.phone as customer_phone,
       t.name as technician_name, t.color as technician_color,
       st.name as service_type_name, st.color as service_type_color
     FROM jobs j
     LEFT JOIN customers c ON j.customer_id = c.id
     LEFT JOIN technicians t ON j.technician_id = t.id
     LEFT JOIN service_types st ON j.service_type_id = st.id
     ${where}
     ORDER BY j.scheduled_date ASC, j.scheduled_time ASC`,
    params
  );
  return c.json({ jobs }, 200);
});

// Phase 10.2 — the ONLY way the Dispatcher Map's client code learns
// whether/how to load the Google Maps JavaScript API. Returns config, not
// job data (Section 8 explicitly forbids a company-wide job-data endpoint;
// this isn't one — it's a tiny, cacheable, RBAC-gated config read). The
// returned key is GOOGLE_MAPS_BROWSER_API_KEY (see MapsBrowserBindings
// above) — NEVER the server-side GOOGLE_MAPS_API_KEY geocoding secret
// (GoogleGeocodingBindings). Open to every authenticated role, including
// technician (Phase 10.2 originally blocked technician here, since only
// the Dispatcher Map existed then; Phase 10.3's Technician Route View
// needs this exact same non-secret, non-job-data config to render its own
// map, so the block was widened — it never carried job data or the
// server geocoding secret in the first place, so widening it exposes
// nothing new). The standard `/api/*` auth middleware still requires
// authentication (401 unauthenticated).
const mapsConfigResponseSchema = z.object({
  enabled: z.boolean(),
  browserApiKey: z.string().nullable(),
}).openapi("MapsConfig");

const getMapsConfig = createRoute({
  method: "get",
  path: "/api/config/maps",
  responses: {
    200: { description: "Browser Maps config", content: { "application/json": { schema: mapsConfigResponseSchema } } },
  },
});

app.openapi(getMapsConfig, async (c) => {
  const key = c.env.GOOGLE_MAPS_BROWSER_API_KEY || null;
  return c.json({ enabled: !!key, browserApiKey: key }, 200);
});

// Phase 13C — a narrow, non-sensitive operational read for Technician
// Route View's date-defaulting logic, which used to piggyback on the
// (now admin-only) full `GET /api/settings` list. Same "config, not the
// management surface" shape as /api/config/maps above — a single IANA
// timezone string is not administrative configuration data, it's the same
// kind of display/operational value the reference_data settings category
// remains open for. Open to every authenticated role.
const businessTimezoneConfigResponseSchema = z.object({
  timezone: z.string(),
}).openapi("BusinessTimezoneConfig");

const getBusinessTimezoneConfig = createRoute({
  method: "get",
  path: "/api/config/business-timezone",
  responses: {
    200: { description: "Business timezone", content: { "application/json": { schema: businessTimezoneConfigResponseSchema } } },
  },
});

app.openapi(getBusinessTimezoneConfig, async (c) => {
  const timezone = await getBusinessTimezone(actorOrganizationId(c));
  return c.json({ timezone }, 200);
});

// Phase 10.4 — Routing/Travel-Time. The ONE paid-request trigger in this
// codebase (see mem:phase10/maps-routing-architecture-audit) — deliberately
// separate from GET /api/schedule (which stays free/local, no Routes call)
// so an ordinary Scheduler/Dispatcher-Map/Technician-Route page load NEVER
// costs money; only an explicit client-side action calls this route.
// RBAC mirrors GET /api/schedule exactly: a technician is always forced to
// their own resolved technician id (never a client-supplied technician_id,
// checked BEFORE any query — same IDOR discipline as every other
// technician-scoped route in this file); admin/dispatcher must supply
// technician_id explicitly (this endpoint routes ONE technician's ONE day
// already visible under existing Scheduler permissions — never a
// company-wide/multi-technician sweep, never an arbitrary
// coordinate/address proxy — Section 13's explicit boundary). Stop order is
// derived purely from `scheduled_time`/id (routing.ts#orderRouteStops,
// the same deterministic tie-break as the Technician Route View's client
// helper) — never a persisted route_order/visit_sequence/stop_index, and
// never reordered/optimized by the provider (RoutingProvider#route is
// always called with optimizeWaypointOrder hard-coded false in the
// adapter). A non-geocoded stop breaks leg continuity rather than being
// silently skipped (Section 10) — every leg is always present in the
// response, `status: "unavailable"` (with a normalized `error_code`, never
// a raw provider message) when it can't be computed, so the UI never has
// to guess whether data is missing or simply absent.
const routeLegSchema = z.object({
  from_job_id: z.number().int(),
  to_job_id: z.number().int(),
  status: z.enum(["ok", "unavailable"]),
  distance_meters: z.number().optional(),
  duration_seconds: z.number().optional(),
  error_code: z.string().optional(),
}).openapi("RouteLeg");

const technicianRouteResponseSchema = z.object({
  date: z.string(),
  technician_id: z.number().int(),
  legs: z.array(routeLegSchema),
  total_distance_meters: z.number().nullable(),
  total_duration_seconds: z.number().nullable(),
}).openapi("TechnicianRouteResult");

const getTechnicianRoute = createRoute({
  method: "get",
  path: "/api/technician/route",
  request: {
    query: z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
      technician_id: z.string().optional(),
    }),
  },
  responses: {
    200: { description: "Travel legs between the technician's scheduled stops for one day", content: { "application/json": { schema: technicianRouteResponseSchema } } },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(getTechnicianRoute, async (c) => {
  const me = currentUser(c);
  const organizationId = actorOrganizationId(c);
  const q = c.req.valid("query");
  const { date } = q;

  let technicianId: number;
  if (me.role === "technician") {
    const techId = await actorTechnicianId({ id: me.id, role: me.role });
    if (techId === null) {
      return c.json({ date, technician_id: 0, legs: [], total_distance_meters: null, total_duration_seconds: null }, 200);
    }
    technicianId = techId;
  } else {
    if (!q.technician_id) return c.json({ error: "technician_id is required" }, 400);
    const parsed = Number(q.technician_id);
    if (!Number.isInteger(parsed)) return c.json({ error: "technician_id must be an integer" }, 400);
    // Phase 11.5: an admin/dispatcher-supplied technician_id must belong to
    // the actor's own organization — otherwise this would compute (and pay
    // for) a route over another organization's technician/jobs.
    const ownedTech = await get<{ id: number }>(
      "SELECT id FROM technicians WHERE id = ? AND organization_id = ?", [parsed, organizationId]
    );
    if (!ownedTech) return c.json({ error: "technician_id is required" }, 400);
    technicianId = parsed;
  }

  const rows = await query<{ id: number; scheduled_time: string; status: string; latitude: number | null; longitude: number | null; geocode_status: string | null }>(
    "SELECT id, scheduled_time, status, latitude, longitude, geocode_status FROM jobs WHERE organization_id = ? AND scheduled_date = ? AND technician_id = ?",
    [organizationId, date, technicianId]
  );
  const stops: RouteStopInput[] = rows.map((r) => ({
    jobId: r.id, scheduledTime: r.scheduled_time, status: r.status,
    latitude: r.latitude, longitude: r.longitude, geocodeStatus: r.geocode_status,
  }));

  const provider = buildRoutingProvider(c.env);
  const result = await computeTechnicianRouteLegs(stops, provider);

  return c.json({
    date,
    technician_id: technicianId,
    legs: result.legs.map((l) => ({
      from_job_id: l.fromJobId, to_job_id: l.toJobId, status: l.status,
      distance_meters: l.distanceMeters, duration_seconds: l.durationSeconds, error_code: l.errorCode,
    })),
    total_distance_meters: result.totalDistanceMeters,
    total_duration_seconds: result.totalDurationSeconds,
  }, 200);
});

// ── Job Checklist ──────────────────────────────────────────────────

const addChecklistItem = createRoute({
  method: "post",
  path: "/api/jobs/{id}/checklist",
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: z.object({ label: z.string() }) } } },
  },
  responses: {
    201: { description: "Added", content: { "application/json": { schema: OkSchema } } },
    404: { description: "Job not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(addChecklistItem, async (c) => {
  const { id } = c.req.valid("param");
  const { label } = c.req.valid("json");
  const ownedJob = await get<{ id: number }>(
    "SELECT id FROM jobs WHERE id = ? AND organization_id = ?", [id, actorOrganizationId(c)]
  );
  if (!ownedJob) return c.json({ error: "Job not found" }, 404);
  const maxOrder = await get<{ m: number }>("SELECT COALESCE(MAX(sort_order), 0) as m FROM job_checklist WHERE job_id = ?", [id]);
  await run("INSERT INTO job_checklist (job_id, label, sort_order) VALUES (?, ?, ?)", [id, label, (maxOrder?.m || 0) + 1]);
  return c.json({ ok: true }, 201);
});

const toggleChecklistItem = createRoute({
  method: "put",
  path: "/api/checklist/{id}",
  request: { params: IdParam },
  responses: {
    200: { description: "Toggled", content: { "application/json": { schema: OkSchema } } },
  },
});

app.openapi(toggleChecklistItem, async (c) => {
  const { id } = c.req.valid("param");
  await run(
    `UPDATE job_checklist SET checked = CASE WHEN checked = 0 THEN 1 ELSE 0 END
     WHERE id = ? AND job_id IN (SELECT id FROM jobs WHERE organization_id = ?)`,
    [id, actorOrganizationId(c)]
  );
  return c.json({ ok: true }, 200);
});

const deleteChecklistItem = createRoute({
  method: "delete",
  path: "/api/checklist/{id}",
  request: { params: IdParam },
  responses: {
    200: { description: "Deleted", content: { "application/json": { schema: OkSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(deleteChecklistItem, async (c) => {
  const me = currentUser(c);
  if (me.role === "technician") return c.json({ error: "Forbidden" }, 403);

  const { id } = c.req.valid("param");
  await run(
    "DELETE FROM job_checklist WHERE id = ? AND job_id IN (SELECT id FROM jobs WHERE organization_id = ?)",
    [id, actorOrganizationId(c)]
  );
  return c.json({ ok: true }, 200);
});

// ── Materials ──────────────────────────────────────────────────────

const listMaterials = createRoute({
  method: "get",
  path: "/api/materials",
  responses: {
    200: {
      description: "All materials",
      content: { "application/json": { schema: z.object({ materials: z.array(MaterialSchema) }) } },
    },
  },
});

app.openapi(listMaterials, async (c) => {
  const materials = await query<Material>(
    "SELECT * FROM materials WHERE organization_id = ? ORDER BY name ASC", [actorOrganizationId(c)]
  );
  return c.json({ materials }, 200);
});

const createMaterial = createRoute({
  method: "post",
  path: "/api/materials",
  request: {
    body: { content: { "application/json": { schema: z.object({
      name: z.string(),
      unit: z.string().optional(),
      unit_cost: z.number().optional(),
      in_stock: z.number().optional(),
    }) } } },
  },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: OkSchema } } },
  },
});

app.openapi(createMaterial, async (c) => {
  const data = c.req.valid("json");
  await run("INSERT INTO materials (organization_id, name, unit, unit_cost, in_stock) VALUES (?, ?, ?, ?, ?)",
    [actorOrganizationId(c), data.name, data.unit || "ea", data.unit_cost || 0, data.in_stock || 0]);
  return c.json({ ok: true }, 201);
});

const updateMaterial = createRoute({
  method: "put",
  path: "/api/materials/{id}",
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: z.object({
      name: z.string().optional(),
      unit: z.string().optional(),
      unit_cost: z.number().optional(),
      in_stock: z.number().optional(),
    }) } } },
  },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: OkSchema } } },
  },
});

app.openapi(updateMaterial, async (c) => {
  const { id } = c.req.valid("param");
  const data = c.req.valid("json");
  const owned = await get<{ id: number }>(
    "SELECT id FROM materials WHERE id = ? AND organization_id = ?", [id, actorOrganizationId(c)]
  );
  if (!owned) return c.json({ ok: true }, 200); // matches this route's pre-existing no-op-on-unknown-id behavior
  const fields: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined) { fields.push(`${k} = ?`); vals.push(v); }
  }
  if (fields.length > 0) await run(`UPDATE materials SET ${fields.join(", ")} WHERE id = ?`, [...vals, id]);
  return c.json({ ok: true }, 200);
});

const deleteMaterial = createRoute({
  method: "delete",
  path: "/api/materials/{id}",
  request: { params: IdParam },
  responses: {
    200: { description: "Deleted", content: { "application/json": { schema: OkSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(deleteMaterial, async (c) => {
  const me = currentUser(c);
  if (me.role === "technician") return c.json({ error: "Forbidden" }, 403);

  const { id } = c.req.valid("param");
  await run("DELETE FROM materials WHERE id = ? AND organization_id = ?", [id, actorOrganizationId(c)]);
  return c.json({ ok: true }, 200);
});

// ── Job Materials ──────────────────────────────────────────────────

const addJobMaterial = createRoute({
  method: "post",
  path: "/api/jobs/{id}/materials",
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: z.object({
      material_id: z.number().int(),
      quantity: z.number(),
      unit_cost: z.number().optional(),
    }) } } },
  },
  responses: {
    201: { description: "Added", content: { "application/json": { schema: OkSchema } } },
    404: { description: "Job or material not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(addJobMaterial, async (c) => {
  const { id } = c.req.valid("param");
  const data = c.req.valid("json");
  const organizationId = actorOrganizationId(c);
  // Phase 11.5: both the job and the material must belong to the actor's
  // own organization — this route previously trusted a bare numeric job id
  // with no ownership check at all.
  const ownedJob = await get<{ id: number }>("SELECT id FROM jobs WHERE id = ? AND organization_id = ?", [id, organizationId]);
  if (!ownedJob) return c.json({ error: "Job not found" }, 404);
  const mat = await get<{ unit_cost: number }>(
    "SELECT unit_cost FROM materials WHERE id = ? AND organization_id = ?", [data.material_id, organizationId]
  );
  if (!mat) return c.json({ error: "Material not found" }, 404);
  const cost = data.unit_cost ?? mat.unit_cost;
  await run("INSERT INTO job_materials (job_id, material_id, quantity, unit_cost) VALUES (?, ?, ?, ?)",
    [id, data.material_id, data.quantity, cost]);
  return c.json({ ok: true }, 201);
});

const deleteJobMaterial = createRoute({
  method: "delete",
  path: "/api/job-materials/{id}",
  request: { params: IdParam },
  responses: {
    200: { description: "Deleted", content: { "application/json": { schema: OkSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(deleteJobMaterial, async (c) => {
  const me = currentUser(c);
  if (me.role === "technician") return c.json({ error: "Forbidden" }, 403);

  const { id } = c.req.valid("param");
  await run(
    `DELETE FROM job_materials WHERE id = ? AND job_id IN (SELECT id FROM jobs WHERE organization_id = ?)`,
    [id, actorOrganizationId(c)]
  );
  return c.json({ ok: true }, 200);
});

// ── Invoices & Financials (Phase 5) ──────────────────────────────────
// Full RBAC blackout for technicians on every route in this section — see
// canManageFinancials() in financial.ts. Money is always integer cents; see
// migrations/0007_financial_invoicing.sql and financial.ts's module doc for
// why, and for what's stored vs. always computed on read.

// Phase 13B — the one PaymentProvider instance this deployment uses
// (Section 9: Core must never be locked to one payment company — every
// route below reaches the provider through this single seam). Stateless,
// so one shared instance is safe across requests (see payment-provider.ts).
const paymentProvider = new MockPaymentProvider();

/** Section 34 (Provider-Disabled Mode) / Section 59 (secrets belong in env,
 *  never Global Settings): online payment is "enabled" purely by whether
 *  this secret is configured — the exact same convention
 *  RESEND_API_KEY/GOOGLE_MAPS_API_KEY already use elsewhere in this file.
 *  Returns null (never throws) when unconfigured, so every call site can
 *  treat "no secret" as a normal, disclosed, gracefully-unavailable state. */
function paymentWebhookSecret(c: { env: { MOCK_PAYMENT_WEBHOOK_SECRET?: string } }): string | null {
  return c.env.MOCK_PAYMENT_WEBHOOK_SECRET || null;
}

/** Attaches every computed money field (see financial.ts's module doc — never
 *  stored, always derived) for a single-invoice response. Delegates to
 *  getInvoiceFinancials() rather than recomputing the same aggregate here;
 *  listInvoices below intentionally does NOT use this helper — it needs the
 *  paid-sum for potentially many rows in one query (a correlated subquery),
 *  where this per-invoice helper's extra round trip would be an N+1. */
async function attachFinancials(invoice: Record<string, unknown>): Promise<Record<string, unknown>> {
  const financials = await getInvoiceFinancials(
    invoice as unknown as Parameters<typeof getInvoiceFinancials>[0], invoice.due_date as string
  );
  return { ...invoice, ...financials };
}

/** Phase 11.5 — a lightweight ownership guard used by every single-invoice
 *  mutation below (issue/void/rebate/delete/payments), which all otherwise
 *  call straight into financial.ts by bare invoice id. Rather than thread
 *  organizationId through financial.ts's whole call graph (a much larger,
 *  riskier change to this codebase's most sensitive domain), this narrow
 *  pre-check confirms the invoice belongs to the actor's organization
 *  before any of those functions ever run — same "existence/ownership
 *  check first, before any mutation" discipline used everywhere else in
 *  this file. */
async function assertInvoiceInOrganization(organizationId: number, invoiceId: number): Promise<boolean> {
  const row = await get<{ id: number }>(
    "SELECT id FROM invoices WHERE id = ? AND organization_id = ?", [invoiceId, organizationId]
  );
  return !!row;
}

const listInvoices = createRoute({
  method: "get",
  path: "/api/invoices",
  request: {
    query: z.object({
      page: z.string().optional(),
      limit: z.string().optional(),
      status: z.string().optional(),
      search: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Paginated invoice list",
      content: { "application/json": { schema: z.object({
        invoices: z.array(z.any()),
        total: z.number().int(),
      }) } },
    },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(listInvoices, async (c) => {
  const me = currentUser(c);
  if (!canManageFinancials({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);

  const q = c.req.valid("query");
  const page = parseInt(q.page || "1", 10);
  const limit = parseInt(q.limit || "50", 10);
  const offset = (page - 1) * limit;

  let where = "WHERE i.organization_id = ?";
  const params: unknown[] = [actorOrganizationId(c)];
  if (q.status) { where += " AND i.status = ?"; params.push(q.status); }
  if (q.search) {
    where += " AND (i.identifier LIKE ? OR c.name LIKE ?)";
    const s = `%${q.search}%`;
    params.push(s, s);
  }

  const countRow = await get<{ count: number }>(
    `SELECT COUNT(*) as count FROM invoices i LEFT JOIN customers c ON i.customer_id = c.id ${where}`, params
  );
  const rows = await query<Record<string, unknown>>(
    `SELECT i.*, c.name as customer_name, j.identifier as job_identifier,
       COALESCE((SELECT SUM(amount_cents) FROM payments p WHERE p.invoice_id = i.id AND p.voided_at IS NULL), 0) as amount_paid_cents
     FROM invoices i
     LEFT JOIN customers c ON i.customer_id = c.id
     LEFT JOIN jobs j ON i.job_id = j.id
     ${where}
     ORDER BY i.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  const today = new Date().toISOString().split("T")[0];
  const invoices = rows.map((row) => {
    const totalCents = row.total_cents as number;
    const paidCents = row.amount_paid_cents as number;
    const balanceCents = totalCents - paidCents;
    const dueDate = row.due_date as string;
    return {
      ...row,
      customer_amount_cents: totalCents - (row.rebate_amount_cents as number),
      balance_cents: balanceCents,
      is_overdue: balanceCents > 0 && dueDate !== "" && dueDate < today &&
        (row.status === "issued" || row.status === "partially_paid"),
    };
  });
  return c.json({ invoices, total: countRow?.count || 0 }, 200);
});

// Phase 13A final document hardening — Section 42-49: professional
// Invoice PDF, View/Download/Print via one route (same `?mode=download`
// convention as the signed Contract document route). Rendered LIVE on
// every request — see invoice-pdf.ts's own header comment for the
// explicit lifecycle decision (no snapshot/immutability concept for
// invoices, unlike signed Contracts). Same admin/dispatcher RBAC and
// tenant-ownership guard as every other invoice route.
app.get("/api/invoices/:id/pdf", async (c) => {
  const me = currentUser(c);
  if (!canManageFinancials({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "Invoice not found" }, 404);
  const organizationId = actorOrganizationId(c);
  if (!(await assertInvoiceInOrganization(organizationId, id))) return c.json({ error: "Invoice not found" }, 404);

  // Phase 13B — reuses the exact same builder the automatic Invoice-email
  // attachment resolves through (financial.ts#getInvoicePdfBytesForDelivery),
  // so View/Download/Print and the emailed attachment are always the same
  // rendering code path, never a duplicated "PDF for email" variant.
  const doc = await getInvoicePdfBytesForDelivery(c.env, id);
  if (!doc) return c.json({ error: "Invoice not found" }, 404);

  const disposition = c.req.query("mode") === "download" ? "attachment" : "inline";
  return new Response(doc.bytes, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${disposition}; filename="${doc.filename}"`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "private, no-store",
    },
  });
});

// ── Phase 13B — Invoice Delivery (Section 6-8) ─────────────────────────
// Deliberately separate from issue/payments (Section 5's Core Business
// Rule) — see issueInvoiceRoute's own comment above for why the old
// automatic-on-issue email was removed.

const sendInvoiceRoute = createRoute({
  method: "post",
  path: "/api/invoices/{id}/send",
  request: { params: IdParam },
  responses: {
    200: { description: "Send result", content: { "application/json": { schema: z.object({ action: z.string() }) } } },
    400: { description: "Invalid state", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(sendInvoiceRoute, async (c) => {
  const me = currentUser(c);
  if (!canManageFinancials({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);
  const invoiceId = Number(c.req.valid("param").id);
  const organizationId = actorOrganizationId(c);
  if (!(await assertInvoiceInOrganization(organizationId, invoiceId))) {
    return c.json({ error: "Invoice not found" }, 404);
  }
  const invoice = await getInvoiceById(invoiceId);
  if (!invoice) return c.json({ error: "Invoice not found" }, 404);
  if (invoice.status === "draft" || invoice.status === "void") {
    return c.json({ error: `Cannot send a ${invoice.status} invoice — issue it first` }, 400);
  }
  const contact = await getCustomerContact(invoice.customer_id);
  if (!contact) return c.json({ error: "Customer contact not found" }, 400);

  // Section 33 — "Pay Online" link is included only when online payment is
  // configured; a payment-link generation failure (e.g. a $0 balance)
  // never blocks the send itself, it just omits the link.
  let payUrl = "";
  const secret = paymentWebhookSecret(c);
  if (secret) {
    try {
      const { rawToken } = await createPaymentSession(paymentProvider, organizationId, invoiceId, me.id);
      payUrl = `${new URL(c.req.url).origin}/pay/${rawToken}`;
    } catch {
      // no remaining balance, or some other non-fatal session-creation
      // issue — the invoice still sends, just without a Pay Online link.
    }
  }
  const company = await getCompanyProfile(organizationId);

  const result = await prepareInvoiceSend(invoiceId, () => enqueueInvoiceSent({
    invoiceId: invoice.id, invoiceIdentifier: invoice.identifier,
    customerId: invoice.customer_id, customerName: contact.name, customerEmail: contact.email, customerPhone: contact.phone,
    totalCents: invoice.total_cents, dueDate: invoice.due_date, companyName: company.company_name || company.legal_name || "",
    payUrl,
  }));
  return c.json({ action: result.action }, 200);
});

const getInvoiceDeliveryStatusRoute = createRoute({
  method: "get",
  path: "/api/invoices/{id}/delivery-status",
  request: { params: IdParam },
  responses: {
    200: { description: "Delivery status", content: { "application/json": { schema: z.object({ delivery: z.any() }) } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(getInvoiceDeliveryStatusRoute, async (c) => {
  const me = currentUser(c);
  if (!canManageFinancials({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);
  const invoiceId = Number(c.req.valid("param").id);
  if (!(await assertInvoiceInOrganization(actorOrganizationId(c), invoiceId))) {
    return c.json({ error: "Invoice not found" }, 404);
  }
  const delivery = await getInvoiceDeliveryStatus(invoiceId);
  return c.json({ delivery }, 200);
});

// ── Phase 13B — Online Payment (Section 9-13, 33) ──────────────────────

const createPaymentLinkRoute = createRoute({
  method: "post",
  path: "/api/invoices/{id}/payment-link",
  request: { params: IdParam },
  responses: {
    201: { description: "Payment link", content: { "application/json": { schema: z.object({ url: z.string(), expires_at: z.string() }) } } },
    400: { description: "Invalid state", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    503: { description: "Online payment not available", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(createPaymentLinkRoute, async (c) => {
  const me = currentUser(c);
  if (!canManageFinancials({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);
  const invoiceId = Number(c.req.valid("param").id);
  const organizationId = actorOrganizationId(c);
  if (!(await assertInvoiceInOrganization(organizationId, invoiceId))) {
    return c.json({ error: "Invoice not found" }, 404);
  }
  const secret = paymentWebhookSecret(c);
  if (!secret) return c.json({ error: "Online payment is not available" }, 503);
  try {
    const { rawToken, session } = await createPaymentSession(paymentProvider, organizationId, invoiceId, me.id);
    return c.json({ url: `${new URL(c.req.url).origin}/pay/${rawToken}`, expires_at: session.expires_at }, 201);
  } catch (err) {
    if (err instanceof FinancialError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

const getInvoice = createRoute({
  method: "get",
  path: "/api/invoices/{id}",
  request: { params: IdParam },
  responses: {
    200: { description: "Invoice detail", content: { "application/json": { schema: z.object({ invoice: z.any() }) } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(getInvoice, async (c) => {
  const me = currentUser(c);
  if (!canManageFinancials({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);

  const { id } = c.req.valid("param");
  const invoice = await get<Record<string, unknown>>(
    `SELECT i.*, c.name as customer_name, j.identifier as job_identifier
     FROM invoices i
     LEFT JOIN customers c ON i.customer_id = c.id
     LEFT JOIN jobs j ON i.job_id = j.id
     WHERE i.id = ? AND i.organization_id = ?`, [id, actorOrganizationId(c)]
  );
  if (!invoice) return c.json({ error: "Invoice not found" }, 404);
  const lines = await query<Record<string, unknown>>(
    "SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY id ASC", [id]
  );
  const payments = await listPayments(Number(id));
  const withFinancials = await attachFinancials(invoice);
  return c.json({ invoice: { ...withFinancials, lines, payments } }, 200);
});

const InvoiceLineInputSchema = z.object({
  description: z.string(),
  quantity: z.number().positive(),
  unit_price_cents: z.number().int(),
});

const createInvoice = createRoute({
  method: "post",
  path: "/api/invoices",
  request: {
    body: { content: { "application/json": { schema: z.object({
      customer_id: z.number().int(),
      job_id: z.number().int().nullable().optional(),
      tax_rate: z.number().optional(),
      notes: z.string().optional(),
      due_date: z.string().optional(),
      lines: z.array(InvoiceLineInputSchema).min(1),
    }) } } },
  },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: z.any() } } },
    400: { description: "Invalid invoice data", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Customer or job not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(createInvoice, async (c) => {
  const me = currentUser(c);
  if (!canManageFinancials({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);

  const data = c.req.valid("json");
  // Phase 11.5: a client-supplied customer_id (and, if present, job_id)
  // must belong to the actor's own organization — otherwise a caller could
  // attach a real financial record to another organization's customer.
  const organizationId = actorOrganizationId(c);
  const ownedCustomer = await get<{ id: number }>(
    "SELECT id FROM customers WHERE id = ? AND organization_id = ?", [data.customer_id, organizationId]
  );
  if (!ownedCustomer) return c.json({ error: "Customer not found" }, 404);
  if (data.job_id != null) {
    const ownedJob = await get<{ id: number }>(
      "SELECT id FROM jobs WHERE id = ? AND organization_id = ?", [data.job_id, organizationId]
    );
    if (!ownedJob) return c.json({ error: "Job not found" }, 404);
  }
  try {
    const invoice = await createManualInvoice(c.env.DB, {
      organizationId,
      customerId: data.customer_id,
      jobId: data.job_id ?? null,
      taxRatePercent: data.tax_rate ?? 0,
      notes: data.notes ?? "",
      dueDate: data.due_date ?? "",
      lines: data.lines.map((l) => ({ description: l.description, quantity: l.quantity, unitPriceCents: l.unit_price_cents })),
    }, me.id);
    const result = await get<Record<string, unknown>>(
      `SELECT i.*, c.name as customer_name FROM invoices i
       LEFT JOIN customers c ON i.customer_id = c.id WHERE i.id = ?`, [invoice.id]
    );
    return c.json(await attachFinancials(result!), 201);
  } catch (err) {
    if (err instanceof FinancialError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

const updateInvoice = createRoute({
  method: "put",
  path: "/api/invoices/{id}",
  request: {
    params: IdParam,
    // .strict(): financial values (status, totals, rebate) are deliberately
    // NOT editable here — status only changes via issue/void/payments,
    // rebate only via its own dedicated (audited) endpoint. This route is
    // for the two genuinely ordinary fields left: notes and due_date.
    body: { content: { "application/json": { schema: z.object({
      notes: z.string().optional(),
      due_date: z.string().optional(),
    }).strict() } } },
  },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: OkSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(updateInvoice, async (c) => {
  const me = currentUser(c);
  if (!canManageFinancials({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);

  const { id } = c.req.valid("param");
  const data = c.req.valid("json");
  const invoice = await getInvoiceById(Number(id));
  if (!invoice || !(await assertInvoiceInOrganization(actorOrganizationId(c), Number(id)))) {
    return c.json({ error: "Invoice not found" }, 404);
  }

  const fields: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined) { fields.push(`${k} = ?`); vals.push(v); }
  }
  if (fields.length > 0) {
    fields.push("updated_at = datetime('now')");
    await run(`UPDATE invoices SET ${fields.join(", ")} WHERE id = ?`, [...vals, id]);
  }
  return c.json({ ok: true }, 200);
});

const issueInvoiceRoute = createRoute({
  method: "post",
  path: "/api/invoices/{id}/issue",
  request: { params: IdParam },
  responses: {
    200: { description: "Issued", content: { "application/json": { schema: z.any() } } },
    400: { description: "Invalid state", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(issueInvoiceRoute, async (c) => {
  const me = currentUser(c);
  if (!canManageFinancials({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);
  const invoiceId = Number(c.req.valid("param").id);
  if (!(await assertInvoiceInOrganization(actorOrganizationId(c), invoiceId))) {
    return c.json({ error: "Invoice not found" }, 404);
  }
  try {
    // Phase 13B — Core Business Rule (Section 5): Invoice Delivery !=
    // Payment Recording. Issuing an invoice makes it billable/eligible for
    // payment; it must NEVER, by itself, email the customer — that used to
    // happen automatically here (an invoice.issued notification), which
    // made it impossible to issue an invoice for an on-site cash payment
    // without also silently emailing the customer. The explicit "Send
    // Invoice to Customer" action (POST /api/invoices/{id}/send, below)
    // is now the ONLY way an invoice email goes out.
    const invoice = await issueInvoice(invoiceId, me.id);
    return c.json(await attachFinancials(invoice as unknown as Record<string, unknown>), 200);
  } catch (err) {
    if (err instanceof FinancialError) {
      if (err.code === "not_found") return c.json({ error: err.message }, 404);
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
});

const voidInvoiceRoute = createRoute({
  method: "post",
  path: "/api/invoices/{id}/void",
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: z.object({ reason: z.string() }) } } },
  },
  responses: {
    200: { description: "Voided", content: { "application/json": { schema: z.any() } } },
    400: { description: "Invalid state", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(voidInvoiceRoute, async (c) => {
  const me = currentUser(c);
  if (!canManageFinancials({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);
  const invoiceId = Number(c.req.valid("param").id);
  if (!(await assertInvoiceInOrganization(actorOrganizationId(c), invoiceId))) {
    return c.json({ error: "Invoice not found" }, 404);
  }
  try {
    const invoice = await voidInvoice(invoiceId, me.id, c.req.valid("json").reason);
    return c.json(await attachFinancials(invoice as unknown as Record<string, unknown>), 200);
  } catch (err) {
    if (err instanceof FinancialError) {
      if (err.code === "not_found") return c.json({ error: err.message }, 404);
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
});

const setRebateRoute = createRoute({
  method: "put",
  path: "/api/invoices/{id}/rebate",
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: z.object({ rebate_amount_cents: z.number().int() }) } } },
  },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: z.any() } } },
    400: { description: "Invalid amount", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(setRebateRoute, async (c) => {
  const me = currentUser(c);
  if (!canManageFinancials({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);
  const invoiceId = Number(c.req.valid("param").id);
  if (!(await assertInvoiceInOrganization(actorOrganizationId(c), invoiceId))) {
    return c.json({ error: "Invoice not found" }, 404);
  }
  try {
    const invoice = await setRebateAmount(invoiceId, me.id, c.req.valid("json").rebate_amount_cents);
    return c.json(await attachFinancials(invoice as unknown as Record<string, unknown>), 200);
  } catch (err) {
    if (err instanceof FinancialError) {
      if (err.code === "not_found") return c.json({ error: err.message }, 404);
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
});

const deleteInvoice = createRoute({
  method: "delete",
  path: "/api/invoices/{id}",
  request: { params: IdParam },
  responses: {
    200: { description: "Deleted", content: { "application/json": { schema: OkSchema } } },
    400: { description: "Invalid state", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(deleteInvoice, async (c) => {
  const me = currentUser(c);
  if (!canManageFinancials({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);

  const { id } = c.req.valid("param");
  if (!(await assertInvoiceInOrganization(actorOrganizationId(c), Number(id)))) {
    return c.json({ error: "Invoice not found" }, 404);
  }
  try {
    await deleteDraftInvoice(Number(id));
  } catch (err) {
    if (err instanceof FinancialError) {
      if (err.code === "not_found") return c.json({ error: err.message }, 404);
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
  return c.json({ ok: true }, 200);
});

const getInvoiceAuditRoute = createRoute({
  method: "get",
  path: "/api/invoices/{id}/audit",
  request: { params: IdParam },
  responses: {
    200: { description: "Financial audit trail for this invoice", content: { "application/json": { schema: z.any() } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(getInvoiceAuditRoute, async (c) => {
  const me = currentUser(c);
  if (!canManageFinancials({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);
  const invoiceId = Number(c.req.valid("param").id);
  if (!(await assertInvoiceInOrganization(actorOrganizationId(c), invoiceId))) {
    return c.json({ error: "Invoice not found" }, 404);
  }
  const audit = await getInvoiceAudit(invoiceId);
  return c.json({ audit }, 200);
});

// ── Invoice notification history (Phase 9.3) ─────────────────────────
// Reuses canManageFinancials() verbatim — this is financial-adjacent data
// (invoice.issued / payment.received), same RBAC boundary as every other
// invoice route including reads, not a new parallel check.

const getInvoiceNotifications = createRoute({
  method: "get",
  path: "/api/invoices/{id}/notifications",
  request: { params: IdParam, query: NotificationHistoryQuery },
  responses: {
    200: { description: "Notification history", content: { "application/json": { schema: z.any() } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(getInvoiceNotifications, async (c) => {
  const me = currentUser(c);
  if (!canManageFinancials({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);
  const { id } = c.req.valid("param");
  const invoice = await get<{ id: number }>("SELECT id FROM invoices WHERE id = ? AND organization_id = ?", [id, actorOrganizationId(c)]);
  if (!invoice) return c.json({ error: "Invoice not found" }, 404);
  const { limit, offset } = parseHistoryPagination(c.req.valid("query"));
  const page = await getInvoiceNotificationHistory(Number(id), limit, offset);
  return c.json(page, 200);
});

// ── Payments ──────────────────────────────────────────────────────

const listPaymentsRoute = createRoute({
  method: "get",
  path: "/api/invoices/{id}/payments",
  request: { params: IdParam },
  responses: {
    200: { description: "Payment history for this invoice", content: { "application/json": { schema: z.any() } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(listPaymentsRoute, async (c) => {
  const me = currentUser(c);
  if (!canManageFinancials({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);
  const invoiceId = Number(c.req.valid("param").id);
  if (!(await assertInvoiceInOrganization(actorOrganizationId(c), invoiceId))) {
    return c.json({ error: "Invoice not found" }, 404);
  }
  const payments = await listPayments(invoiceId);
  return c.json({ payments }, 200);
});

const recordPaymentRoute = createRoute({
  method: "post",
  path: "/api/invoices/{id}/payments",
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: z.object({
      amount_cents: z.number().int().positive(),
      payer_type: z.enum(PAYER_TYPES),
      method: z.enum(PAYMENT_METHODS),
      reference: z.string().optional(),
      notes: z.string().optional(),
      paid_at: z.string().optional(),
      // Phase 13B (Section 16): free-text — who physically took the
      // payment. Optional, never required (Section 16: "Do not require
      // reference for Cash unless business policy explicitly requires
      // it" — same non-mandatory spirit).
      received_by: z.string().optional(),
      // Phase 13B (Section 24): explicit, OFF by default. Recording a
      // payment NEVER emails the customer automatically (Section 5's Core
      // Business Rule/Section 25's on-site-payment acceptance test) — this
      // is the one opt-in exception, a deliberate same-request choice, not
      // a silent default-on behavior.
      email_receipt: z.boolean().optional(),
    }) } } },
  },
  responses: {
    201: { description: "Payment recorded", content: { "application/json": { schema: z.any() } } },
    400: { description: "Invalid payment", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(recordPaymentRoute, async (c) => {
  const me = currentUser(c);
  if (!canManageFinancials({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);
  const { id } = c.req.valid("param");
  if (!(await assertInvoiceInOrganization(actorOrganizationId(c), Number(id)))) {
    return c.json({ error: "Invoice not found" }, 404);
  }
  const data = c.req.valid("json");
  try {
    // source is deliberately never client-suppliable here — every payment
    // recorded through THIS route (the office/manual action) is "manual"
    // by construction; "online_provider" is set exclusively by
    // processPaymentWebhookEvent (financial.ts), never reachable from this
    // schema (mass-assignment guard, Section 39).
    const invoice = await recordPayment(c.env.DB, Number(id), {
      amountCents: data.amount_cents,
      payerType: data.payer_type as PayerType,
      method: data.method as PaymentMethod,
      reference: data.reference ?? "",
      notes: data.notes ?? "",
      paidAt: data.paid_at ?? new Date().toISOString(),
      receivedBy: data.received_by ?? "",
    }, me.id);
    // Phase 9.1 — a payment's own id (not the invoice's) is the
    // discriminator, since multiple payments can exist per invoice.
    // recordPayment() returns the invoice, not the new payment row, so the
    // payment id is read back the same way job_schedule_history/
    // job_status_history row ids are — a read-only lookup, not a change to
    // financial.ts.
    if (data.email_receipt) {
      await safeEnqueue(async () => {
        const contact = await getCustomerContact(invoice.customer_id);
        const paymentId = await latestPaymentId(invoice.id);
        if (!contact || paymentId === null) return;
        await preparePaymentReceiptEmail(paymentId, () => enqueuePaymentReceipt({
          invoiceId: invoice.id, invoiceIdentifier: invoice.identifier,
          customerId: invoice.customer_id, customerName: contact.name, customerEmail: contact.email, customerPhone: contact.phone,
          paymentId, amountCents: data.amount_cents,
        }));
      });
    }
    return c.json(await attachFinancials(invoice as unknown as Record<string, unknown>), 201);
  } catch (err) {
    if (err instanceof FinancialError) {
      if (err.code === "not_found") return c.json({ error: err.message }, 404);
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
});

const voidPaymentRoute = createRoute({
  method: "post",
  path: "/api/payments/{id}/void",
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: z.object({ reason: z.string() }) } } },
  },
  responses: {
    200: { description: "Voided", content: { "application/json": { schema: OkSchema } } },
    400: { description: "Invalid state", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(voidPaymentRoute, async (c) => {
  const me = currentUser(c);
  if (!canManageFinancials({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);
  const paymentId = Number(c.req.valid("param").id);
  // Phase 11.5: a payment has no organization_id of its own — its tenant
  // ownership is inherited through its invoice, so this joins to confirm
  // that invoice belongs to the actor's own organization.
  const ownedPayment = await get<{ id: number }>(
    "SELECT p.id FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE p.id = ? AND i.organization_id = ?",
    [paymentId, actorOrganizationId(c)]
  );
  if (!ownedPayment) return c.json({ error: "Payment not found" }, 404);
  try {
    await voidPayment(c.env.DB, paymentId, me.id, c.req.valid("json").reason);
  } catch (err) {
    if (err instanceof FinancialError) {
      if (err.code === "not_found") return c.json({ error: err.message }, 404);
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
  return c.json({ ok: true }, 200);
});

// ── Phase 13B — Payment Receipts (Section 21-24) ────────────────────
// No `receipts` table/entity — a Receipt is a live-rendered view of one
// `payments` row (see receipt-pdf.ts's own header comment). Every route
// here reuses the exact same tenant-via-invoice ownership check as
// voidPaymentRoute above.

async function assertPaymentInOrganization(organizationId: number, paymentId: number): Promise<boolean> {
  const row = await get<{ id: number }>(
    "SELECT p.id FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE p.id = ? AND i.organization_id = ?",
    [paymentId, organizationId]
  );
  return !!row;
}

app.get("/api/payments/:id/receipt-pdf", async (c) => {
  const me = currentUser(c);
  if (!canManageFinancials({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "Payment not found" }, 404);
  if (!(await assertPaymentInOrganization(actorOrganizationId(c), id))) return c.json({ error: "Payment not found" }, 404);

  const doc = await getReceiptPdfBytesForDelivery(c.env, id);
  if (!doc) return c.json({ error: "Payment not found" }, 404);

  const disposition = c.req.query("mode") === "download" ? "attachment" : "inline";
  return new Response(doc.bytes, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${disposition}; filename="${doc.filename}"`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "private, no-store",
    },
  });
});

const getReceiptDeliveryStatusRoute = createRoute({
  method: "get",
  path: "/api/payments/{id}/receipt-status",
  request: { params: IdParam },
  responses: {
    200: { description: "Delivery status", content: { "application/json": { schema: z.object({ delivery: z.any() }) } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(getReceiptDeliveryStatusRoute, async (c) => {
  const me = currentUser(c);
  if (!canManageFinancials({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);
  const paymentId = Number(c.req.valid("param").id);
  if (!(await assertPaymentInOrganization(actorOrganizationId(c), paymentId))) {
    return c.json({ error: "Payment not found" }, 404);
  }
  const delivery = await getPaymentReceiptDeliveryStatus(paymentId);
  return c.json({ delivery }, 200);
});

const emailReceiptRoute = createRoute({
  method: "post",
  path: "/api/payments/{id}/email-receipt",
  request: { params: IdParam },
  responses: {
    200: { description: "Send result", content: { "application/json": { schema: z.object({ action: z.string() }) } } },
    400: { description: "Invalid state", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(emailReceiptRoute, async (c) => {
  const me = currentUser(c);
  if (!canManageFinancials({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);
  const paymentId = Number(c.req.valid("param").id);
  if (!(await assertPaymentInOrganization(actorOrganizationId(c), paymentId))) {
    return c.json({ error: "Payment not found" }, 404);
  }
  const payment = await getPaymentDetail(paymentId);
  if (!payment) return c.json({ error: "Payment not found" }, 404);
  const invoice = await getInvoiceById(payment.invoice_id);
  if (!invoice) return c.json({ error: "Invoice not found" }, 404);
  const contact = await getCustomerContact(invoice.customer_id);
  if (!contact) return c.json({ error: "Customer contact not found" }, 400);

  const result = await preparePaymentReceiptEmail(paymentId, () => enqueuePaymentReceipt({
    invoiceId: invoice.id, invoiceIdentifier: invoice.identifier,
    customerId: invoice.customer_id, customerName: contact.name, customerEmail: contact.email, customerPhone: contact.phone,
    paymentId, amountCents: payment.amount_cents,
  }));
  return c.json({ action: result.action }, 200);
});

// ── Phase 13B — Public payment link + provider webhook (Section 11-13, 29-30) ──
// Same generic-404-for-every-failure discipline as the public Contract
// signing routes (/api/public/contracts/sign/{token}) — a wrong token, an
// expired one, and an already-used one are all indistinguishable, so a
// link can never be used to enumerate/probe invoice state.

const GENERIC_PAY_LINK_ERROR = "This payment link is invalid or has expired";

const PublicPayViewSchema = z.object({
  invoice_identifier: z.string(),
  company_name: z.string(),
  balance_due_cents: z.number().int(),
  status: z.string(),
});

const getPublicPayViewRoute = createRoute({
  method: "get",
  path: "/api/public/invoices/pay/{token}",
  request: { params: z.object({ token: z.string() }) },
  responses: {
    200: { description: "Payment view", content: { "application/json": { schema: z.object({ view: PublicPayViewSchema }) } } },
    404: { description: "Invalid or expired link", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(getPublicPayViewRoute, async (c) => {
  const { token } = c.req.valid("param");
  const view = await getPaymentSessionByToken(token);
  if (!view) return c.json({ error: GENERIC_PAY_LINK_ERROR }, 404);
  return c.json({
    view: {
      invoice_identifier: view.invoiceIdentifier, company_name: view.companyName,
      balance_due_cents: view.balanceDueCents, status: view.session.status,
    },
  }, 200);
});

const confirmPublicPayRoute = createRoute({
  method: "post",
  path: "/api/public/invoices/pay/{token}/confirm",
  request: { params: z.object({ token: z.string() }) },
  responses: {
    200: { description: "Confirmation result", content: { "application/json": { schema: z.object({ outcome: z.string() }) } } },
    404: { description: "Invalid or expired link", content: { "application/json": { schema: ErrorSchema } } },
    503: { description: "Online payment not available", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(confirmPublicPayRoute, async (c) => {
  const { token } = c.req.valid("param");
  const secret = paymentWebhookSecret(c);
  if (!secret) return c.json({ error: "Online payment is not available" }, 503);
  try {
    const result = await confirmMockPayment(c.env.DB, paymentProvider, secret, token);
    if (result.outcome === "payment_recorded" && result.invoiceId) {
      // Section 24 — online payments auto-email the receipt (unlike
      // manual/on-site payments, which are opt-in only): the customer is
      // actively completing a self-serve checkout and expects proof of
      // payment the same way any e-commerce purchase would provide one.
      await safeEnqueue(async () => {
        const invoice = await getInvoiceById(result.invoiceId!);
        if (!invoice) return;
        const contact = await getCustomerContact(invoice.customer_id);
        const paymentId = await latestPaymentId(invoice.id);
        if (!contact || paymentId === null) return;
        const payment = await getPaymentDetail(paymentId);
        if (!payment) return;
        await preparePaymentReceiptEmail(paymentId, () => enqueuePaymentReceipt({
          invoiceId: invoice.id, invoiceIdentifier: invoice.identifier,
          customerId: invoice.customer_id, customerName: contact.name, customerEmail: contact.email, customerPhone: contact.phone,
          paymentId, amountCents: payment.amount_cents,
        }));
      });
    }
    return c.json({ outcome: result.outcome }, 200);
  } catch (err) {
    if (err instanceof FinancialError) return c.json({ error: GENERIC_PAY_LINK_ERROR }, 404);
    throw err;
  }
});

const cancelPublicPayRoute = createRoute({
  method: "post",
  path: "/api/public/invoices/pay/{token}/cancel",
  request: { params: z.object({ token: z.string() }) },
  responses: {
    200: { description: "Cancelled", content: { "application/json": { schema: OkSchema } } },
    400: { description: "Already resolved (paid/cancelled by another request)", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Invalid or expired link", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(cancelPublicPayRoute, async (c) => {
  const { token } = c.req.valid("param");
  try {
    const result = await cancelPaymentSessionByToken(token);
    if (result.alreadyResolved) {
      return c.json({ error: "This payment was already completed or cancelled" }, 400);
    }
    return c.json({ ok: true }, 200);
  } catch (err) {
    if (err instanceof FinancialError) return c.json({ error: GENERIC_PAY_LINK_ERROR }, 404);
    throw err;
  }
});

// The "real" provider webhook endpoint (Section 30) — architecturally
// present and fully functional (signature verification, replay
// protection via the atomic pending->succeeded claim, amount/session
// binding) even though the mock "Pay Now" flow above triggers the exact
// same processPaymentWebhookEvent() in-process rather than over a real
// HTTP round trip (a local mock provider has no separate external process
// to call back from — see payment-provider.ts's own header comment).
app.post("/api/webhooks/payments/mock", async (c) => {
  const secret = paymentWebhookSecret(c);
  if (!secret) return c.json({ error: "Not configured" }, 503);
  const rawBody = await c.req.text();
  const signature = c.req.header("X-Mock-Signature") ?? null;
  const result = await processPaymentWebhookEvent(c.env.DB, paymentProvider, secret, rawBody, signature);
  if (result.outcome === "invalid_signature") return c.json({ error: "Invalid signature" }, 401);
  if (result.outcome === "session_not_found") return c.json({ error: "Unknown session" }, 404);
  return c.json({ outcome: result.outcome }, 200);
});

const paymentsConfigResponseSchema = z.object({ enabled: z.boolean() });
const getPaymentsConfig = createRoute({
  method: "get",
  path: "/api/config/payments",
  responses: {
    200: { description: "Online payment config", content: { "application/json": { schema: paymentsConfigResponseSchema } } },
  },
});

app.openapi(getPaymentsConfig, async (c) => {
  return c.json({ enabled: !!paymentWebhookSecret(c) }, 200);
});

// ── Create invoice from job (idempotent — see financial.ts) ─────────

const invoiceFromJob = createRoute({
  method: "post",
  path: "/api/jobs/{id}/invoice",
  request: { params: IdParam },
  responses: {
    200: { description: "Existing invoice for this job returned as-is (idempotent)", content: { "application/json": { schema: z.any() } } },
    201: { description: "Invoice created from job", content: { "application/json": { schema: z.any() } } },
    400: { description: "Invalid state", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(invoiceFromJob, async (c) => {
  const me = currentUser(c);
  if (!canManageFinancials({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);

  const { id } = c.req.valid("param");
  const ownedJob = await get<{ id: number }>(
    "SELECT id FROM jobs WHERE id = ? AND organization_id = ?", [id, actorOrganizationId(c)]
  );
  if (!ownedJob) return c.json({ error: "Job not found" }, 404);
  try {
    const { invoice, created } = await generateInvoiceForJob(c.env.DB, Number(id), me.id);
    const result = await get<Record<string, unknown>>(
      `SELECT i.*, c.name as customer_name FROM invoices i
       LEFT JOIN customers c ON i.customer_id = c.id WHERE i.id = ?`, [invoice.id]
    );
    const body = { ...(await attachFinancials(result!)), created };
    if (created) return c.json(body, 201);
    return c.json(body, 200);
  } catch (err) {
    if (err instanceof FinancialError) {
      if (err.code === "not_found") return c.json({ error: err.message }, 404);
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
});

// ── Auth ───────────────────────────────────────────────────────────

const USER_COLUMNS = "id, name, email, role, active, last_login_at, created_at, updated_at";

const login = createRoute({
  method: "post",
  path: "/api/auth/login",
  request: {
    body: {
      content: { "application/json": { schema: z.object({
        email: z.string().email(),
        password: z.string().min(1),
        remember: z.boolean().optional(),
      }) } },
    },
  },
  responses: {
    200: { description: "Logged in", content: { "application/json": { schema: z.object({ user: UserSchema }) } } },
    401: { description: "Invalid credentials", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Account inactive", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(login, async (c) => {
  const { email, password, remember } = c.req.valid("json");
  const row = await get<UserRow>("SELECT * FROM users WHERE email = ?", [email.toLowerCase().trim()]);
  const valid = await verifyPasswordOrDummy(password, row?.password_hash);
  if (!row || !valid) return c.json({ error: "Invalid email or password" }, 401);
  if (!row.active) return c.json({ error: "This account has been deactivated. Contact an administrator." }, 403);

  const { token, expiresAt } = await createSession(row.id, !!remember);
  setSessionCookie(c, token, !!remember, expiresAt);
  await run("UPDATE users SET last_login_at = datetime('now') WHERE id = ?", [row.id]);
  const user = await get<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`, [row.id]);
  return c.json({ user: user as PublicUser }, 200);
});

const logout = createRoute({
  method: "post",
  path: "/api/auth/logout",
  responses: {
    200: { description: "Logged out", content: { "application/json": { schema: OkSchema } } },
  },
});

app.openapi(logout, async (c) => {
  await logoutCurrentSession(c);
  return c.json({ ok: true }, 200);
});

const me = createRoute({
  method: "get",
  path: "/api/auth/me",
  responses: {
    200: { description: "Current user", content: { "application/json": { schema: z.object({ user: UserSchema }) } } },
    401: { description: "Not authenticated", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(me, async (c) => {
  return c.json({ user: currentUser(c) }, 200);
});

const changeOwnPassword = createRoute({
  method: "put",
  path: "/api/auth/password",
  request: {
    body: {
      content: { "application/json": { schema: z.object({
        current_password: z.string().min(1),
        new_password: PasswordSchema,
      }) } },
    },
  },
  responses: {
    200: { description: "Password changed", content: { "application/json": { schema: OkSchema } } },
    400: { description: "Current password incorrect", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(changeOwnPassword, async (c) => {
  const user = currentUser(c);
  const { current_password, new_password } = c.req.valid("json");
  const row = await get<UserRow>("SELECT * FROM users WHERE id = ?", [user.id]);
  if (!row || !(await verifyPassword(current_password, row.password_hash))) {
    return c.json({ error: "Current password is incorrect" }, 400);
  }
  const passwordHash = await hashPassword(new_password);
  await run("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?", [passwordHash, user.id]);
  return c.json({ ok: true }, 200);
});

// ── Users (administrator only) ────────────────────────────────────

const listUsers = createRoute({
  method: "get",
  path: "/api/users",
  request: { query: z.object({ search: z.string().optional() }) },
  responses: {
    200: { description: "User list", content: { "application/json": { schema: z.object({ users: z.array(UserSchema) }) } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(listUsers, async (c) => {
  const me = currentUser(c);
  if (me.role !== "admin") return c.json({ error: "Forbidden" }, 403);

  const { search } = c.req.valid("query");
  let where = "WHERE organization_id = ?";
  const params: unknown[] = [actorOrganizationId(c)];
  if (search) {
    where += " AND (name LIKE ? OR email LIKE ?)";
    const s = `%${search}%`;
    params.push(s, s);
  }
  const users = await query<PublicUser>(
    `SELECT ${USER_COLUMNS} FROM users ${where} ORDER BY created_at ASC`,
    params
  );
  return c.json({ users }, 200);
});

// Phase 8.5 security/integrity sweep — assignee directory contract fix.
// GET /api/users above is deliberately admin-only and stays that way (it
// exposes email/active/last_login_at/timestamps — real account-management
// detail, not appropriate for a wider audience). But Phase 8.2 gave
// dispatcher full Lead management parity with admin (mem:architecture/auth),
// including assignment — and Phase 8.4 discovered dispatcher couldn't
// populate a readable "Assigned To" selector because of that admin-only
// gate, a real UX gap this route resolves without loosening GET /api/users
// itself. Deliberately minimal: id/name/role only (no email, no
// active/last_login_at/timestamps, nothing else) and pre-filtered server-side
// to exactly the roles validateLeadAssigneeUserId() already accepts
// (admin/dispatcher) — a technician is structurally never returned, not just
// hidden client-side.
const AssignableUserSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  role: RoleSchema,
}).openapi("AssignableUser");

const listAssignableUsers = createRoute({
  method: "get",
  path: "/api/users/assignable",
  responses: {
    200: { description: "Admin/dispatcher users eligible as a Lead assignee", content: { "application/json": { schema: z.object({ users: z.array(AssignableUserSchema) }) } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(listAssignableUsers, async (c) => {
  const me = currentUser(c);
  if (me.role === "technician") return c.json({ error: "Forbidden" }, 403);
  const users = await query<{ id: number; name: string; role: Role }>(
    "SELECT id, name, role FROM users WHERE organization_id = ? AND role IN ('admin', 'dispatcher') ORDER BY name ASC",
    [actorOrganizationId(c)]
  );
  return c.json({ users }, 200);
});

const createUser = createRoute({
  method: "post",
  path: "/api/users",
  request: {
    body: {
      content: { "application/json": { schema: z.object({
        name: z.string().min(1),
        email: z.string().email(),
        password: PasswordSchema,
        role: RoleSchema.optional(),
        active: z.number().int().min(0).max(1).optional(),
      }) } },
    },
  },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: z.object({ user: UserSchema }) } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Email already in use", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(createUser, async (c) => {
  const me = currentUser(c);
  if (me.role !== "admin") return c.json({ error: "Forbidden" }, 403);

  const data = c.req.valid("json");
  const email = data.email.toLowerCase().trim();
  const existing = await get("SELECT id FROM users WHERE email = ?", [email]);
  if (existing) return c.json({ error: "A user with this email already exists" }, 409);

  const passwordHash = await hashPassword(data.password);
  const result = await run(
    "INSERT INTO users (organization_id, name, email, password_hash, role, active) VALUES (?, ?, ?, ?, ?, ?)",
    [actorOrganizationId(c), data.name.trim(), email, passwordHash, data.role || "dispatcher", data.active ?? 1]
  );
  const user = await get<PublicUser>(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`, [result.lastInsertRowid]);
  return c.json({ user: user as PublicUser }, 201);
});

const getUser = createRoute({
  method: "get",
  path: "/api/users/{id}",
  request: { params: IdParam },
  responses: {
    200: { description: "User detail", content: { "application/json": { schema: z.object({ user: UserSchema }) } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(getUser, async (c) => {
  const me = currentUser(c);
  if (me.role !== "admin") return c.json({ error: "Forbidden" }, 403);

  const { id } = c.req.valid("param");
  const user = await get<PublicUser>(`SELECT ${USER_COLUMNS} FROM users WHERE id = ? AND organization_id = ?`, [id, actorOrganizationId(c)]);
  if (!user) return c.json({ error: "User not found" }, 404);
  return c.json({ user }, 200);
});

const updateUser = createRoute({
  method: "put",
  path: "/api/users/{id}",
  request: {
    params: IdParam,
    body: {
      content: { "application/json": { schema: z.object({
        name: z.string().min(1).optional(),
        email: z.string().email().optional(),
        role: RoleSchema.optional(),
        active: z.number().int().min(0).max(1).optional(),
      }) } },
    },
  },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: z.object({ user: UserSchema }) } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Email already in use", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(updateUser, async (c) => {
  const me = currentUser(c);
  if (me.role !== "admin") return c.json({ error: "Forbidden" }, 403);

  const { id } = c.req.valid("param");
  const data = c.req.valid("json");
  const organizationId = actorOrganizationId(c);
  const target = await get<{ id: number; role: string; active: number }>(
    "SELECT id, role, active FROM users WHERE id = ? AND organization_id = ?", [id, organizationId]
  );
  if (!target) return c.json({ error: "User not found" }, 404);

  if (data.active === 0) {
    if (Number(id) === me.id) return c.json({ error: "You cannot deactivate your own account" }, 400);
    if (target.role === "admin") {
      // Phase 11.5: "last administrator" means the last one IN THIS
      // ORGANIZATION — an admin count that included other organizations'
      // admins would wrongly let the true last admin of this org deactivate
      // themselves out of it.
      const otherActiveAdmins = await get<{ count: number }>(
        "SELECT COUNT(*) as count FROM users WHERE organization_id = ? AND role = 'admin' AND active = 1 AND id != ?",
        [organizationId, id]
      );
      if ((otherActiveAdmins?.count || 0) === 0) {
        return c.json({ error: "Cannot deactivate the last active administrator" }, 400);
      }
    }
  }
  if (data.role && data.role !== "admin" && target.role === "admin" && Number(id) === me.id) {
    return c.json({ error: "You cannot change your own administrator role" }, 400);
  }

  const fields: string[] = [];
  const params: unknown[] = [];
  if (data.name !== undefined) { fields.push("name = ?"); params.push(data.name.trim()); }
  if (data.email !== undefined) {
    const email = data.email.toLowerCase().trim();
    const dupe = await get("SELECT id FROM users WHERE email = ? AND id != ?", [email, id]);
    if (dupe) return c.json({ error: "A user with this email already exists" }, 409);
    fields.push("email = ?"); params.push(email);
  }
  if (data.role !== undefined) { fields.push("role = ?"); params.push(data.role); }
  if (data.active !== undefined) { fields.push("active = ?"); params.push(data.active); }
  if (fields.length === 0) return c.json({ error: "No fields to update" }, 400);
  fields.push("updated_at = datetime('now')");

  await run(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`, [...params, id]);
  if (data.active === 0) await invalidateUserSessions(Number(id));
  const user = await get<PublicUser>(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`, [id]);
  return c.json({ user: user as PublicUser }, 200);
});

const setUserPassword = createRoute({
  method: "put",
  path: "/api/users/{id}/password",
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: z.object({ password: PasswordSchema }) } } },
  },
  responses: {
    200: { description: "Password changed", content: { "application/json": { schema: OkSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(setUserPassword, async (c) => {
  const me = currentUser(c);
  if (me.role !== "admin") return c.json({ error: "Forbidden" }, 403);

  const { id } = c.req.valid("param");
  const target = await get("SELECT id FROM users WHERE id = ? AND organization_id = ?", [id, actorOrganizationId(c)]);
  if (!target) return c.json({ error: "User not found" }, 404);

  const { password } = c.req.valid("json");
  const passwordHash = await hashPassword(password);
  await run("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?", [passwordHash, id]);
  await invalidateUserSessions(Number(id));
  return c.json({ ok: true }, 200);
});

const deleteUser = createRoute({
  method: "delete",
  path: "/api/users/{id}",
  request: { params: IdParam },
  responses: {
    200: { description: "Deleted", content: { "application/json": { schema: OkSchema } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(deleteUser, async (c) => {
  const me = currentUser(c);
  if (me.role !== "admin") return c.json({ error: "Forbidden" }, 403);

  const { id } = c.req.valid("param");
  if (Number(id) === me.id) return c.json({ error: "You cannot delete your own account" }, 400);

  const organizationId = actorOrganizationId(c);
  const target = await get<{ id: number; role: string }>(
    "SELECT id, role FROM users WHERE id = ? AND organization_id = ?", [id, organizationId]
  );
  if (!target) return c.json({ error: "User not found" }, 404);
  if (target.role === "admin") {
    const otherActiveAdmins = await get<{ count: number }>(
      "SELECT COUNT(*) as count FROM users WHERE organization_id = ? AND role = 'admin' AND active = 1 AND id != ?",
      [organizationId, id]
    );
    if ((otherActiveAdmins?.count || 0) === 0) return c.json({ error: "Cannot delete the last administrator" }, 400);
  }

  await run("DELETE FROM users WHERE id = ?", [id]);
  return c.json({ ok: true }, 200);
});

// ── Global Settings ───────────────────────────────────────────────
// Versioned, effective-dated configuration (rebate thresholds, warning windows,
// program rules, etc.) so government-defined numbers never require a code deploy
// to change, and jobs whose eligibility was already evaluated keep resolving the
// rule that applied to them at the time. See src/server/settings.ts for the
// version-history mechanics.
//
// Phase 13C RBAC hardening: the Settings *management* surface (this list
// route with no/any-other category, history, publish, retire) is admin-only
// in both directions — a dispatcher/technician has no legitimate reason to
// see rebate-program thresholds/amounts, business timezone, or any other
// administrative configuration value. The ONE deliberate exception is
// `?category=reference_data` (REFERRAL_SOURCE_OPTIONS/HEATING_SOURCE_OPTIONS/
// LEAD_LOST_REASON_OPTIONS) — plain UI dropdown option lists with no
// financial/threshold content, consumed by `useReferenceData()` across
// Customer/Lead/Asset forms that dispatcher AND technician both use; locking
// that down would silently empty those dropdowns for every non-admin role,
// which is a real regression this phase does not intend. Narrower
// operational reads that used to piggyback on the unrestricted full list
// (e.g. Technician Route's business-timezone lookup) now use a dedicated,
// non-sensitive `/api/config/*`-pattern route instead — see
// `GET /api/config/business-timezone` below. Writes remain admin-only, same
// gate as /api/users (unchanged by this phase).

const GlobalSettingSchema = z.object({
  id: z.number().int(),
  key: z.string(),
  value: z.string(),
  data_type: z.enum(["string", "number", "boolean", "json"]),
  category: z.string(),
  description: z.string(),
  effective_from: z.string(),
  effective_until: z.string().nullable(),
  active: z.number().int(),
  updated_by: z.number().int().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
}).openapi("GlobalSetting");

const listSettings = createRoute({
  method: "get",
  path: "/api/settings",
  request: { query: z.object({ category: z.string().optional() }) },
  responses: {
    200: { description: "Current settings", content: { "application/json": { schema: z.object({ settings: z.array(GlobalSettingSchema) }) } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(listSettings, async (c) => {
  const { category } = c.req.valid("query");
  const me = currentUser(c);
  if (category !== "reference_data" && me.role !== "admin") return c.json({ error: "Forbidden" }, 403);
  const settings = await listCurrentSettings(actorOrganizationId(c), category);
  return c.json({ settings }, 200);
});

const getSettingHistoryRoute = createRoute({
  method: "get",
  path: "/api/settings/{key}/history",
  request: { params: z.object({ key: z.string() }) },
  responses: {
    200: { description: "Version history", content: { "application/json": { schema: z.object({ history: z.array(GlobalSettingSchema) }) } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(getSettingHistoryRoute, async (c) => {
  const me = currentUser(c);
  if (me.role !== "admin") return c.json({ error: "Forbidden" }, 403);
  const { key } = c.req.valid("param");
  const history = await getSettingHistory(actorOrganizationId(c), key);
  return c.json({ history }, 200);
});

const publishSettingRoute = createRoute({
  method: "post",
  path: "/api/settings",
  request: {
    body: {
      content: { "application/json": { schema: z.object({
        key: z.string().min(1),
        value: z.string(),
        data_type: z.enum(["string", "number", "boolean", "json"]),
        category: z.string().optional(),
        description: z.string().optional(),
        effective_from: z.string().optional(),
      }) } },
    },
  },
  responses: {
    201: { description: "New version published", content: { "application/json": { schema: z.object({ setting: GlobalSettingSchema }) } } },
    400: { description: "Invalid value or version ordering", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(publishSettingRoute, async (c) => {
  const me = currentUser(c);
  if (me.role !== "admin") return c.json({ error: "Forbidden" }, 403);

  const data = c.req.valid("json");
  if (data.data_type === "number" && !Number.isFinite(Number(data.value))) {
    return c.json({ error: "Value is not a valid number" }, 400);
  }
  if (data.data_type === "boolean" && data.value !== "true" && data.value !== "false") {
    return c.json({ error: "Value must be \"true\" or \"false\"" }, 400);
  }
  if (data.data_type === "json") {
    try { JSON.parse(data.value); } catch { return c.json({ error: "Value is not valid JSON" }, 400); }
  }
  // BUSINESS_TIMEZONE must be a real, DST-safe IANA zone id (e.g.
  // "America/Vancouver") — never a fixed offset ("-07:00"/"UTC-7") or a
  // legacy abbreviation ("PST"), both of which silently break every winter/
  // summer. See src/server/business-timezone.ts#isValidIanaTimezone for why
  // Intl.DateTimeFormat's own (too permissive) validation isn't used alone.
  if (data.key === BUSINESS_TIMEZONE_SETTING_KEY && !isValidIanaTimezone(data.value)) {
    return c.json({ error: `"${data.value}" is not a valid IANA timezone (e.g. "America/Vancouver"). Fixed offsets and abbreviations like "PST" are not accepted — they aren't DST-safe.` }, 400);
  }

  try {
    const setting = await publishSetting({
      organizationId: actorOrganizationId(c),
      key: data.key,
      value: data.value,
      dataType: data.data_type,
      category: data.category,
      description: data.description,
      effectiveFrom: data.effective_from,
      updatedBy: me.id,
    });
    return c.json({ setting }, 201);
  } catch (err) {
    if (err instanceof SettingVersionError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

const retireSettingRoute = createRoute({
  method: "delete",
  path: "/api/settings/{key}",
  request: { params: z.object({ key: z.string() }) },
  responses: {
    200: { description: "Retired", content: { "application/json": { schema: OkSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "No active version to retire", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(retireSettingRoute, async (c) => {
  const me = currentUser(c);
  if (me.role !== "admin") return c.json({ error: "Forbidden" }, 403);
  const { key } = c.req.valid("param");
  const retired = await retireSetting(actorOrganizationId(c), key, me.id);
  if (!retired) return c.json({ error: "No active version for this key" }, 404);
  return c.json({ ok: true }, 200);
});

// ── Company Profile ──────────────────────────────────────────────────
// Tenant business identity (name, contact, address, business/tax IDs, a
// default Contract footer) — see migrations/0019 and company-profile.ts
// for the full rationale. Admin-only both directions: no operational
// read need for dispatchers/technicians beyond the finished Contract
// documents they already access through Contract permissions, and this
// matches the existing Global Settings nav item's adminOnly gate.

const CompanyProfileSchema = z.object({
  organization_id: z.number().int(),
  company_name: z.string(),
  legal_name: z.string(),
  phone: z.string(),
  email: z.string(),
  website: z.string(),
  address_line1: z.string(),
  address_line2: z.string(),
  city: z.string(),
  state: z.string(),
  postal_code: z.string(),
  country: z.string(),
  business_number: z.string(),
  tax_number: z.string(),
  contract_footer: z.string(),
  logo_key: z.string().nullable(),
  updated_by: z.number().int().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
}).openapi("CompanyProfile");

const getCompanyProfileRoute = createRoute({
  method: "get",
  path: "/api/company-profile",
  responses: {
    200: { description: "Current company profile", content: { "application/json": { schema: z.object({ profile: CompanyProfileSchema }) } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(getCompanyProfileRoute, async (c) => {
  const me = currentUser(c);
  if (me.role !== "admin") return c.json({ error: "Forbidden" }, 403);
  const profile = await getCompanyProfile(actorOrganizationId(c));
  return c.json({ profile }, 200);
});

const updateCompanyProfileRoute = createRoute({
  method: "put",
  path: "/api/company-profile",
  request: {
    body: {
      content: { "application/json": { schema: z.object({
        company_name: z.string().optional(),
        legal_name: z.string().optional(),
        phone: z.string().optional(),
        email: z.string().optional(),
        website: z.string().optional(),
        address_line1: z.string().optional(),
        address_line2: z.string().optional(),
        city: z.string().optional(),
        state: z.string().optional(),
        postal_code: z.string().optional(),
        country: z.string().optional(),
        business_number: z.string().optional(),
        tax_number: z.string().optional(),
        contract_footer: z.string().optional(),
      }) } },
    },
  },
  responses: {
    200: { description: "Updated company profile", content: { "application/json": { schema: z.object({ profile: CompanyProfileSchema }) } } },
    400: { description: "Invalid value", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(updateCompanyProfileRoute, async (c) => {
  const me = currentUser(c);
  if (me.role !== "admin") return c.json({ error: "Forbidden" }, 403);
  const data = c.req.valid("json");
  try {
    const profile = await upsertCompanyProfile(actorOrganizationId(c), data, me.id);
    return c.json({ profile }, 200);
  } catch (err) {
    if (err instanceof CompanyProfileValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

// ── Company Logo (Phase 13A final document hardening, Section 6-11) ────
// Plain (non-openapi) multipart routes, matching the exact convention
// already used for job photo uploads — a real <input type="file"> upload,
// not a JSON data-url, since a logo can be a few hundred KB. Admin-only,
// same gate as the rest of Company Profile.

app.post("/api/company-profile/logo", async (c) => {
  const me = currentUser(c);
  if (me.role !== "admin") return c.json({ error: "Forbidden" }, 403);
  const body = await c.req.parseBody();
  const file = body["file"];
  if (!(file instanceof File)) return c.json({ error: "A file is required" }, 400);
  try {
    const profile = await setCompanyLogo(c.env, actorOrganizationId(c), new Uint8Array(await file.arrayBuffer()), file.type, me.id);
    return c.json({ profile }, 200);
  } catch (err) {
    if (err instanceof StorageError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

app.delete("/api/company-profile/logo", async (c) => {
  const me = currentUser(c);
  if (me.role !== "admin") return c.json({ error: "Forbidden" }, 403);
  const profile = await removeCompanyLogo(c.env, actorOrganizationId(c), me.id);
  return c.json({ profile }, 200);
});

/** Inline preview for the Global Settings UI — admin-only, same as every
 *  other Company Profile route (no logo bytes are ever public). */
app.get("/api/company-profile/logo", async (c) => {
  const me = currentUser(c);
  if (me.role !== "admin") return c.json({ error: "Forbidden" }, 403);
  const logo = await getCompanyLogo(c.env, actorOrganizationId(c));
  if (!logo) return c.json({ error: "No logo configured" }, 404);
  return new Response(logo.bytes.slice().buffer as ArrayBuffer, {
    headers: {
      "content-type": logo.contentType,
      "content-disposition": "inline",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
});

// ── Google Calendar Integration ─────────────────────────────────────
// Each Field Scheduler user connects their own Google account (calendar_integrations
// is keyed one-per-user). Google API calls and the OAuth client secret never leave
// the server — the frontend only ever sees connection status, never tokens.

function randomState(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
}

function returnOriginFrom(c: Context<Env>): string {
  const referer = c.req.header("referer");
  if (referer) {
    try {
      return new URL(referer).origin;
    } catch {
      // fall through to request origin
    }
  }
  return new URL(c.req.url).origin;
}

const IntegrationStatusSchema = z.object({
  connected: z.boolean(),
  account_email: z.string().optional(),
  calendar_id: z.string().optional(),
  calendar_summary: z.string().optional(),
  sync_enabled: z.boolean().optional(),
  status: z.string().optional(),
  connected_at: z.string().nullable().optional(),
}).openapi("GoogleCalendarIntegrationStatus");

interface IntegrationStatusRow {
  google_account_email: string;
  google_calendar_id: string;
  google_calendar_summary: string;
  sync_enabled: number;
  status: string;
  connected_at: string | null;
}

const getIntegration = createRoute({
  method: "get",
  path: "/api/integrations/google-calendar",
  responses: {
    200: { description: "Integration status", content: { "application/json": { schema: IntegrationStatusSchema } } },
  },
});

app.openapi(getIntegration, async (c) => {
  const user = currentUser(c);
  const row = await get<IntegrationStatusRow>(
    "SELECT google_account_email, google_calendar_id, google_calendar_summary, sync_enabled, status, connected_at FROM calendar_integrations WHERE user_id = ?",
    [user.id]
  );
  if (!row) return c.json({ connected: false }, 200);
  return c.json({
    connected: true,
    account_email: row.google_account_email,
    calendar_id: row.google_calendar_id,
    calendar_summary: row.google_calendar_summary,
    sync_enabled: !!row.sync_enabled,
    status: row.status,
    connected_at: row.connected_at,
  }, 200);
});

// Plain (non-OpenAPI) routes below: these are browser navigations/redirects, not JSON contracts.

app.get("/api/integrations/google-calendar/connect", async (c) => {
  if (!isGoogleConfigured(c)) {
    return c.text("Google Calendar integration is not configured on this server. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI, and TOKEN_ENCRYPTION_KEY.", 503);
  }
  const user = currentUser(c);
  const state = randomState();
  await run(
    "INSERT INTO calendar_oauth_states (state, user_id, return_origin) VALUES (?, ?, ?)",
    [state, user.id, returnOriginFrom(c)]
  );
  return c.redirect(buildAuthUrl(googleEnv(c), state), 302);
});

app.get("/api/integrations/google-calendar/callback", async (c) => {
  const user = currentUser(c);
  const query_ = new URL(c.req.url).searchParams;
  const oauthError = query_.get("error");
  const code = query_.get("code");
  const state = query_.get("state");

  const stateRow = state
    ? await get<{ user_id: number; return_origin: string }>(
        "SELECT user_id, return_origin FROM calendar_oauth_states WHERE state = ?", [state]
      )
    : undefined;
  if (state) await run("DELETE FROM calendar_oauth_states WHERE state = ?", [state]);

  const redirectBase = stateRow?.return_origin || returnOriginFrom(c);
  const goBack = (status: string) => c.redirect(`${redirectBase}/integrations?google=${status}`, 302);

  if (oauthError) return goBack("denied");
  if (!code || !state || !stateRow || stateRow.user_id !== user.id) return goBack("invalid_request");
  if (!isGoogleConfigured(c)) return goBack("not_configured");

  try {
    const env = googleEnv(c);
    const tokens = await exchangeCodeForTokens(env, code);
    const accountEmail = await fetchGoogleAccountEmail(tokens.access_token);
    const accessEnc = await encryptSecret(tokens.access_token, env.TOKEN_ENCRYPTION_KEY);
    const refreshEnc = tokens.refresh_token ? await encryptSecret(tokens.refresh_token, env.TOKEN_ENCRYPTION_KEY) : "";
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

    await run(
      `INSERT INTO calendar_integrations
         (user_id, provider, google_account_email, google_calendar_id, google_calendar_summary,
          access_token_encrypted, refresh_token_encrypted, token_expires_at, scope, sync_enabled, status, connected_at, updated_at)
       VALUES (?, 'google', ?, 'primary', 'Primary Calendar', ?, ?, ?, ?, 1, 'connected', datetime('now'), datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET
         google_account_email = excluded.google_account_email,
         access_token_encrypted = excluded.access_token_encrypted,
         refresh_token_encrypted = CASE WHEN excluded.refresh_token_encrypted != '' THEN excluded.refresh_token_encrypted ELSE calendar_integrations.refresh_token_encrypted END,
         token_expires_at = excluded.token_expires_at,
         scope = excluded.scope,
         status = 'connected',
         updated_at = datetime('now')`,
      [user.id, accountEmail, accessEnc, refreshEnc, expiresAt, tokens.scope]
    );
    return goBack("connected");
  } catch {
    return goBack("error");
  }
});

const listCalendarsRoute = createRoute({
  method: "get",
  path: "/api/integrations/google-calendar/calendars",
  responses: {
    200: {
      description: "Available Google Calendars",
      content: { "application/json": { schema: z.object({
        calendars: z.array(z.object({ id: z.string(), summary: z.string(), primary: z.boolean().optional() })),
      }) } },
    },
    400: { description: "Not connected", content: { "application/json": { schema: ErrorSchema } } },
    // 409, not 401: this reports that the *Google* credential is stale, not the caller's
    // Field Scheduler session (which the "/api/*" auth middleware already verified before this
    // handler ran). Reusing 401 here previously collided with api.ts's global rule that any
    // 401 response means "your Field Scheduler session is invalid, log out" — a valid session
    // hitting this route while Google needs reauthorization was getting force-logged-out.
    409: { description: "Google authorization needs to be renewed", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(listCalendarsRoute, async (c) => {
  const user = currentUser(c);
  try {
    const accessToken = await getValidAccessTokenForUser(googleEnv(c), user.id);
    const calendars = await listGoogleCalendars(accessToken);
    return c.json({ calendars }, 200);
  } catch (err) {
    if (err instanceof GoogleApiError) {
      if (err.code === "not_connected") return c.json({ error: err.detail }, 400);
      if (err.isAuthError) {
        await run(
          "UPDATE calendar_integrations SET status = 'needs_reauth', updated_at = datetime('now') WHERE user_id = ?",
          [user.id]
        );
        return c.json({ error: "Google authorization has expired. Please reconnect." }, 409);
      }
    }
    return c.json({ error: "Could not reach Google Calendar" }, 400);
  }
});

const updateIntegrationSettings = createRoute({
  method: "put",
  path: "/api/integrations/google-calendar/settings",
  request: {
    body: {
      content: { "application/json": { schema: z.object({
        calendar_id: z.string().min(1),
        calendar_summary: z.string().optional(),
        sync_enabled: z.boolean(),
      }) } },
    },
  },
  responses: {
    200: { description: "Saved", content: { "application/json": { schema: OkSchema } } },
    400: { description: "Not connected", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(updateIntegrationSettings, async (c) => {
  const user = currentUser(c);
  const data = c.req.valid("json");
  const existing = await get("SELECT id FROM calendar_integrations WHERE user_id = ?", [user.id]);
  if (!existing) return c.json({ error: "Google Calendar is not connected" }, 400);

  await run(
    "UPDATE calendar_integrations SET google_calendar_id = ?, google_calendar_summary = ?, sync_enabled = ?, updated_at = datetime('now') WHERE user_id = ?",
    [data.calendar_id, data.calendar_summary || data.calendar_id, data.sync_enabled ? 1 : 0, user.id]
  );
  return c.json({ ok: true }, 200);
});

const disconnectIntegration = createRoute({
  method: "post",
  path: "/api/integrations/google-calendar/disconnect",
  responses: {
    200: { description: "Disconnected", content: { "application/json": { schema: OkSchema } } },
  },
});

app.openapi(disconnectIntegration, async (c) => {
  const user = currentUser(c);
  const env = googleEnv(c);
  const integration = await get<{ access_token_encrypted: string; refresh_token_encrypted: string }>(
    "SELECT access_token_encrypted, refresh_token_encrypted FROM calendar_integrations WHERE user_id = ?",
    [user.id]
  );
  if (integration) {
    // Best-effort revoke with Google; disconnecting locally must succeed either way.
    try {
      const token = integration.refresh_token_encrypted
        ? await decryptSecret(integration.refresh_token_encrypted, env.TOKEN_ENCRYPTION_KEY)
        : await decryptSecret(integration.access_token_encrypted, env.TOKEN_ENCRYPTION_KEY);
      await revokeToken(token);
    } catch {
      // Ignore — we still clear the local record below.
    }
  }
  await run("DELETE FROM calendar_integrations WHERE user_id = ?", [user.id]);
  return c.json({ ok: true }, 200);
});

const SyncNowSchema = z.object({
  created: z.number().int(),
  updated: z.number().int(),
  deleted: z.number().int(),
  failed: z.number().int(),
}).openapi("GoogleCalendarSyncResult");

const syncNow = createRoute({
  method: "post",
  path: "/api/integrations/google-calendar/sync",
  responses: {
    200: { description: "Sync completed", content: { "application/json": { schema: SyncNowSchema } } },
    400: { description: "Not connected", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(syncNow, async (c) => {
  const user = currentUser(c);
  const integration = await get("SELECT id FROM calendar_integrations WHERE user_id = ?", [user.id]);
  if (!integration) return c.json({ error: "Google Calendar is not connected" }, 400);

  const result = await syncAllJobsForUser(googleEnv(c), user.id);
  return c.json(result, 200);
});

const JobSyncStatusSchema = z.object({
  sync_status: z.string().nullable(),
  sync_error: z.string().nullable(),
  last_synced_at: z.string().nullable(),
}).openapi("GoogleCalendarJobSyncStatus");

const getJobSyncStatus = createRoute({
  method: "get",
  path: "/api/integrations/google-calendar/jobs/{id}",
  request: { params: IdParam },
  responses: {
    200: { description: "Job sync status", content: { "application/json": { schema: JobSyncStatusSchema } } },
  },
});

app.openapi(getJobSyncStatus, async (c) => {
  const user = currentUser(c);
  const { id } = c.req.valid("param");
  const mapping = await get<{ sync_status: string; sync_error: string; last_synced_at: string | null }>(
    "SELECT sync_status, sync_error, last_synced_at FROM calendar_event_mappings WHERE user_id = ? AND job_id = ?",
    [user.id, id]
  );
  if (!mapping) return c.json({ sync_status: null, sync_error: null, last_synced_at: null }, 200);
  return c.json(mapping, 200);
});

const retryJobSync = createRoute({
  method: "post",
  path: "/api/integrations/google-calendar/jobs/{id}/retry",
  request: { params: IdParam },
  responses: {
    200: { description: "Retried", content: { "application/json": { schema: JobSyncStatusSchema } } },
    400: { description: "Not connected", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(retryJobSync, async (c) => {
  const user = currentUser(c);
  const { id } = c.req.valid("param");
  const integration = await get("SELECT id FROM calendar_integrations WHERE user_id = ?", [user.id]);
  if (!integration) return c.json({ error: "Google Calendar is not connected" }, 400);
  // Phase 11.5: syncJobForUser()'s own job lookup has no organization
  // filter (it's an internal engine function, not a route) — without this
  // check, an actor could retry-sync another organization's job straight
  // into their own connected Google Calendar.
  const ownedJob = await get<{ id: number }>(
    "SELECT id FROM jobs WHERE id = ? AND organization_id = ?", [id, actorOrganizationId(c)]
  );
  if (!ownedJob) return c.json({ error: "Job not found" }, 404);

  await syncJobForUser(googleEnv(c), user.id, Number(id));
  const mapping = await get<{ sync_status: string; sync_error: string; last_synced_at: string | null }>(
    "SELECT sync_status, sync_error, last_synced_at FROM calendar_event_mappings WHERE user_id = ? AND job_id = ?",
    [user.id, id]
  );
  return c.json(mapping || { sync_status: null, sync_error: null, last_synced_at: null }, 200);
});

// Phase 9.2 — Cron Trigger entry point (see wrangler.toml's [triggers]
// block). No HTTP route exists for triggering a dispatch cycle (Section 24:
// scheduled delivery is system-owned; a manual-dispatch endpoint was
// explicitly forbidden) — this is the ONLY way `notification-dispatcher.ts`
// ever runs outside of a direct function-call test. `initDB(env)` is
// required here (unlike every `app.openapi()` handler above) because
// `@clawnify/app`'s own `initDB(c.env)` middleware only runs on the HTTP
// request pipeline — a `scheduled()` invocation never goes through it.
async function scheduled(_controller: ScheduledController, env: Env["Bindings"]): Promise<void> {
  initDB(env);
  await runCronCycle(env);
}

export default { fetch: app.fetch, scheduled };
