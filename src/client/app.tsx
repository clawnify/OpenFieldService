import { useEffect, useMemo } from "preact/hooks";
import { AppContext } from "./context";
import { useAppState } from "./hooks/use-app";
import { useRouter } from "./hooks/use-router";
import { Sidebar } from "./components/sidebar";
import { Dashboard } from "./components/dashboard";
import { ScheduleView } from "./components/schedule-view";
import { JobList } from "./components/job-list";
import { JobDetail } from "./components/job-detail";
import { CustomerList } from "./components/customer-list";
import { CustomerDetail } from "./components/customer-detail";
import { TechnicianList } from "./components/technician-list";
import { ServiceTypeList } from "./components/service-type-list";
import { MaterialList } from "./components/material-list";
import { InvoiceList } from "./components/invoice-list";
import { InvoiceDetail } from "./components/invoice-detail";
import { AssetDetail } from "./components/asset-detail";
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
  const appState = useAppState(isAgent, navigate);

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
    if (view === "assets" && id) return <AssetDetail key={id} id={Number(id)} />;
    if (view === "jobs" && id && appState.selectedJob) return <JobDetail />;
    if (view === "customers" && id && appState.selectedCustomer) return <CustomerDetail />;
    if (view === "invoices" && id && appState.selectedInvoice) return <InvoiceDetail />;
    switch (view) {
      case "schedule": return <ScheduleView />;
      case "jobs": return <JobList />;
      case "customers": return <CustomerList />;
      case "technicians": return <TechnicianList />;
      case "services": return <ServiceTypeList />;
      case "materials": return <MaterialList />;
      case "invoices": return <InvoiceList />;
      default: return <Dashboard />;
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
