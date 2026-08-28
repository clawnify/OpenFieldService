export type View = "dashboard" | "schedule" | "jobs" | "customers" | "leads" | "quotes" | "contracts" | "technicians" | "services" | "invoices" | "materials" | "users" | "integrations" | "settings" | "eligibility" | "phone-operations" | "pricebook" | "maintenance-plans" | "legal-terms" | "checklist-templates" | "maintenance-agreements";

// ── Phase 19B — Maintenance Plans / Memberships / Agreements ───────────

export interface MaintenancePlan {
  id: number;
  code: string;
  name: string;
  description: string;
  tier: string;
  active: number;
  price_cents: number;
  currency: string;
  taxable: number;
  visit_entitlement_count: number | null;
  frequency_description: string;
  priority_benefit: string;
  discount_type: string;
  discount_percent: number | null;
  discount_fixed_cents: number | null;
  included_services: string;
  excluded_services: string;
  other_benefits: string;
  equipment_eligibility: string;
  effective_from: string | null;
  effective_until: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface LegalTermsDocument {
  id: number;
  type: string;
  title: string;
  current_published_version_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface LegalTermsVersion {
  id: number;
  document_id: number;
  version_number: number;
  status: string;
  content: string;
  content_hash: string | null;
  effective_from: string | null;
  published_at: string | null;
  superseded_at: string | null;
  created_at: string;
}

export interface MaintenanceAgreement {
  id: number;
  identifier: string;
  customer_id: number;
  plan_id: number;
  status: string;
  current_version_id: number | null;
  supersedes_agreement_id: number | null;
  superseded_by_agreement_id: number | null;
  cancel_reason: string;
  created_at: string;
  updated_at: string;
  customer_name?: string | null;
  plan_name?: string | null;
}

export interface MaintenanceAgreementVersion {
  id: number;
  agreement_id: number;
  version_number: number;
  plan_snapshot: string;
  customer_snapshot: string;
  company_snapshot: string;
  terms_version_id: number | null;
  terms_snapshot_hash: string | null;
  effective_date: string | null;
  expires_at: string | null;
  renewal_preference: string;
  auto_renew_consent: string;
  tax_breakdown: string;
  total_price_cents: number;
  signed_document_hash: string | null;
  signed_at: string | null;
  created_at: string;
}

export interface CoveredEquipment {
  id: number;
  agreement_version_id: number;
  asset_id: number | null;
  asset_snapshot: string;
}

export interface AgreementSigner {
  id: number;
  agreement_id: number;
  name: string;
  email: string;
  phone: string;
  role: string;
  sort_order: number;
}

export interface AgreementSignatureRequest {
  id: number;
  agreement_id: number;
  signer_id: number;
  status: string;
  expires_at: string;
  consent_at: string | null;
  signed_at: string | null;
  signature_method: string | null;
}

export interface MaintenanceMembership {
  id: number;
  agreement_id: number;
  customer_id: number;
  plan_id: number;
  status: string;
  effective_start: string | null;
  effective_end: string | null;
  visits_included: number | null;
  cancelled_at: string | null;
  cancel_reason: string;
}

export interface ChecklistTemplate {
  id: number;
  name: string;
  applicability: string;
  active: number;
  current_version_id: number | null;
}

export interface ChecklistItem19B {
  id: string;
  label: string;
  input_type: "PASS_FAIL" | "YES_NO" | "TEXT" | "NUMBER" | "MEASUREMENT" | "SELECT" | "PHOTO_REQUIRED";
  required: boolean;
  options?: string[];
}

export interface ChecklistSection19B {
  title: string;
  items: ChecklistItem19B[];
}

export interface ChecklistTemplateVersion {
  id: number;
  template_id: number;
  version_number: number;
  sections: string;
}

export interface MaintenanceServiceReport {
  id: number;
  job_id: number;
  agreement_id: number | null;
  membership_id: number | null;
  asset_id: number | null;
  checklist_template_version_id: number | null;
  checklist_snapshot: string;
  checklist_results: string;
  measurements: string;
  work_performed: string;
  findings: string;
  recommendations: string;
  notes: string;
  internal_notes: string;
  customer_acknowledgement: string;
  status: string;
  finalized_at: string | null;
  document_hash: string | null;
}

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
export type PaymentMethod = "cash" | "check" | "credit_card" | "debit_card" | "e_transfer" | "bank_transfer" | "financing" | "other";
export type PaymentSource = "manual" | "online_provider";

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

// Phase 11.4 — Assets / Equipment. Core term "Asset"; UI may label it
// "Equipment" for HVAC users. `asset_type` is one of the keys returned by
// GET /api/assets/types (see AssetType below), never hardcoded here.
export interface Asset {
  id: number;
  customer_id: number;
  asset_type: string;
  display_name: string;
  manufacturer: string;
  model: string;
  serial_number: string;
  installation_date: string | null;
  status: "active" | "inactive" | "retired";
  notes: string;
  created_at: string;
  updated_at: string;
}

export interface AssetType {
  key: string;
  label: string;
}

// Phase 12 — Quotes / Estimates. Domain/API term "Quote"; UI may say
// "Quote / Estimate". A Quote is a durable identity; its commercial content
// (line items, totals) lives in an immutable, versioned QuoteVersion — see
// src/server/quotes.ts and migrations/0017_quotes.sql for the full model.
export type QuoteStatus = "draft" | "sent" | "accepted" | "rejected" | "expired" | "cancelled";
export type DiscountType = "none" | "fixed" | "percent";
export type LineItemCategory = "service" | "labor" | "material" | "equipment" | "other";

export interface Quote {
  id: number;
  identifier: string;
  customer_id: number;
  lead_id: number | null;
  status: QuoteStatus;
  current_version_id: number | null;
  accepted_by: number | null;
  accepted_at: string | null;
  accepted_version_id: number | null;
  accepted_option_id: number | null;
  rejected_reason: string;
  created_by: number | null;
  created_at: string;
  updated_at: string;
  customer_name: string | null;
  lead_identifier: string | null;
}

export interface QuoteLineItem {
  id: number;
  quote_version_id: number;
  description: string;
  category: LineItemCategory;
  quantity: number;
  unit: string;
  unit_price_cents: number;
  total_cents: number;
  sort_order: number;
  asset_id: number | null;
  taxable: number;
  pricebook_item_id: number | null;
}

export interface QuoteVersion {
  id: number;
  quote_id: number;
  version_number: number;
  subtotal_cents: number;
  discount_type: DiscountType;
  discount_percent: number;
  discount_cents: number;
  tax_rate: number;
  tax_amount_cents: number;
  total_cents: number;
  notes: string;
  expires_at: string | null;
  created_by: number | null;
  created_at: string;
}

// Phase 13D — the persisted per-component breakdown for one document
// (a Quote Version or an Invoice). null when the document predates Phase
// 13D and has no snapshot — the flat tax_rate/tax_amount_cents fields
// remain the only tax information ever actually recorded for it.
export interface TaxSnapshotComponent { code: string; name: string; rate_percent: number; amount_cents: number }
export interface TaxSnapshot {
  tax_enabled: boolean;
  country_code: string;
  region_code: string;
  currency: string;
  prices_include_tax: boolean;
  taxable_base_cents: number;
  total_tax_cents: number;
  business_number: string;
  tax_number: string;
  legacy: boolean;
  components: TaxSnapshotComponent[];
}

export interface QuoteVersionDetail extends QuoteVersion {
  line_items: QuoteLineItem[];
  tax_snapshot: TaxSnapshot | null;
}

export interface QuoteStatusHistoryRow {
  id: number;
  quote_id: number;
  old_status: string | null;
  new_status: string;
  actor_user_id: number | null;
  reason: string;
  created_at: string;
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
  tax_snapshot: TaxSnapshot | null;
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
  taxable: number;
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
  source: PaymentSource;
  received_by: string;
  payment_session_id: number | null;
}

// Phase 13B — the same shape as ContractDeliveryStatus (see below); one
// generic aggregate shape reused for both Invoice-send and Receipt-email
// delivery status.
export interface DeliveryStatus {
  total: number;
  sent: number;
  failed: number;
  pending: number;
  cancelled: number;
  last_sent_at: string | null;
  last_error: string | null;
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

// Phase 13A hardening — Company Profile: tenant business identity used by
// the Contract PDF header/footer (contract-pdf.ts). Admin-only read/write
// (server/index.ts's /api/company-profile routes) — see
// src/server/company-profile.ts for the full persistence-model rationale.
export interface CompanyProfile {
  organization_id: number;
  company_name: string;
  legal_name: string;
  phone: string;
  email: string;
  website: string;
  address_line1: string;
  address_line2: string;
  city: string;
  state: string;
  postal_code: string;
  country: string;
  business_number: string;
  tax_number: string;
  contract_footer: string;
  logo_key: string | null;
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

// Phase 13 — Contracts / E-Sign. A Contract is a durable identity bound to
// the EXACT accepted Quote commercial version (never the Quote's current/
// latest state); its legal/commercial content lives in an immutable,
// versioned ContractVersion — see src/server/contracts.ts and
// migrations/0018_contracts.sql for the full model.
export type ContractStatus = "draft" | "sent" | "partially_signed" | "signed" | "declined" | "expired" | "cancelled" | "voided";
export type SignerRole = "customer" | "co_owner" | "company_rep" | "guarantor" | "other";
export type SignatureMethod = "typed" | "click_to_sign";

export interface Contract {
  id: number;
  identifier: string;
  customer_id: number;
  quote_id: number;
  accepted_quote_version_id: number;
  status: ContractStatus;
  current_version_id: number | null;
  voided_at: string | null;
  void_reason: string;
  created_by: number | null;
  created_at: string;
  updated_at: string;
  customer_name: string | null;
  quote_identifier: string | null;
}

export interface ContractVersion {
  id: number;
  contract_id: number;
  version_number: number;
  title: string;
  body: string;
  template_version_id: number | null;
  commercial_snapshot: string;
  customer_snapshot: string;
  company_snapshot: string;
  effective_date: string | null;
  expires_at: string | null;
  document_hash: string | null;
  hash_algorithm: string;
  signed_document_hash: string | null;
  signed_at: string | null;
  created_by: number | null;
  created_at: string;
}

export interface ContractSigner {
  id: number;
  contract_id: number;
  name: string;
  email: string;
  phone: string;
  role: SignerRole;
  sort_order: number;
  created_at: string;
}

export interface SignatureRequest {
  id: number;
  contract_id: number;
  contract_version_id: number;
  signer_id: number;
  status: string;
  provider: string;
  provider_request_id: string | null;
  expires_at: string;
  consent_text_version: string;
  consent_at: string | null;
  signed_at: string | null;
  signature_method: string | null;
  signer_ip: string | null;
  signer_user_agent: string | null;
  declined_reason: string;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

export interface SignatureEvent {
  id: number;
  signature_request_id: number;
  event_type: string;
  actor_user_id: number | null;
  ip_address: string | null;
  user_agent: string | null;
  metadata: string;
  created_at: string;
}

export interface ContractStatusHistoryRow {
  id: number;
  contract_id: number;
  old_status: string | null;
  new_status: string;
  actor_user_id: number | null;
  reason: string;
  created_at: string;
}

export interface ContractTemplate {
  id: number;
  name: string;
  active: number;
  current_version_id: number | null;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

export interface ContractTemplateVersion {
  id: number;
  template_id: number;
  version_number: number;
  title: string;
  body: string;
  created_by: number | null;
  created_at: string;
}

// Phase 13A final document hardening — aggregate customer signed-copy
// delivery status across every signer's notification (Section 37).
export interface ContractDeliveryStatus {
  total: number;
  sent: number;
  failed: number;
  pending: number;
  cancelled: number;
  last_sent_at: string | null;
  last_error: string | null;
}

export interface EvidencePackage {
  contract_identifier: string;
  version_number: number;
  document_hash: string | null;
  signed_document_hash: string | null;
  requests: (SignatureRequest & { signer?: ContractSigner; events: SignatureEvent[] })[];
}

// Phase 17 — Pricebook. `PricebookItem` is the full (cost-included) shape an
// admin sees; a dispatcher's response body is missing cost_cents/
// internal_notes/preferred_vendor/vendor_sku entirely (server-side
// stripping, not client-side hiding — see src/server/pricebook.ts's
// `stripCost`), hence those four fields are optional here rather than a
// separate public-view type: the client only ever renders what's present.
export type PricebookItemType = "EQUIPMENT" | "PART" | "MATERIAL" | "SERVICE" | "LABOR" | "OTHER";
export const PRICEBOOK_ITEM_TYPES: PricebookItemType[] = ["EQUIPMENT", "PART", "MATERIAL", "SERVICE", "LABOR", "OTHER"];
export type PricebookItemStatus = "active" | "inactive";

export interface PricebookCategory {
  id: number;
  organization_id: number;
  name: string;
  description: string;
  active: boolean;
  sort_order: number;
  parent_category_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface PricebookItem {
  id: number;
  organization_id: number;
  type: PricebookItemType;
  name: string;
  description: string;
  internal_notes?: string;
  sku: string;
  category_id: number | null;
  manufacturer: string;
  model: string;
  unit: string;
  default_quantity: number;
  cost_cents?: number;
  sell_price_cents: number;
  taxable: boolean;
  status: PricebookItemStatus;
  preferred_vendor?: string;
  vendor_sku?: string;
  equipment_metadata: string;
  warranty_metadata: string;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

export interface PricebookItemAuditEntry {
  id: number;
  event_type: string;
  actor_user_id: number | null;
  details: string;
  created_at: string;
}

// Phase 18 — Good / Better / Best Estimate Options.
export const OPTION_TIERS = ["GOOD", "BETTER", "BEST", "CUSTOM"] as const;
export type OptionTier = typeof OPTION_TIERS[number];

export interface QuoteOptionLineItem {
  id: number;
  quote_option_id: number;
  description: string;
  category: string;
  quantity: number;
  unit: string;
  unit_price_cents: number;
  cost_cents?: number | null;
  total_cents: number;
  sort_order: number;
  asset_id: number | null;
  taxable: number;
  pricebook_item_id: number | null;
}

export interface QuoteOptionCostSummary {
  totalCostCents: number;
  totalSellCents: number;
  grossProfitCents: number;
  grossMarginPercent: number;
  markupPercent: number;
}

export interface QuoteOption {
  id: number;
  quote_version_id: number;
  tier: OptionTier;
  name: string;
  headline: string;
  description: string;
  internal_notes?: string;
  sort_order: number;
  recommended: boolean;
  discount_type: string;
  discount_percent: number;
  discount_cents: number;
  subtotal_cents: number;
  tax_rate: number;
  tax_amount_cents: number;
  total_cents: number;
  highlights: string[];
  created_at: string;
  updated_at: string;
  line_items: QuoteOptionLineItem[];
  cost_summary?: QuoteOptionCostSummary;
}

export interface QuoteShareLink {
  id: number;
  quote_id: number;
  quote_version_id: number;
  status: string;
  expires_at: string;
  selected_option_id: number | null;
  selected_at: string | null;
  selector_name: string;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

export interface PublicQuoteOption {
  id: number;
  quote_version_id: number;
  tier: OptionTier;
  name: string;
  headline: string;
  description: string;
  sort_order: number;
  recommended: boolean;
  discount_type: string;
  discount_percent: number;
  discount_cents: number;
  subtotal_cents: number;
  tax_rate: number;
  tax_amount_cents: number;
  total_cents: number;
  highlights: string[];
  created_at: string;
  updated_at: string;
  line_items: Omit<QuoteOptionLineItem, "cost_cents">[];
  tax_breakdown: { components: { code: string; name: string; rate_percent: number; amount_cents: number }[] } | null;
}

export interface PublicQuoteView {
  quote_identifier: string;
  customer_name: string;
  status: string;
  expires_at: string;
  already_selected_option_id: number | null;
  options: PublicQuoteOption[];
}
