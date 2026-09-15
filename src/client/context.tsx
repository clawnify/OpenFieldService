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
    customer_id: string;
    asset_id?: string | null;
    technician_id?: string | null;
    service_type_id?: string | null;
    scheduled_date: string;
    scheduled_time?: string;
    duration?: number;
    price?: number;
    address?: string;
    notes?: string;
    priority?: Priority;
    is_recurring?: number;
    recurrence_interval?: string;
  }) => Promise<Job>;
  updateJob: (id: string, data: Partial<Job>) => Promise<void>;
  deleteJob: (id: string) => Promise<void>;

  // Job detail
  selectedJob: Job | null;
  selectJob: (id: string | null) => Promise<void>;
  addJobNote: (jobId: string, content: string) => Promise<void>;
  deleteJobNote: (noteId: string) => Promise<void>;
  addChecklistItem: (jobId: string, label: string) => Promise<void>;
  toggleChecklistItem: (itemId: string) => Promise<void>;
  deleteChecklistItem: (itemId: string) => Promise<void>;
  addJobMaterial: (jobId: string, materialId: string, quantity: number) => Promise<void>;
  deleteJobMaterial: (id: string) => Promise<void>;
  createInvoiceFromJob: (jobId: string) => Promise<void>;

  // Customers
  customers: Customer[];
  customersPag: PaginatedState;
  setCustomersPage: (page: number) => void;
  customersSearch: string;
  setCustomersSearch: (s: string) => void;
  addCustomer: (data: Partial<Customer>) => Promise<void>;
  updateCustomer: (id: string, data: Partial<Customer>) => Promise<void>;
  deleteCustomer: (id: string) => Promise<void>;
  selectedCustomer: Customer | null;
  selectedCustomerJobs: Job[];
  selectCustomer: (id: string | null) => Promise<void>;

  // Technicians
  technicians: Technician[];
  addTechnician: (data: Partial<Technician>) => Promise<void>;
  updateTechnician: (id: string, data: Partial<Technician>) => Promise<void>;
  deleteTechnician: (id: string) => Promise<void>;

  // Service Types
  serviceTypes: ServiceType[];
  addServiceType: (data: Partial<ServiceType>) => Promise<void>;
  updateServiceType: (id: string, data: Partial<ServiceType>) => Promise<void>;
  deleteServiceType: (id: string) => Promise<void>;

  // Materials
  materials: Material[];
  addMaterial: (data: Partial<Material>) => Promise<void>;
  updateMaterial: (id: string, data: Partial<Material>) => Promise<void>;
  deleteMaterial: (id: string) => Promise<void>;

  // Invoices
  invoices: Invoice[];
  invoicesPag: PaginatedState;
  setInvoicesPage: (page: number) => void;
  invoicesStatusFilter: string;
  setInvoicesStatusFilter: (s: string) => void;
  selectedInvoice: Invoice | null;
  selectInvoice: (id: string | null) => Promise<void>;
  addInvoice: (data: { customer_id: string; job_id?: string | null; tax_rate?: number; notes?: string; due_date?: string; lines: { description: string; quantity: number; unit_price: number }[] }) => Promise<void>;
  updateInvoice: (id: string, data: Partial<Invoice>) => Promise<void>;
  deleteInvoice: (id: string) => Promise<void>;

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
