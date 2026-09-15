export type View = "assets" | "dashboard" | "schedule" | "jobs" | "customers" | "technicians" | "services" | "invoices" | "materials";

export type JobStatus = "scheduled" | "confirmed" | "in_progress" | "completed" | "cancelled";
export type Priority = "low" | "normal" | "high" | "urgent";
export type InvoiceStatus = "draft" | "sent" | "paid" | "overdue" | "cancelled";

export interface Job {
  id: number;
  identifier: string;
  customer_id: number;
  asset_id: number | null;
  technician_id: number | null;
  service_type_id: number | null;
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
  job_notes?: JobNote[];
  checklist?: ChecklistItem[];
  job_materials?: JobMaterial[];
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
  job_count?: number;
  created_at: string;
  updated_at: string;
}

export interface Technician {
  id: number;
  name: string;
  email: string;
  phone: string;
  color: string;
  active: number;
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
  id: number;
  invoice_id: number;
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
  id: number;
  name: string;
  address: string;
}

export interface TechnicianLookup {
  id: number;
  name: string;
  color: string;
}

export interface Site {
  id: number;
  customer_id: number;
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
  id: number;
  customer_id: number;
  site_id: number;
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
  id: number;
  asset_id: number;
  job_id: number | null;
  available_job_id: number | null;
  summary: string;
  details: string;
  created_at: string;
}
