import { useEffect, useMemo } from "preact/hooks";
import { AppContext } from "./context";
import { useAppState } from "./hooks/use-app";
import { useRouter } from "./hooks/use-router";
import { useAuth } from "./auth-context";
import { Sidebar } from "./components/sidebar";
import { Dashboard } from "./components/dashboard";
import { TechnicianHome } from "./components/technician-home";
import { ScheduleView } from "./components/schedule-view";
import { JobList } from "./components/job-list";
import { JobDetail } from "./components/job-detail";
import { CustomerList } from "./components/customer-list";
import { CustomerDetail } from "./components/customer-detail";
import { LeadList } from "./components/lead-list";
import { LeadDetail } from "./components/lead-detail";
import { TechnicianList } from "./components/technician-list";
import { ServiceTypeList } from "./components/service-type-list";
import { MaterialList } from "./components/material-list";
import { InvoiceList } from "./components/invoice-list";
import { InvoiceDetail } from "./components/invoice-detail";
import { UserManagement } from "./components/user-list";
import { Integrations } from "./components/integrations";
import { GlobalSettings } from "./components/global-settings";
import { EligibilityTracker } from "./components/eligibility-tracker";
import { ErrorBanner } from "./components/error-banner";

export function App() {
  const isAgent = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return params.has("agent") || params.get("mode") === "agent";
  }, []);

  useEffect(() => {
    if (isAgent) {
      document.documentElement.setAttribute("data-agent", "");
    }
  }, [isAgent]);

  const { view, id, navigate } = useRouter();
  const { user } = useAuth();
  const appState = useAppState(isAgent, navigate, user?.role);

  // Load detail when URL has an ID
  useEffect(() => {
    if (view === "jobs" && id) {
      appState.selectJob(parseInt(id, 10));
    } else if (view === "customers" && id) {
      appState.selectCustomer(parseInt(id, 10));
    } else if (view === "invoices" && id) {
      appState.selectInvoice(parseInt(id, 10));
    }
  }, [view, id]); // eslint-disable-line react-hooks/exhaustive-deps

  const renderMain = () => {
    if (view === "jobs" && id && appState.selectedJob) return <JobDetail />;
    if (view === "customers" && id && appState.selectedCustomer) return <CustomerDetail />;
    if (view === "invoices" && id && appState.selectedInvoice) return <InvoiceDetail />;
    // Leads is deliberately NOT part of the central AppContext/use-app.ts
    // state (see mem:backlog/p1-lead-management-pipeline, Phase 8.4) — a
    // self-contained fetch, same precedent as EligibilityTracker, since
    // it's entirely irrelevant to the technician role and doesn't belong in
    // the app-wide initial-load Promise.all. The technician fallback below
    // is a UX nicety only (avoids a dead-end page on a direct URL visit) —
    // the server's own binary Lead RBAC (Phase 8.2) is what actually
    // enforces this, same split as "invoices"/"eligibility" below.
    if (view === "leads" && id) {
      return user?.role !== "technician" ? <LeadDetail id={parseInt(id, 10)} navigate={navigate} /> : <TechnicianHome />;
    }
    switch (view) {
      case "schedule": return <ScheduleView />;
      case "jobs": return <JobList />;
      case "customers": return <CustomerList />;
      case "leads": return user?.role !== "technician" ? <LeadList navigate={navigate} /> : <TechnicianHome />;
      case "technicians": return <TechnicianList />;
      case "services": return <ServiceTypeList />;
      case "materials": return <MaterialList />;
      case "invoices": return user?.role !== "technician" ? <InvoiceList /> : <TechnicianHome />;
      case "users": return user?.role === "admin" ? <UserManagement /> : <Dashboard />;
      case "integrations": return <Integrations />;
      case "settings": return user?.role === "admin" ? <GlobalSettings /> : <Dashboard />;
      case "eligibility": return user?.role !== "technician" ? <EligibilityTracker /> : <Dashboard />;
      default: return user?.role === "technician" ? <TechnicianHome /> : <Dashboard />;
    }
  };

  return (
    <AppContext.Provider value={appState}>
      <div class="layout">
        <Sidebar currentView={view} />
        <main class="main-content">
          {appState.loading ? (
            <div class="loading-text">Loading...</div>
          ) : (
            renderMain()
          )}
        </main>
      </div>
      <ErrorBanner />
    </AppContext.Provider>
  );
}
