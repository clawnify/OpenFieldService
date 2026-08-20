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
import { BUSINESS_TIMEZONE_SETTING_KEY, isValidIanaTimezone } from "./business-timezone.js";
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
  getCustomerRebateProfile,
  getJobRebateAudit,
  listEligibilityCodes,
  recordEligibilityCheck,
  recordEligibilityFieldChange,
} from "./rebate.js";
import { CustomerValidationError, resolveReferralAttribution } from "./customers.js";
import { LeadWorkflowError, transitionLead } from "./lead-workflow.js";
import { LeadConversionError, convertLead } from "./lead-conversion.js";
import {
  enqueueAppointmentCancelled, enqueueAppointmentConfirmation, enqueueAppointmentRescheduled,
  enqueueInvoiceIssued, enqueueOnTheWay, enqueuePaymentReceived, enqueuePostJobSurvey,
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
  createManualInvoice,
  deleteDraftInvoice,
  generateInvoiceForJob,
  getInvoiceAudit,
  getInvoiceById,
  getInvoiceFinancials,
  issueInvoice,
  listPayments,
  recordPayment,
  setRebateAmount,
  voidInvoice,
  voidPayment,
  type PayerType,
  type PaymentMethod,
} from "./financial.js";

type GoogleBindings = {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REDIRECT_URI?: string;
  TOKEN_ENCRYPTION_KEY?: string;
};

type Env = { Bindings: { DB: D1Database } & GoogleBindings & StorageEnv & NotificationProviderBindings; Variables: { user: PublicUser } };

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

const PUBLIC_API_PATHS = new Set(["/api/auth/login", "/api/auth/logout"]);

app.use("/api/*", async (c, next) => {
  if (PUBLIC_API_PATHS.has(c.req.path)) {
    await next();
    return;
  }
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  c.set("user", user);
  await next();
});

function currentUser(c: Context<Env>): PublicUser {
  return c.get("user");
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

  const jobs = await get<{ count: number }>("SELECT COUNT(*) as count FROM jobs");
  const customers = await get<{ count: number }>("SELECT COUNT(*) as count FROM customers");
  const technicians = await get<{ count: number }>("SELECT COUNT(*) as count FROM technicians WHERE active = 1");
  const serviceTypes = await get<{ count: number }>("SELECT COUNT(*) as count FROM service_types");
  const today = new Date().toISOString().split("T")[0];
  const todayJobs = await get<{ count: number }>("SELECT COUNT(*) as count FROM jobs WHERE scheduled_date = ?", [today]);
  const upcomingJobs = await get<{ count: number }>(
    `SELECT COUNT(*) as count FROM jobs WHERE status IN (${PRE_WORK_STATUSES.map(() => "?").join(",")}) AND scheduled_date >= ?`,
    [...PRE_WORK_STATUSES, today]
  );
  const completedJobs = await get<{ count: number }>("SELECT COUNT(*) as count FROM jobs WHERE status = 'completed'");
  const revenue = await get<{ total: number }>("SELECT COALESCE(SUM(price), 0) as total FROM jobs WHERE status = 'completed'");
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
      "SELECT COUNT(*) as count FROM invoices WHERE status IN ('issued', 'partially_paid')"
    ))?.count || 0,
    invoices_overdue: (await get<{ count: number }>(
      "SELECT COUNT(*) as count FROM invoices WHERE status IN ('issued', 'partially_paid') AND due_date != '' AND due_date < ?", [today]
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

  let where = "WHERE 1=1";
  const params: unknown[] = [];

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
  const { rows, warningDaysConfigured } = await listEligibilityCodes();
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
     WHERE j.id = ?`,
    [id]
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

  try {
    validateScheduleFields(data);
  } catch (err) {
    if (err instanceof ScheduleValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
  if (data.technician_id !== undefined && data.technician_id !== null) {
    try {
      await assertTechnicianAssignable(data.technician_id);
    } catch (err) {
      if (err instanceof ScheduleValidationError) return c.json({ error: err.message }, 400);
      throw err;
    }
  }

  const identifier = await nextIdentifier();
  // Status is never client-supplied at creation — it's always the entry status
  // for the job's workflow (see src/server/workflow.ts), so a job can never be
  // created already sitting at, say, "completed" or "gov_portal_submitted".
  const jobType: JobType = data.job_type ?? "STANDARD";
  const initialStatus = entryStatus(jobType);

  // If address is empty, use customer address
  let address = data.address || "";
  if (!address) {
    const cust = await get<{ address: string; city: string; state: string; zip: string }>(
      "SELECT address, city, state, zip FROM customers WHERE id = ?", [data.customer_id]
    );
    if (cust) {
      address = [cust.address, cust.city, cust.state, cust.zip].filter(Boolean).join(", ");
    }
  }

  // Default price/duration from service type
  let duration = data.duration || 60;
  let price = data.price || 0;
  if (data.service_type_id && (!data.duration || !data.price)) {
    const st = await get<{ default_duration: number; default_price: number }>(
      "SELECT default_duration, default_price FROM service_types WHERE id = ?", [data.service_type_id]
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
    `INSERT INTO jobs (identifier, customer_id, technician_id, service_type_id, status, job_type, priority,
       scheduled_date, scheduled_time, duration, price, address, notes, is_recurring, recurrence_interval)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      identifier,
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
  const existing = await get<Job>("SELECT * FROM jobs WHERE id = ?", [id]);
  if (!existing) return c.json({ error: "Job not found" }, 404);

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
        await assertTechnicianAssignable(data.technician_id);
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

async function loadWorkflowJob(id: string | number) {
  return get<{ id: number; status: string; job_type: string; technician_id: number | null; eligibility_code: string; eligibility_code_expiry: string }>(
    "SELECT id, status, job_type, technician_id, eligibility_code, eligibility_code_expiry FROM jobs WHERE id = ?",
    [id]
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
  const job = await loadWorkflowJob(id);
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
  const job = await loadWorkflowJob(id);
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
  const actor: Actor = { id: me.id, role: me.role };
  const attemptingCompletion = body.to_status === "completed";
  // job_compliance_audit.job_id is a real FK (this D1 database enforces
  // foreign keys — verified, not assumed) — never record an event against an
  // id that might not exist. A cheap existence check up front avoids that
  // without duplicating transitionJob()'s own (more thorough) lookup.
  const jobExists = attemptingCompletion ? !!(await get<{ id: number }>("SELECT id FROM jobs WHERE id = ?", [id])) : false;

  // Compliance auditability (Phase 4): the completion gate itself lives in
  // workflow.ts's canCompleteJob(), called from inside transitionJob() below —
  // this route only records that an attempt happened and how it resolved, it
  // does not duplicate any validation. Recorded for "completed" specifically
  // since that's the only transition Phase 4 added requirements to.
  if (jobExists) await recordComplianceEvent(Number(id), "completion_attempted", me.id, {});

  try {
    await transitionJob(c.env.DB, Number(id), actor, {
      toStatus: body.to_status,
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
     WHERE j.id = ?`,
    [id]
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
  const job = await get<{ id: number }>("SELECT id FROM jobs WHERE id = ?", [id]);
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

async function loadComplianceJob(id: string | number) {
  return get<{ id: number; technician_id: number | null; status: string }>(
    "SELECT id, technician_id, status FROM jobs WHERE id = ?", [id]
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
  const job = await loadComplianceJob(id);
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
      "SELECT customer_id, identifier, technician_id FROM jobs WHERE id = ?", [id]
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
  const job = await loadComplianceJob(id);
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
  const job = await loadComplianceJob(idParam);
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
  const job = await loadComplianceJob(idParam);
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
  const job = await loadComplianceJob(idParam);
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
  const job = await loadComplianceJob(id);
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
  const job = await loadComplianceJob(id);
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
  const job = await loadComplianceJob(id);
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
  const job = await loadComplianceJob(id);
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
  const job = await loadComplianceJob(id);
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
  const job = await loadComplianceJob(id);
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
  if (me.role === "technician") {
    const techId = await actorTechnicianId({ id: me.id, role: me.role });
    const owns = techId !== null
      ? await get<{ id: number }>("SELECT id FROM jobs WHERE customer_id = ? AND technician_id = ? LIMIT 1", [id, techId])
      : null;
    if (!owns) return c.json({ error: "You are not permitted to view this customer" }, 403);
  }
  const profile = await getCustomerRebateProfile(Number(id));
  if (!profile) return c.json({ error: "Customer not found" }, 404);
  const result = await evaluateRebateEligibility(job_type, profile);
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
    "SELECT id, customer_id, job_type FROM jobs WHERE id = ?", [id]
  );
  if (!job) return c.json({ error: "Job not found" }, 404);
  if (!isJobType(job.job_type) || job.job_type === "STANDARD") {
    return c.json({ error: "Only CleanBC and BC Hydro jobs have rebate eligibility criteria" }, 400);
  }
  const profile = await getCustomerRebateProfile(job.customer_id);
  if (!profile) return c.json({ error: "Customer not found" }, 404);
  const result = await recordEligibilityCheck(Number(id), me.id, job.job_type, profile);
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
  const job = await loadComplianceJob(id);
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
    "SELECT id, job_type, eligibility_code, eligibility_code_expiry FROM jobs WHERE id = ?", [id]
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
  },
});

app.openapi(addJobNote, async (c) => {
  const { id } = c.req.valid("param");
  const { content } = c.req.valid("json");
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
  await run("DELETE FROM job_notes WHERE id = ?", [id]);
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

  const conditions: string[] = [];
  const params: unknown[] = [];
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
    `SELECT c.*, COALESCE(jc.cnt, 0) as job_count
     FROM customers c
     LEFT JOIN (SELECT customer_id, COUNT(*) as cnt FROM jobs GROUP BY customer_id) jc ON jc.customer_id = c.id
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
  if (me.role === "technician") {
    const techId = await actorTechnicianId({ id: me.id, role: me.role });
    if (techId === null) return c.json({ customers: [] }, 200);
    const customers = await query<Pick<Customer, "id" | "name" | "address">>(
      `SELECT id, name, address FROM customers
       WHERE id IN (SELECT customer_id FROM jobs WHERE technician_id = ?)
       ORDER BY name ASC`, [techId]
    );
    return c.json({ customers }, 200);
  }
  const customers = await query<Pick<Customer, "id" | "name" | "address">>("SELECT id, name, address FROM customers ORDER BY name ASC");
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
    `SELECT c.*, rb.name as referred_by_customer_name
     FROM customers c
     LEFT JOIN customers rb ON c.referred_by_customer_id = rb.id
     WHERE c.id = ?`, [id]
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
    referral = await resolveReferralAttribution(data, null, null);
  } catch (err) {
    if (err instanceof CustomerValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
  await run(
    `INSERT INTO customers (name, email, phone, address, city, state, zip, notes,
       referral_source, referral_name, referred_by_customer_id,
       house_size, primary_heating_source, number_of_adults, number_of_children, household_income)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.name, data.email || "", data.phone || "", data.address || "",
      data.city || "", data.state || "", data.zip || "", data.notes || "",
      referral.referral_source, referral.referral_name, referral.referred_by_customer_id,
      data.house_size ?? null, data.primary_heating_source || "",
      data.number_of_adults ?? null, data.number_of_children ?? null, data.household_income ?? null,
    ]
  );
  const customer = await get<Customer>("SELECT * FROM customers ORDER BY id DESC LIMIT 1");
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

  const fields: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined && !REFERRAL_FIELDS.has(k)) {
      fields.push(`${k} = ?`);
      vals.push(v);
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
      const referral = await resolveReferralAttribution(data, existing, Number(id));
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
  await run("DELETE FROM customers WHERE id = ?", [id]);
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
  const customer = await get<{ id: number }>("SELECT id FROM customers WHERE id = ?", [id]);
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
  const customer = await get<{ id: number }>("SELECT id FROM customers WHERE id = ?", [id]);
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
  const customer = await get<{ id: number }>("SELECT id FROM customers WHERE id = ?", [id]);
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
async function validateLeadAssigneeUserId(userId: number): Promise<string | null> {
  const user = await get<{ id: number; role: string }>("SELECT id, role FROM users WHERE id = ?", [userId]);
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

  const conditions: string[] = [];
  const params: unknown[] = [];
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
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

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
  const lead = await get<Lead>(`${LEAD_SELECT} WHERE l.id = ?`, [id]);
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
  const lead = await get<{ id: number }>("SELECT id FROM leads WHERE id = ?", [id]);
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
    const err = await validateLeadAssigneeUserId(data.assigned_user_id);
    if (err) return c.json({ error: err }, 400);
  }

  let referral;
  try {
    // A brand-new Lead has no id yet — same reasoning as createCustomer.
    referral = await resolveReferralAttribution(data, null, null);
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
    `INSERT INTO leads (identifier, name, phone, email, address, city, state, zip, status,
       assigned_user_id, referral_source, referral_name, referred_by_customer_id,
       program_interest, estimated_value_cents, estimate_notes, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      identifier, data.name, data.phone || "", data.email || "", data.address || "",
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
    "SELECT referral_source, referral_name, referred_by_customer_id FROM leads WHERE id = ?", [id]
  );
  if (!existing) return c.json({ error: "Lead not found" }, 404);

  if (data.name !== undefined && !data.name.trim()) return c.json({ error: "Name is required" }, 400);

  if (data.assigned_user_id !== undefined && data.assigned_user_id !== null) {
    const err = await validateLeadAssigneeUserId(data.assigned_user_id);
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
      const referral = await resolveReferralAttribution(data, existing, null);
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
    outcome = await convertLead(c.env.DB, Number(id), { actorUserId: me.id });
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
    `SELECT c.*, rb.name as referred_by_customer_name
     FROM customers c LEFT JOIN customers rb ON c.referred_by_customer_id = rb.id
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
  const lead = await get<{ id: number }>("SELECT id FROM leads WHERE id = ?", [id]);
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
  const lead = await get<{ id: number }>("SELECT id FROM leads WHERE id = ?", [id]);
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
  const lead = await get<{ id: number }>("SELECT id FROM leads WHERE id = ?", [id]);
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
async function validateTechnicianUserId(userId: number | null, excludeTechnicianId?: number): Promise<string | null> {
  if (userId === null) return null;
  const user = await get<{ id: number; role: string }>("SELECT id, role FROM users WHERE id = ?", [userId]);
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
     ORDER BY t.name ASC`,
    ACTIVE_STATUSES
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
    "SELECT id, name, color FROM technicians WHERE active = 1 ORDER BY name ASC"
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
  const userIdError = await validateTechnicianUserId(data.user_id ?? null);
  if (userIdError) return c.json({ error: userIdError }, 400);
  await run(
    "INSERT INTO technicians (name, email, phone, color, user_id) VALUES (?, ?, ?, ?, ?)",
    [data.name, data.email || "", data.phone || "", data.color || "#16a34a", data.user_id ?? null]
  );
  const tech = await get<Technician>("SELECT * FROM technicians ORDER BY id DESC LIMIT 1");
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
  if (data.user_id !== undefined) {
    const userIdError = await validateTechnicianUserId(data.user_id, Number(id));
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
  await run("DELETE FROM technicians WHERE id = ?", [id]);
  return c.json({ ok: true }, 200);
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
  const types = await query<ServiceType>("SELECT * FROM service_types ORDER BY name ASC");
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
  await run(
    "INSERT INTO service_types (name, description, default_duration, default_price, color) VALUES (?, ?, ?, ?, ?)",
    [data.name, data.description || "", data.default_duration || 60, data.default_price || 0, data.color || "#6b7280"]
  );
  const st = await get<ServiceType>("SELECT * FROM service_types ORDER BY id DESC LIMIT 1");
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
  await run("DELETE FROM service_types WHERE id = ?", [id]);
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
  let where = "WHERE j.scheduled_date >= ? AND j.scheduled_date <= ?";
  const params: unknown[] = [q.start, q.end];
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
  },
});

app.openapi(addChecklistItem, async (c) => {
  const { id } = c.req.valid("param");
  const { label } = c.req.valid("json");
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
  await run("UPDATE job_checklist SET checked = CASE WHEN checked = 0 THEN 1 ELSE 0 END WHERE id = ?", [id]);
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
  await run("DELETE FROM job_checklist WHERE id = ?", [id]);
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
  const materials = await query<Material>("SELECT * FROM materials ORDER BY name ASC");
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
  await run("INSERT INTO materials (name, unit, unit_cost, in_stock) VALUES (?, ?, ?, ?)",
    [data.name, data.unit || "ea", data.unit_cost || 0, data.in_stock || 0]);
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
  await run("DELETE FROM materials WHERE id = ?", [id]);
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
  },
});

app.openapi(addJobMaterial, async (c) => {
  const { id } = c.req.valid("param");
  const data = c.req.valid("json");
  let cost = data.unit_cost;
  if (cost === undefined) {
    const mat = await get<{ unit_cost: number }>("SELECT unit_cost FROM materials WHERE id = ?", [data.material_id]);
    cost = mat?.unit_cost || 0;
  }
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
  await run("DELETE FROM job_materials WHERE id = ?", [id]);
  return c.json({ ok: true }, 200);
});

// ── Invoices & Financials (Phase 5) ──────────────────────────────────
// Full RBAC blackout for technicians on every route in this section — see
// canManageFinancials() in financial.ts. Money is always integer cents; see
// migrations/0007_financial_invoicing.sql and financial.ts's module doc for
// why, and for what's stored vs. always computed on read.

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

  let where = "WHERE 1=1";
  const params: unknown[] = [];
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
     WHERE i.id = ?`, [id]
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
  },
});

app.openapi(createInvoice, async (c) => {
  const me = currentUser(c);
  if (!canManageFinancials({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);

  const data = c.req.valid("json");
  try {
    const invoice = await createManualInvoice(c.env.DB, {
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
  if (!invoice) return c.json({ error: "Invoice not found" }, 404);

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
  try {
    const invoice = await issueInvoice(Number(c.req.valid("param").id), me.id);
    // Phase 9.1 — invoice.id alone is a safe discriminator: issueInvoice()
    // itself rejects issuing anything but a draft, so an invoice can only
    // ever move to "issued" once. Best-effort, never affects the financial
    // response below regardless of outcome.
    await safeEnqueue(async () => {
      const contact = await getCustomerContact(invoice.customer_id);
      if (!contact) return;
      await enqueueInvoiceIssued({
        invoiceId: invoice.id, invoiceIdentifier: invoice.identifier,
        customerId: invoice.customer_id, customerName: contact.name, customerEmail: contact.email, customerPhone: contact.phone,
        totalCents: invoice.total_cents,
      });
    });
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
  try {
    const invoice = await voidInvoice(Number(c.req.valid("param").id), me.id, c.req.valid("json").reason);
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
  try {
    const invoice = await setRebateAmount(Number(c.req.valid("param").id), me.id, c.req.valid("json").rebate_amount_cents);
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
  },
});

app.openapi(getInvoiceAuditRoute, async (c) => {
  const me = currentUser(c);
  if (!canManageFinancials({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);
  const audit = await getInvoiceAudit(Number(c.req.valid("param").id));
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
  const invoice = await get<{ id: number }>("SELECT id FROM invoices WHERE id = ?", [id]);
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
  },
});

app.openapi(listPaymentsRoute, async (c) => {
  const me = currentUser(c);
  if (!canManageFinancials({ id: me.id, role: me.role })) return c.json({ error: "Forbidden" }, 403);
  const payments = await listPayments(Number(c.req.valid("param").id));
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
  const data = c.req.valid("json");
  try {
    const invoice = await recordPayment(c.env.DB, Number(id), {
      amountCents: data.amount_cents,
      payerType: data.payer_type as PayerType,
      method: data.method as PaymentMethod,
      reference: data.reference ?? "",
      notes: data.notes ?? "",
      paidAt: data.paid_at ?? new Date().toISOString(),
    }, me.id);
    // Phase 9.1 — a payment's own id (not the invoice's) is the
    // discriminator, since multiple payments can exist per invoice.
    // recordPayment() returns the invoice, not the new payment row, so the
    // payment id is read back the same way job_schedule_history/
    // job_status_history row ids are — a read-only lookup, not a change to
    // financial.ts.
    await safeEnqueue(async () => {
      const contact = await getCustomerContact(invoice.customer_id);
      const paymentId = await latestPaymentId(invoice.id);
      if (!contact || paymentId === null) return;
      await enqueuePaymentReceived({
        invoiceId: invoice.id, invoiceIdentifier: invoice.identifier,
        customerId: invoice.customer_id, customerName: contact.name, customerEmail: contact.email, customerPhone: contact.phone,
        paymentId, amountCents: data.amount_cents,
      });
    });
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
  try {
    await voidPayment(c.env.DB, Number(c.req.valid("param").id), me.id, c.req.valid("json").reason);
  } catch (err) {
    if (err instanceof FinancialError) {
      if (err.code === "not_found") return c.json({ error: err.message }, 404);
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
  return c.json({ ok: true }, 200);
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
  let where = "WHERE 1=1";
  const params: unknown[] = [];
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
    "SELECT id, name, role FROM users WHERE role IN ('admin', 'dispatcher') ORDER BY name ASC"
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
    "INSERT INTO users (name, email, password_hash, role, active) VALUES (?, ?, ?, ?, ?)",
    [data.name.trim(), email, passwordHash, data.role || "dispatcher", data.active ?? 1]
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
  const user = await get<PublicUser>(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`, [id]);
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
  const target = await get<{ id: number; role: string; active: number }>(
    "SELECT id, role, active FROM users WHERE id = ?", [id]
  );
  if (!target) return c.json({ error: "User not found" }, 404);

  if (data.active === 0) {
    if (Number(id) === me.id) return c.json({ error: "You cannot deactivate your own account" }, 400);
    if (target.role === "admin") {
      const otherActiveAdmins = await get<{ count: number }>(
        "SELECT COUNT(*) as count FROM users WHERE role = 'admin' AND active = 1 AND id != ?", [id]
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
  const target = await get("SELECT id FROM users WHERE id = ?", [id]);
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

  const target = await get<{ id: number; role: string }>("SELECT id, role FROM users WHERE id = ?", [id]);
  if (!target) return c.json({ error: "User not found" }, 404);
  if (target.role === "admin") {
    const otherActiveAdmins = await get<{ count: number }>(
      "SELECT COUNT(*) as count FROM users WHERE role = 'admin' AND active = 1 AND id != ?", [id]
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
// version-history mechanics. Reads are open to any authenticated user (workflow/
// eligibility logic and dispatcher UI both need to resolve current values);
// writes are admin-only, same gate as /api/users.

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
  },
});

app.openapi(listSettings, async (c) => {
  const { category } = c.req.valid("query");
  const settings = await listCurrentSettings(category);
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
  const history = await getSettingHistory(key);
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
  const retired = await retireSetting(key, me.id);
  if (!retired) return c.json({ error: "No active version for this key" }, 404);
  return c.json({ ok: true }, 200);
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
  },
});

app.openapi(retryJobSync, async (c) => {
  const user = currentUser(c);
  const { id } = c.req.valid("param");
  const integration = await get("SELECT id FROM calendar_integrations WHERE user_id = ?", [user.id]);
  if (!integration) return c.json({ error: "Google Calendar is not connected" }, 400);

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
