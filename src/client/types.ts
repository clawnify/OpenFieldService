export type View = "dashboard" | "schedule" | "jobs" | "customers" | "leads" | "technicians" | "services" | "invoices" | "materials" | "users" | "integrations" | "settings" | "eligibility";

export type Role = "admin" | "dispatcher" | "technician";

export interface User {
  id: number;
  name: string;
  email: string;
  role: Role;
  active: number;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

export type JobType = "STANDARD" | "CLEANBC" | "BC_HYDRO";

export type JobStatus =
  | "scheduled" | "in_progress" | "completed" | "invoiced"
  | "free_estimate" | "application_pending" | "eligibility_approved" | "install_scheduled" | "gov_portal_submitted"
  | "cancelled";

export type Priority = "low" | "normal" | "high" | "urgent";
// "paid"/"partially_paid" are server-computed from actual payments, never
// directly settable — see src/server/financial.ts. "overdue" is not a
// stored status at all (a computed display flag, invoice.is_overdue below).
export type InvoiceStatus = "draft" | "issued" | "partially_paid" | "paid" | "void";
export type PayerType = "customer" | "government" | "third_party";
export type PaymentMethod = "cash" | "check" | "credit_card" | "debit_card" | "e_transfer" | "financing" | "other";

export interface CompletionRequirement {
  key: string;
  label: string;
  satisfied: boolean;
}

export interface CompletionCheck {
  allowed: boolean;
  requirements: CompletionRequirement[];
}

export type MediaKind = "pre_work_photo" | "post_work_photo";

export interface JobMedia {
  id: number;
  job_id: number;
  kind: MediaKind;
  content_type: string;
  size_bytes: number;
  uploaded_by: number | null;
  created_at: string;
}

export type ReportStatus = "draft" | "submitted";

export interface JobCompletionReport {
  job_id: number;
  work_performed: string;
  findings: string;
  notes: string;
  materials_used: string;
  status: ReportStatus;
  submitted_by: number | null;
  submitted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface JobSignature {
  id: number;
  job_id: number;
  signer_name: string;
  signer_relationship: string;
  captured_by: number | null;
  captured_at: string;
}

export interface ComplianceAuditRow {
  id: number;
  job_id: number;
  event_type: string;
  actor_user_id: number | null;
  details: string;
  created_at: string;
}

export interface Job {
  id: number;
  identifier: string;
  customer_id: number;
  technician_id: number | null;
  service_type_id: number | null;
  status: JobStatus;
  job_type: JobType;
  eligibility_code: string;
  eligibility_code_expiry: string;
  priority: Priority;
  scheduled_date: string;
  scheduled_time: string;
  duration: number;
  price: number;
  address: string;
  notes: string;
  completion_notes: string;
  is_recurring: number;
  recurrence_interval: string;
  next_recurrence_date: string;
  customer_name?: string;
  customer_phone?: string;
  technician_name?: string | null;
  technician_color?: string | null;
  service_type_name?: string | null;
  service_type_color?: string | null;
  job_notes?: JobNote[];
  checklist?: ChecklistItem[];
  job_materials?: JobMaterial[];
  // Phase 10.2 — additive; only present because JobSchema (server) now
  // includes them. Only the Dispatcher Map view reads these; every other
  // Job consumer in the app is unaffected by their presence.
  latitude?: number | null;
  longitude?: number | null;
  geocode_status?: string;
  created_at: string;
  updated_at: string;
}

export interface Customer {
  id: number;
  name: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  notes: string;
  referral_source: string;
  // Meaningful only when referral_source === "Referral" — see
  // src/server/customers.ts for the validation that enforces this.
  referral_name: string;
  // Meaningful only when referral_source === "Existing Customer" — a real
  // FK to another customers.id, not a free-text name.
  referred_by_customer_id: number | null;
  // Server-joined display name for referred_by_customer_id — present on
  // GET /api/customers/{id}, absent/undefined elsewhere (list views never
  // need it).
  referred_by_customer_name?: string | null;
  house_size: number | null;
  primary_heating_source: string;
  number_of_adults: number | null;
  number_of_children: number | null;
  household_income: number | null;
  job_count?: number;
  created_at: string;
  updated_at: string;
}

export interface RebateCriterion {
  key: string;
  label: string;
  satisfied: boolean | null;
  detail: string;
}

export interface RebateEligibilityResult {
  job_type: JobType;
  allowed: boolean | null;
  criteria: RebateCriterion[];
  thresholds_used: Record<string, number | null>;
}

export interface RebateAuditRow {
  id: number;
  job_id: number;
  event_type: "eligibility_check" | "code_updated" | "expiry_updated";
  actor_user_id: number | null;
  details: string;
  created_at: string;
}

export type EligibilityCodeStatus = "active" | "expiring_soon" | "expired" | "submitted";

export interface EligibilityCodeRow {
  id: number;
  identifier: string;
  status: string;
  eligibility_code: string;
  eligibility_code_expiry: string;
  customer_name: string | null;
  technician_name: string | null;
  code_status: EligibilityCodeStatus;
  days_remaining: number | null;
}

export interface Technician {
  id: number;
  name: string;
  email: string;
  phone: string;
  color: string;
  active: number;
  user_id: number | null;
  user_email?: string | null;
  job_count?: number;
  created_at: string;
}

export interface ServiceType {
  id: number;
  name: string;
  description: string;
  default_duration: number;
  default_price: number;
  color: string;
  created_at: string;
}

export interface JobNote {
  id: number;
  job_id: number;
  content: string;
  created_at: string;
}

export interface ChecklistItem {
  id: number;
  job_id: number;
  label: string;
  checked: number;
  sort_order: number;
}

export interface Material {
  id: number;
  name: string;
  unit: string;
  unit_cost: number;
  in_stock: number;
  created_at: string;
}

export interface JobMaterial {
  id: number;
  job_id: number;
  material_id: number;
  material_name?: string;
  material_unit?: string;
  quantity: number;
  unit_cost: number;
}

export interface Invoice {
  id: number;
  identifier: string;
  customer_id: number;
  job_id: number | null;
  status: InvoiceStatus;
  subtotal_cents: number;
  tax_rate: number;
  tax_amount_cents: number;
  rebate_amount_cents: number;
  total_cents: number;
  // Always server-computed (never independently editable) — see
  // src/server/financial.ts's module doc for why these are never stored.
  customer_amount_cents: number;
  amount_paid_cents: number;
  balance_cents: number;
  is_overdue: boolean;
  notes: string;
  due_date: string;
  issued_at: string | null;
  voided_at: string | null;
  void_reason: string;
  customer_name?: string;
  job_identifier?: string;
  lines?: InvoiceLine[];
  payments?: Payment[];
  created_at: string;
  updated_at: string;
}

export interface InvoiceLine {
  id: number;
  invoice_id: number;
  description: string;
  quantity: number;
  unit_price_cents: number;
  total_cents: number;
}

export interface Payment {
  id: number;
  invoice_id: number;
  amount_cents: number;
  payer_type: PayerType;
  method: PaymentMethod;
  reference: string;
  notes: string;
  paid_at: string;
  recorded_by: number | null;
  voided_at: string | null;
  void_reason: string;
  created_at: string;
}

export interface InvoiceAuditRow {
  id: number;
  invoice_id: number;
  event_type: string;
  actor_user_id: number | null;
  details: string;
  created_at: string;
}

export interface Stats {
  jobs: number;
  customers: number;
  technicians: number;
  service_types: number;
  today_jobs: number;
  upcoming_jobs: number;
  completed_jobs: number;
  revenue: number;
  invoices_outstanding: number;
  invoices_overdue: number;
}

export interface PaginatedState {
  page: number;
  limit: number;
  total: number;
}

export interface GoogleCalendarStatus {
  connected: boolean;
  account_email?: string;
  calendar_id?: string;
  calendar_summary?: string;
  sync_enabled?: boolean;
  status?: string;
  connected_at?: string | null;
}

export interface GoogleCalendarEntry {
  id: string;
  summary: string;
  primary?: boolean;
}

export interface GoogleSyncResult {
  created: number;
  updated: number;
  deleted: number;
  failed: number;
}

export interface JobSyncStatus {
  sync_status: string | null;
  sync_error: string | null;
  last_synced_at: string | null;
}

export type SettingDataType = "string" | "number" | "boolean" | "json";

export interface GlobalSetting {
  id: number;
  key: string;
  value: string;
  data_type: SettingDataType;
  category: string;
  description: string;
  effective_from: string;
  effective_until: string | null;
  active: number;
  updated_by: number | null;
  created_at: string;
  updated_at: string;
}

// Phase 8.4 — Lead Management UI, backed by the Phase 8.2 API + Phase 8.3
// conversion endpoint. Field-for-field against the actual server response
// (src/server/index.ts's LeadSchema) — a single `name` field, no
// first/last/company split (see mem:backlog/p1-lead-management-pipeline for
// why that's correct and not an oversight).
export interface Lead {
  id: number;
  identifier: string;
  name: string;
  phone: string;
  email: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  status: string;
  assigned_user_id: number | null;
  assigned_user_name?: string | null;
  referral_source: string;
  referral_name: string;
  referred_by_customer_id: number | null;
  referred_by_customer_name?: string | null;
  program_interest: string | null;
  estimated_value_cents: number | null;
  estimate_notes: string;
  lost_reason: string;
  lost_reason_note: string;
  converted_customer_id: number | null;
  converted_at: string | null;
  converted_by: number | null;
  notes: string;
  created_at: string;
  updated_at: string;
}

export interface LeadStatusHistoryRow {
  id: number;
  lead_id: number;
  old_status: string | null;
  new_status: string;
  actor_user_id: number | null;
  reason: string;
  created_at: string;
}

export interface CustomerLookup {
  id: number;
  name: string;
  address: string;
}

export interface TechnicianLookup {
  id: number;
  name: string;
  color: string;
}
