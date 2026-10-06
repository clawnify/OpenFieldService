export type View = "assets" | "dashboard" | "schedule" | "jobs" | "customers" | "technicians" | "services" | "invoices" | "materials";

export type JobStatus = "scheduled" | "confirmed" | "in_progress" | "completed" | "cancelled";
export type Priority = "low" | "normal" | "high" | "urgent";
export type InvoiceStatus = "draft" | "sent" | "paid" | "overdue" | "cancelled";

export interface Job {
  id: string;
  identifier: string;
  customer_id: string;
  asset_id: string | null;
  technician_id: string | null;
  service_type_id: string | null;
  status: JobStatus;
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
  customer_job_count?: number;
  customer_lifetime_revenue?: number;
  customer_last_service_id?: string | null;
  customer_last_service_identifier?: string | null;
  customer_last_service_date?: string | null;
  job_notes?: JobNote[];
  checklist?: ChecklistItem[];
  job_materials?: JobMaterial[];
  created_at: string;
  updated_at: string;
}

export interface Customer {
  id: string;
  name: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  notes: string;
  job_count?: number;
  created_at: string;
  updated_at: string;
}

export interface Technician {
  id: string;
  name: string;
  email: string;
  phone: string;
  color: string;
  active: number;
  job_count?: number;
  created_at: string;
}

export interface ServiceType {
  id: string;
  name: string;
  description: string;
  default_duration: number;
  default_price: number;
  color: string;
  created_at: string;
}

export interface JobNote {
  id: string;
  job_id: string;
  content: string;
  created_at: string;
}

export interface ChecklistItem {
  id: string;
  job_id: string;
  label: string;
  checked: number;
  sort_order: number;
}

export interface Material {
  id: string;
  name: string;
  unit: string;
  unit_cost: number;
  in_stock: number;
  created_at: string;
}

export interface JobMaterial {
  id: string;
  job_id: string;
  material_id: string;
  material_name?: string;
  material_unit?: string;
  quantity: number;
  unit_cost: number;
}

export interface Invoice {
  id: string;
  identifier: string;
  customer_id: string;
  job_id: string | null;
  status: InvoiceStatus;
  subtotal: number;
  tax_rate: number;
  tax_amount: number;
  total: number;
  notes: string;
  due_date: string;
  paid_date: string;
  customer_name?: string;
  job_identifier?: string;
  lines?: InvoiceLine[];
  created_at: string;
  updated_at: string;
}

export interface InvoiceLine {
  id: string;
  invoice_id: string;
  description: string;
  quantity: number;
  unit_price: number;
  total: number;
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

export interface CustomerLookup {
  id: string;
  name: string;
  address: string;
}

export interface TechnicianLookup {
  id: string;
  name: string;
  color: string;
}

export interface Site {
  id: string;
  customer_id: string;
  name: string;
  address: string;
  contact_name: string;
  contact_phone: string;
  contact_email: string;
  timezone: string;
  access_instructions: string;
  safety_notes: string;
  created_at: string;
  updated_at: string;
}

export interface Asset {
  id: string;
  customer_id: string;
  site_id: string;
  name: string;
  serial_number: string;
  manufacturer: string;
  model: string;
  status: "in_service" | "out_of_service" | "retired";
  installation_date: string;
  commissioning_date: string;
  warranty_start: string;
  warranty_end: string;
  notes: string;
  site_name: string;
  site_address: string;
  customer_name: string;
  created_at: string;
  updated_at: string;
}

export interface AssetHistory {
  id: string;
  asset_id: string;
  job_id: string | null;
  available_job_id: string | null;
  summary: string;
  details: string;
  created_at: string;
}
