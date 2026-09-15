import { createContext } from "preact";
import { useContext } from "preact/hooks";
import type {
  Job, Customer, Technician, ServiceType, Material, Invoice, Stats, PaginatedState,
  CustomerLookup, TechnicianLookup, Priority,
} from "./types";

export interface AppContextValue {
  navigate: (to: string) => void;
  isAgent: boolean;
  stats: Stats;

  // Jobs
  jobs: Job[];
  jobsPag: PaginatedState;
  setJobsPage: (page: number) => void;
  jobsSearch: string;
  setJobsSearch: (s: string) => void;
  jobsStatusFilter: string;
  setJobsStatusFilter: (s: string) => void;
  addJob: (data: {
    customer_id: number;
    asset_id?: number | null;
    technician_id?: number | null;
    service_type_id?: number | null;
    scheduled_date: string;
    scheduled_time?: string;
    duration?: number;
    price?: number;
    address?: string;
    notes?: string;
    priority?: Priority;
    is_recurring?: number;
    recurrence_interval?: string;
  }) => Promise<void>;
  updateJob: (id: number, data: Partial<Job>) => Promise<void>;
  deleteJob: (id: number) => Promise<void>;

  // Job detail
  selectedJob: Job | null;
  selectJob: (id: number | null) => Promise<void>;
  addJobNote: (jobId: number, content: string) => Promise<void>;
  deleteJobNote: (noteId: number) => Promise<void>;
  addChecklistItem: (jobId: number, label: string) => Promise<void>;
  toggleChecklistItem: (itemId: number) => Promise<void>;
  deleteChecklistItem: (itemId: number) => Promise<void>;
  addJobMaterial: (jobId: number, materialId: number, quantity: number) => Promise<void>;
  deleteJobMaterial: (id: number) => Promise<void>;
  createInvoiceFromJob: (jobId: number) => Promise<void>;

  // Customers
  customers: Customer[];
  customersPag: PaginatedState;
  setCustomersPage: (page: number) => void;
  customersSearch: string;
  setCustomersSearch: (s: string) => void;
  addCustomer: (data: Partial<Customer>) => Promise<void>;
  updateCustomer: (id: number, data: Partial<Customer>) => Promise<void>;
  deleteCustomer: (id: number) => Promise<void>;
  selectedCustomer: Customer | null;
  selectedCustomerJobs: Job[];
  selectCustomer: (id: number | null) => Promise<void>;

  // Technicians
  technicians: Technician[];
  addTechnician: (data: Partial<Technician>) => Promise<void>;
  updateTechnician: (id: number, data: Partial<Technician>) => Promise<void>;
  deleteTechnician: (id: number) => Promise<void>;

  // Service Types
  serviceTypes: ServiceType[];
  addServiceType: (data: Partial<ServiceType>) => Promise<void>;
  updateServiceType: (id: number, data: Partial<ServiceType>) => Promise<void>;
  deleteServiceType: (id: number) => Promise<void>;

  // Materials
  materials: Material[];
  addMaterial: (data: Partial<Material>) => Promise<void>;
  updateMaterial: (id: number, data: Partial<Material>) => Promise<void>;
  deleteMaterial: (id: number) => Promise<void>;

  // Invoices
  invoices: Invoice[];
  invoicesPag: PaginatedState;
  setInvoicesPage: (page: number) => void;
  invoicesStatusFilter: string;
  setInvoicesStatusFilter: (s: string) => void;
  selectedInvoice: Invoice | null;
  selectInvoice: (id: number | null) => Promise<void>;
  addInvoice: (data: { customer_id: number; job_id?: number | null; tax_rate?: number; notes?: string; due_date?: string; lines: { description: string; quantity: number; unit_price: number }[] }) => Promise<void>;
  updateInvoice: (id: number, data: Partial<Invoice>) => Promise<void>;
  deleteInvoice: (id: number) => Promise<void>;

  // Schedule
  scheduleJobs: Job[];
  scheduleStart: string;
  scheduleEnd: string;
  setScheduleRange: (start: string, end: string) => void;

  // Lookups
  customerLookup: CustomerLookup[];
  technicianLookup: TechnicianLookup[];

  loading: boolean;
  error: string | null;
  setError: (msg: string | null) => void;
}

export const AppContext = createContext<AppContextValue>(null!);

export function useApp() {
  return useContext(AppContext);
}
