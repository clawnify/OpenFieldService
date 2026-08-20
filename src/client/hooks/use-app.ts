import { useState, useCallback, useEffect } from "preact/hooks";
import { api } from "../api";
import type {
  Job, Customer, Technician, ServiceType, Material, Invoice, Stats, PaginatedState,
  CustomerLookup, TechnicianLookup, Priority, JobType, Role,
} from "../types";
import type { AppContextValue } from "../context";

export function useAppState(isAgent: boolean, navigate: (to: string) => void, role?: Role): AppContextValue {
  const [stats, setStats] = useState<Stats>({ jobs: 0, customers: 0, technicians: 0, service_types: 0, today_jobs: 0, upcoming_jobs: 0, completed_jobs: 0, revenue: 0, invoices_outstanding: 0, invoices_overdue: 0 });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Jobs
  const [jobs, setJobs] = useState<Job[]>([]);
  const [jobsPag, setJobsPag] = useState<PaginatedState>({ page: 1, limit: 50, total: 0 });
  const [jobsSearch, setJobsSearch] = useState("");
  const [jobsStatusFilter, setJobsStatusFilter] = useState("");
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);

  // Customers
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customersPag, setCustomersPag] = useState<PaginatedState>({ page: 1, limit: 50, total: 0 });
  const [customersSearch, setCustomersSearch] = useState("");
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [selectedCustomerJobs, setSelectedCustomerJobs] = useState<Job[]>([]);

  // Technicians, Service Types, Materials
  const [technicians, setTechnicians] = useState<Technician[]>([]);
  const [serviceTypes, setServiceTypes] = useState<ServiceType[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);

  // Invoices
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [invoicesPag, setInvoicesPag] = useState<PaginatedState>({ page: 1, limit: 50, total: 0 });
  const [invoicesStatusFilter, setInvoicesStatusFilter] = useState("");
  const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null);

  // Schedule
  const today = new Date();
  const monday = new Date(today);
  monday.setDate(today.getDate() - today.getDay() + 1);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const [scheduleStart, setScheduleStart] = useState(monday.toISOString().split("T")[0]);
  const [scheduleEnd, setScheduleEnd] = useState(sunday.toISOString().split("T")[0]);
  const [scheduleJobs, setScheduleJobs] = useState<Job[]>([]);

  // Lookups
  const [customerLookup, setCustomerLookup] = useState<CustomerLookup[]>([]);
  const [technicianLookup, setTechnicianLookup] = useState<TechnicianLookup[]>([]);

  // ── Fetch helpers ──

  const fetchStats = useCallback(async () => {
    const data = await api<Stats>("GET", "/api/stats");
    setStats(data);
  }, []);

  const fetchJobs = useCallback(async (pag: PaginatedState, search: string, status: string) => {
    const params = new URLSearchParams({ page: String(pag.page), limit: String(pag.limit) });
    if (search) params.set("search", search);
    if (status) params.set("status", status);
    const data = await api<{ jobs: Job[]; total: number }>("GET", `/api/jobs?${params}`);
    setJobs(data.jobs);
    setJobsPag((prev) => ({ ...prev, total: data.total }));
  }, []);

  const fetchCustomers = useCallback(async (pag: PaginatedState, search: string) => {
    const params = new URLSearchParams({ page: String(pag.page), limit: String(pag.limit) });
    if (search) params.set("search", search);
    const data = await api<{ customers: Customer[]; total: number }>("GET", `/api/customers?${params}`);
    setCustomers(data.customers);
    setCustomersPag((prev) => ({ ...prev, total: data.total }));
  }, []);

  const fetchTechnicians = useCallback(async () => {
    const data = await api<{ technicians: Technician[] }>("GET", "/api/technicians");
    setTechnicians(data.technicians);
  }, []);

  const fetchServiceTypes = useCallback(async () => {
    const data = await api<{ service_types: ServiceType[] }>("GET", "/api/service-types");
    setServiceTypes(data.service_types);
  }, []);

  const fetchMaterials = useCallback(async () => {
    const data = await api<{ materials: Material[] }>("GET", "/api/materials");
    setMaterials(data.materials);
  }, []);

  // Technicians get a full financial blackout server-side, including reads
  // (see mem:project/fsm-upgrade-plan, Phase 5: canManageFinancials()) — a
  // technician actor calling GET /api/invoices always gets a guaranteed 403.
  // Skipping the call entirely for that role (rather than letting it throw)
  // fixes a real bug this audit found: the initial-load Promise.all in the
  // effect below used to reject on that 403, surfacing a bare "Forbidden"
  // error banner to every technician immediately after login.
  const fetchInvoices = useCallback(async (pag: PaginatedState, status: string) => {
    if (role === "technician") return;
    const params = new URLSearchParams({ page: String(pag.page), limit: String(pag.limit) });
    if (status) params.set("status", status);
    const data = await api<{ invoices: Invoice[]; total: number }>("GET", `/api/invoices?${params}`);
    setInvoices(data.invoices);
    setInvoicesPag((prev) => ({ ...prev, total: data.total }));
  }, [role]);

  const fetchSchedule = useCallback(async (start: string, end: string) => {
    const data = await api<{ jobs: Job[] }>("GET", `/api/schedule?start=${start}&end=${end}`);
    setScheduleJobs(data.jobs);
  }, []);

  const fetchLookups = useCallback(async () => {
    const [c, t] = await Promise.all([
      api<{ customers: CustomerLookup[] }>("GET", "/api/customers/all"),
      api<{ technicians: TechnicianLookup[] }>("GET", "/api/technicians/all"),
    ]);
    setCustomerLookup(c.customers);
    setTechnicianLookup(t.technicians);
  }, []);

  // ── Initial load ──

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        await Promise.all([
          fetchStats(),
          fetchJobs(jobsPag, "", ""),
          fetchCustomers(customersPag, ""),
          fetchTechnicians(),
          fetchServiceTypes(),
          fetchMaterials(),
          fetchInvoices(invoicesPag, ""),
          fetchSchedule(scheduleStart, scheduleEnd),
          fetchLookups(),
        ]);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetchJobs(jobsPag, jobsSearch, jobsStatusFilter).catch((err) => setError((err as Error).message));
  }, [jobsPag.page, jobsSearch, jobsStatusFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetchCustomers(customersPag, customersSearch).catch((err) => setError((err as Error).message));
  }, [customersPag.page, customersSearch]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetchInvoices(invoicesPag, invoicesStatusFilter).catch((err) => setError((err as Error).message));
  }, [invoicesPag.page, invoicesStatusFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetchSchedule(scheduleStart, scheduleEnd).catch((err) => setError((err as Error).message));
  }, [scheduleStart, scheduleEnd]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Jobs CRUD ──

  const setJobsPage = useCallback((page: number) => setJobsPag((p) => ({ ...p, page })), []);

  const addJob = useCallback(async (data: {
    customer_id: number; technician_id?: number | null; service_type_id?: number | null;
    job_type?: JobType; scheduled_date: string; scheduled_time?: string; duration?: number; price?: number;
    address?: string; notes?: string; priority?: Priority; is_recurring?: number; recurrence_interval?: string;
  }) => {
    await api("POST", "/api/jobs", data);
    await fetchJobs(jobsPag, jobsSearch, jobsStatusFilter);
    await Promise.all([fetchStats(), fetchSchedule(scheduleStart, scheduleEnd)]);
  }, [jobsPag, jobsSearch, jobsStatusFilter, scheduleStart, scheduleEnd, fetchJobs, fetchStats, fetchSchedule]);

  const updateJob = useCallback(async (id: number, data: Partial<Job>) => {
    await api("PUT", `/api/jobs/${id}`, data);
    await fetchJobs(jobsPag, jobsSearch, jobsStatusFilter);
    if (selectedJob && selectedJob.id === id) {
      const res = await api<{ job: Job }>("GET", `/api/jobs/${id}`);
      setSelectedJob(res.job);
    }
    await Promise.all([fetchStats(), fetchSchedule(scheduleStart, scheduleEnd)]);
  }, [jobsPag, jobsSearch, jobsStatusFilter, selectedJob, scheduleStart, scheduleEnd, fetchJobs, fetchStats, fetchSchedule]);

  const transitionJob = useCallback(async (id: number, toStatus: string, extra?: {
    reason?: string; eligibility_code?: string; eligibility_code_expiry?: string;
  }) => {
    await api("POST", `/api/jobs/${id}/transition`, { to_status: toStatus, ...extra });
    await fetchJobs(jobsPag, jobsSearch, jobsStatusFilter);
    if (selectedJob && selectedJob.id === id) {
      const res = await api<{ job: Job }>("GET", `/api/jobs/${id}`);
      setSelectedJob(res.job);
    }
    await Promise.all([fetchStats(), fetchSchedule(scheduleStart, scheduleEnd)]);
  }, [jobsPag, jobsSearch, jobsStatusFilter, selectedJob, scheduleStart, scheduleEnd, fetchJobs, fetchStats, fetchSchedule]);

  const deleteJob = useCallback(async (id: number) => {
    await api("DELETE", `/api/jobs/${id}`);
    if (selectedJob && selectedJob.id === id) { setSelectedJob(null); navigate("/jobs"); }
    await fetchJobs(jobsPag, jobsSearch, jobsStatusFilter);
    await Promise.all([fetchStats(), fetchSchedule(scheduleStart, scheduleEnd)]);
  }, [jobsPag, jobsSearch, jobsStatusFilter, selectedJob, scheduleStart, scheduleEnd, navigate, fetchJobs, fetchStats, fetchSchedule]);

  const selectJob = useCallback(async (id: number | null) => {
    if (id === null) { setSelectedJob(null); return; }
    const res = await api<{ job: Job }>("GET", `/api/jobs/${id}`);
    setSelectedJob(res.job);
  }, []);

  const addJobNote = useCallback(async (jobId: number, content: string) => {
    await api("POST", `/api/jobs/${jobId}/notes`, { content });
    const res = await api<{ job: Job }>("GET", `/api/jobs/${jobId}`);
    setSelectedJob(res.job);
  }, []);

  const deleteJobNote = useCallback(async (noteId: number) => {
    await api("DELETE", `/api/notes/${noteId}`);
    if (selectedJob) {
      const res = await api<{ job: Job }>("GET", `/api/jobs/${selectedJob.id}`);
      setSelectedJob(res.job);
    }
  }, [selectedJob]);

  // ── Checklist ──

  const addChecklistItem = useCallback(async (jobId: number, label: string) => {
    await api("POST", `/api/jobs/${jobId}/checklist`, { label });
    const res = await api<{ job: Job }>("GET", `/api/jobs/${jobId}`);
    setSelectedJob(res.job);
  }, []);

  const toggleChecklistItem = useCallback(async (itemId: number) => {
    await api("PUT", `/api/checklist/${itemId}`);
    if (selectedJob) {
      const res = await api<{ job: Job }>("GET", `/api/jobs/${selectedJob.id}`);
      setSelectedJob(res.job);
    }
  }, [selectedJob]);

  const deleteChecklistItem = useCallback(async (itemId: number) => {
    await api("DELETE", `/api/checklist/${itemId}`);
    if (selectedJob) {
      const res = await api<{ job: Job }>("GET", `/api/jobs/${selectedJob.id}`);
      setSelectedJob(res.job);
    }
  }, [selectedJob]);

  // ── Job Materials ──

  const addJobMaterial = useCallback(async (jobId: number, materialId: number, quantity: number) => {
    await api("POST", `/api/jobs/${jobId}/materials`, { material_id: materialId, quantity });
    const res = await api<{ job: Job }>("GET", `/api/jobs/${jobId}`);
    setSelectedJob(res.job);
  }, []);

  const deleteJobMaterial = useCallback(async (id: number) => {
    await api("DELETE", `/api/job-materials/${id}`);
    if (selectedJob) {
      const res = await api<{ job: Job }>("GET", `/api/jobs/${selectedJob.id}`);
      setSelectedJob(res.job);
    }
  }, [selectedJob]);

  // ── Invoice from job ──

  const createInvoiceFromJob = useCallback(async (jobId: number) => {
    await api("POST", `/api/jobs/${jobId}/invoice`);
    await fetchInvoices(invoicesPag, invoicesStatusFilter);
    await fetchStats();
    navigate("/invoices");
  }, [invoicesPag, invoicesStatusFilter, navigate, fetchInvoices, fetchStats]);

  // ── Customers CRUD ──

  const setCustomersPage = useCallback((page: number) => setCustomersPag((p) => ({ ...p, page })), []);

  const addCustomer = useCallback(async (data: Partial<Customer>) => {
    await api("POST", "/api/customers", data);
    await fetchCustomers(customersPag, customersSearch);
    await Promise.all([fetchStats(), fetchLookups()]);
  }, [customersPag, customersSearch, fetchCustomers, fetchStats, fetchLookups]);

  const updateCustomer = useCallback(async (id: number, data: Partial<Customer>) => {
    await api("PUT", `/api/customers/${id}`, data);
    await fetchCustomers(customersPag, customersSearch);
    await fetchLookups();
    if (selectedCustomer && selectedCustomer.id === id) {
      const res = await api<{ customer: Customer; jobs: Job[] }>("GET", `/api/customers/${id}`);
      setSelectedCustomer(res.customer);
      setSelectedCustomerJobs(res.jobs);
    }
  }, [customersPag, customersSearch, selectedCustomer, fetchCustomers, fetchLookups]);

  const deleteCustomer = useCallback(async (id: number) => {
    await api("DELETE", `/api/customers/${id}`);
    if (selectedCustomer && selectedCustomer.id === id) {
      setSelectedCustomer(null);
      setSelectedCustomerJobs([]);
      navigate("/customers");
    }
    await fetchCustomers(customersPag, customersSearch);
    await Promise.all([fetchStats(), fetchLookups()]);
  }, [customersPag, customersSearch, selectedCustomer, navigate, fetchCustomers, fetchStats, fetchLookups]);

  const selectCustomer = useCallback(async (id: number | null) => {
    if (id === null) { setSelectedCustomer(null); setSelectedCustomerJobs([]); return; }
    const res = await api<{ customer: Customer; jobs: Job[] }>("GET", `/api/customers/${id}`);
    setSelectedCustomer(res.customer);
    setSelectedCustomerJobs(res.jobs);
  }, []);

  // ── Technicians CRUD ──

  const addTechnician = useCallback(async (data: Partial<Technician>) => {
    await api("POST", "/api/technicians", data);
    await fetchTechnicians();
    await Promise.all([fetchStats(), fetchLookups()]);
  }, [fetchTechnicians, fetchStats, fetchLookups]);

  const updateTechnician = useCallback(async (id: number, data: Partial<Technician>) => {
    await api("PUT", `/api/technicians/${id}`, data);
    await fetchTechnicians();
    await fetchLookups();
  }, [fetchTechnicians, fetchLookups]);

  const deleteTechnician = useCallback(async (id: number) => {
    await api("DELETE", `/api/technicians/${id}`);
    await fetchTechnicians();
    await Promise.all([fetchStats(), fetchLookups()]);
  }, [fetchTechnicians, fetchStats, fetchLookups]);

  // ── Service Types CRUD ──

  const addServiceType = useCallback(async (data: Partial<ServiceType>) => {
    await api("POST", "/api/service-types", data);
    await fetchServiceTypes();
    await fetchStats();
  }, [fetchServiceTypes, fetchStats]);

  const updateServiceType = useCallback(async (id: number, data: Partial<ServiceType>) => {
    await api("PUT", `/api/service-types/${id}`, data);
    await fetchServiceTypes();
  }, [fetchServiceTypes]);

  const deleteServiceType = useCallback(async (id: number) => {
    await api("DELETE", `/api/service-types/${id}`);
    await fetchServiceTypes();
    await fetchStats();
  }, [fetchServiceTypes, fetchStats]);

  // ── Materials CRUD ──

  const addMaterial = useCallback(async (data: Partial<Material>) => {
    await api("POST", "/api/materials", data);
    await fetchMaterials();
  }, [fetchMaterials]);

  const updateMaterial = useCallback(async (id: number, data: Partial<Material>) => {
    await api("PUT", `/api/materials/${id}`, data);
    await fetchMaterials();
  }, [fetchMaterials]);

  const deleteMaterial = useCallback(async (id: number) => {
    await api("DELETE", `/api/materials/${id}`);
    await fetchMaterials();
  }, [fetchMaterials]);

  // ── Invoices CRUD ──

  const setInvoicesPage = useCallback((page: number) => setInvoicesPag((p) => ({ ...p, page })), []);

  /** Every financial mutation (issue/void/rebate/payment, plus the pre-existing
   *  update/delete) needs the exact same three-way refresh — the list, the
   *  currently-selected invoice detail if it's the one that changed, and the
   *  dashboard stats (outstanding/overdue counts). Centralized once instead of
   *  repeated per action. */
  const refreshInvoiceState = useCallback(async (id: number) => {
    await fetchInvoices(invoicesPag, invoicesStatusFilter);
    if (selectedInvoice && selectedInvoice.id === id) {
      const res = await api<{ invoice: Invoice }>("GET", `/api/invoices/${id}`);
      setSelectedInvoice(res.invoice);
    }
    await fetchStats();
  }, [invoicesPag, invoicesStatusFilter, selectedInvoice, fetchInvoices, fetchStats]);

  const addInvoice = useCallback(async (data: { customer_id: number; job_id?: number | null; tax_rate?: number; notes?: string; due_date?: string; lines: { description: string; quantity: number; unit_price_cents: number }[] }) => {
    await api("POST", "/api/invoices", data);
    await fetchInvoices(invoicesPag, invoicesStatusFilter);
    await fetchStats();
  }, [invoicesPag, invoicesStatusFilter, fetchInvoices, fetchStats]);

  const updateInvoice = useCallback(async (id: number, data: { notes?: string; due_date?: string }) => {
    await api("PUT", `/api/invoices/${id}`, data);
    await refreshInvoiceState(id);
  }, [refreshInvoiceState]);

  const issueInvoice = useCallback(async (id: number) => {
    await api("POST", `/api/invoices/${id}/issue`, {});
    await refreshInvoiceState(id);
  }, [refreshInvoiceState]);

  const voidInvoice = useCallback(async (id: number, reason: string) => {
    await api("POST", `/api/invoices/${id}/void`, { reason });
    await refreshInvoiceState(id);
  }, [refreshInvoiceState]);

  const setInvoiceRebate = useCallback(async (id: number, rebateAmountCents: number) => {
    await api("PUT", `/api/invoices/${id}/rebate`, { rebate_amount_cents: rebateAmountCents });
    await refreshInvoiceState(id);
  }, [refreshInvoiceState]);

  const recordPayment = useCallback(async (
    invoiceId: number,
    data: { amount_cents: number; payer_type: string; method: string; reference?: string; notes?: string; paid_at?: string }
  ) => {
    await api("POST", `/api/invoices/${invoiceId}/payments`, data);
    await refreshInvoiceState(invoiceId);
  }, [refreshInvoiceState]);

  const voidPayment = useCallback(async (paymentId: number, invoiceId: number, reason: string) => {
    await api("POST", `/api/payments/${paymentId}/void`, { reason });
    await refreshInvoiceState(invoiceId);
  }, [refreshInvoiceState]);

  const deleteInvoice = useCallback(async (id: number) => {
    await api("DELETE", `/api/invoices/${id}`);
    if (selectedInvoice && selectedInvoice.id === id) { setSelectedInvoice(null); navigate("/invoices"); }
    await fetchInvoices(invoicesPag, invoicesStatusFilter);
    await fetchStats();
  }, [invoicesPag, invoicesStatusFilter, selectedInvoice, navigate, fetchInvoices, fetchStats]);

  const selectInvoice = useCallback(async (id: number | null) => {
    if (id === null) { setSelectedInvoice(null); return; }
    const res = await api<{ invoice: Invoice }>("GET", `/api/invoices/${id}`);
    setSelectedInvoice(res.invoice);
  }, []);

  // ── Schedule ──

  const setScheduleRange = useCallback((start: string, end: string) => {
    setScheduleStart(start);
    setScheduleEnd(end);
  }, []);

  const refreshSchedule = useCallback(async () => {
    await fetchSchedule(scheduleStart, scheduleEnd);
  }, [scheduleStart, scheduleEnd, fetchSchedule]);

  return {
    navigate, isAgent, stats,
    jobs, jobsPag, setJobsPage, jobsSearch, setJobsSearch, jobsStatusFilter, setJobsStatusFilter,
    addJob, updateJob, transitionJob, deleteJob,
    selectedJob, selectJob, addJobNote, deleteJobNote,
    addChecklistItem, toggleChecklistItem, deleteChecklistItem,
    addJobMaterial, deleteJobMaterial, createInvoiceFromJob,
    customers, customersPag, setCustomersPage, customersSearch, setCustomersSearch,
    addCustomer, updateCustomer, deleteCustomer,
    selectedCustomer, selectedCustomerJobs, selectCustomer,
    technicians, addTechnician, updateTechnician, deleteTechnician,
    serviceTypes, addServiceType, updateServiceType, deleteServiceType,
    materials, addMaterial, updateMaterial, deleteMaterial,
    invoices, invoicesPag, setInvoicesPage, invoicesStatusFilter, setInvoicesStatusFilter,
    selectedInvoice, selectInvoice, addInvoice, updateInvoice, deleteInvoice,
    issueInvoice, voidInvoice, setInvoiceRebate, recordPayment, voidPayment,
    scheduleJobs, scheduleStart, scheduleEnd, setScheduleRange, refreshSchedule,
    customerLookup, technicianLookup,
    loading, error, setError,
  };
}
