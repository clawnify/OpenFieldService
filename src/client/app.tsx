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
import { QuoteList } from "./components/quote-list";
import { QuoteDetail } from "./components/quote-detail";
import { ContractList } from "./components/contract-list";
import { ContractDetail } from "./components/contract-detail";
import { PhoneOperations } from "./components/phone-operations";
import { TechnicianList } from "./components/technician-list";
import { ServiceTypeList } from "./components/service-type-list";
import { MaterialList } from "./components/material-list";
import { InvoiceList } from "./components/invoice-list";
import { InvoiceDetail } from "./components/invoice-detail";
import { PricebookList } from "./components/pricebook-list";
import { MaintenancePlans } from "./components/maintenance-plans";
import { LegalTerms } from "./components/legal-terms";
import { ChecklistTemplates } from "./components/checklist-templates";
import { MaintenanceAgreementList } from "./components/maintenance-agreement-list";
import { MaintenanceAgreementDetail } from "./components/maintenance-agreement-detail";
import { MaintenanceAutomation } from "./components/maintenance-automation";
import { UserManagement } from "./components/user-list";
import { Integrations } from "./components/integrations";
import { GlobalSettings } from "./components/global-settings";
import { EligibilityTracker } from "./modules/programs/bc/eligibility-tracker";
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
    // Quotes is self-contained (own fetch, not AppContext) for the same
    // reason as Leads above — irrelevant to the technician role.
    if (view === "quotes" && id) {
      return user?.role !== "technician" ? <QuoteDetail id={parseInt(id, 10)} navigate={navigate} /> : <TechnicianHome />;
    }
    // Contracts is self-contained (own fetch, not AppContext) for the same
    // reason as Quotes/Leads above — irrelevant to the technician role.
    if (view === "contracts" && id) {
      return user?.role !== "technician" ? <ContractDetail id={parseInt(id, 10)} navigate={navigate} /> : <TechnicianHome />;
    }
    // Maintenance Agreements is self-contained (own fetch, not AppContext)
    // for the same reason as Quotes/Leads/Contracts above — irrelevant to
    // the technician role.
    if (view === "maintenance-agreements" && id) {
      return user?.role !== "technician" ? <MaintenanceAgreementDetail id={parseInt(id, 10)} navigate={navigate} /> : <TechnicianHome />;
    }
    switch (view) {
      case "schedule": return <ScheduleView />;
      case "jobs": return <JobList />;
      case "customers": return <CustomerList />;
      case "leads": return user?.role !== "technician" ? <LeadList navigate={navigate} /> : <TechnicianHome />;
      case "quotes": return user?.role !== "technician" ? <QuoteList navigate={navigate} /> : <TechnicianHome />;
      case "contracts": return user?.role !== "technician" ? <ContractList navigate={navigate} /> : <TechnicianHome />;
      case "phone-operations": return user?.role !== "technician" ? <PhoneOperations /> : <TechnicianHome />;
      case "technicians": return <TechnicianList />;
      case "services": return <ServiceTypeList />;
      case "materials": return <MaterialList />;
      case "invoices": return user?.role !== "technician" ? <InvoiceList /> : <TechnicianHome />;
      // Pricebook is a front-office/sales catalog surface (Quote line-item
      // selection) — same technician split as Leads/Quotes/Contracts above.
      // The server's own canViewPricebook RBAC (src/server/pricebook.ts) is
      // what actually enforces this regardless of what renders here.
      case "pricebook": return user?.role !== "technician" ? <PricebookList /> : <TechnicianHome />;
      case "maintenance-agreements": return user?.role !== "technician" ? <MaintenanceAgreementList navigate={navigate} /> : <TechnicianHome />;
      case "maintenance-plans": return user?.role !== "technician" ? <MaintenancePlans /> : <TechnicianHome />;
      case "maintenance-automation": return user?.role !== "technician" ? <MaintenanceAutomation navigate={navigate} /> : <TechnicianHome />;
      case "legal-terms": return user?.role !== "technician" ? <LegalTerms /> : <TechnicianHome />;
      case "checklist-templates": return user?.role !== "technician" ? <ChecklistTemplates /> : <TechnicianHome />;
      case "users": return user?.role === "admin" ? <UserManagement /> : <Dashboard />;
      // Phase 13C RBAC audit: deliberately NOT role-gated. This route is
      // per-user Google Calendar connection (each user links their own
      // account, server-scoped by user_id — see src/server/index.ts's
      // Google Calendar Integration routes), not an organization-level
      // Integrations *management* surface like Global Settings/Company
      // Profile. There is no other Integrations UI in this codebase —
      // provider config (Maps/Payments/Email/SMS) has no UI at all, env/
      // secret-only. Restricting this route would break a working,
      // intentional per-role feature with no product requirement to do so.
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
