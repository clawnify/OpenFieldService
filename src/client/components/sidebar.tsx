import { useEffect, useRef, useState } from "preact/hooks";
import { useApp } from "../context";
import { useAuth } from "../auth-context";
import { ROLE_LABELS } from "../role-labels";
import { ChangeMyPassword } from "./change-my-password";
import {
  CalendarClock, LayoutDashboard, Briefcase, Users, Wrench, Settings, CalendarDays,
  FileText, Package, UserCog, KeyRound, LogOut, CalendarSync, SlidersHorizontal, BadgeCheck, Target, Calculator, FileSignature, Phone, Menu, X, Tags,
} from "lucide-preact";
import type { View } from "../types";

const navItems: { view: View; path: string; label: string; icon: typeof LayoutDashboard; adminOnly?: boolean; hideFromTechnician?: boolean }[] = [
  { view: "dashboard", path: "/", label: "Dashboard", icon: LayoutDashboard },
  { view: "schedule", path: "/schedule", label: "Schedule", icon: CalendarDays },
  { view: "jobs", path: "/jobs", label: "Jobs", icon: Briefcase },
  // Leads is a front-office/sales concern with no field-work component —
  // hidden from technician client-side purely for usability (the server's
  // own binary RBAC, Phase 8.2, is what actually enforces this; see
  // mem:architecture/auth). A direct API call from a technician session
  // still 403s regardless of what this sidebar renders.
  { view: "leads", path: "/leads", label: "Leads", icon: Target, hideFromTechnician: true },
  { view: "customers", path: "/customers", label: "Customers", icon: Users },
  { view: "quotes", path: "/quotes", label: "Quotes", icon: Calculator, hideFromTechnician: true },
  { view: "contracts", path: "/contracts", label: "Contracts", icon: FileSignature, hideFromTechnician: true },
  { view: "phone-operations", path: "/phone-operations", label: "Phone Operations", icon: Phone, hideFromTechnician: true },
  // Phase 17 — Pricebook is a front-office/sales catalog surface (Quote
  // line-item selection), not field work — same hideFromTechnician split as
  // Leads/Quotes/Contracts/Phone-Operations above (see canViewPricebook in
  // src/server/pricebook.ts: admin+dispatcher only, technician gets no
  // route access to this surface at all).
  { view: "pricebook", path: "/pricebook", label: "Pricebook", icon: Tags, hideFromTechnician: true },
  { view: "technicians", path: "/technicians", label: "Technicians", icon: Wrench },
  { view: "invoices", path: "/invoices", label: "Invoices", icon: FileText, hideFromTechnician: true },
  { view: "materials", path: "/materials", label: "Materials", icon: Package },
  { view: "services", path: "/services", label: "Service Types", icon: Settings },
  { view: "eligibility", path: "/eligibility", label: "Eligibility Tracker", icon: BadgeCheck, hideFromTechnician: true },
  { view: "users", path: "/users", label: "User Management", icon: UserCog, adminOnly: true },
  // Per-user personal Google Calendar connection, not an org-level
  // Integrations management surface — deliberately visible to every role.
  // See app.tsx's matching comment on the "integrations" route case.
  { view: "integrations", path: "/integrations", label: "Google Calendar", icon: CalendarSync },
  { view: "settings", path: "/settings", label: "Global Settings", icon: SlidersHorizontal, adminOnly: true },
];

export function Sidebar({ currentView }: { currentView: View }) {
  const { navigate, stats } = useApp();
  const { user, logout } = useAuth();
  const [showChangePassword, setShowChangePassword] = useState(false);
  // Mobile-only off-canvas drawer state (Phase 16 UI/UX hardening — see the
  // styles.css comment above `.sidebar-mobile-toggle`: below 640px this
  // fixed sidebar has nowhere else to go, so it starts closed and opens as
  // an overlay). Desktop/tablet ignore this entirely — the CSS that reads
  // `.sidebar.open` only exists inside the <=640px media query.
  const [mobileOpen, setMobileOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const firstNavItemRef = useRef<HTMLButtonElement>(null);

  const visibleNavItems = navItems.filter((item) =>
    (!item.adminOnly || user?.role === "admin") && (!item.hideFromTechnician || user?.role !== "technician")
  );

  const closeMobile = () => {
    setMobileOpen(false);
    toggleRef.current?.focus();
  };

  const go = (path: string) => {
    navigate(path);
    setMobileOpen(false);
  };

  // Accessibility review finding: opening the off-canvas drawer previously
  // left keyboard focus wherever it already was (the toggle button) with no
  // way to dismiss except a mouse click on the backdrop — Escape now closes
  // it (returning focus to the toggle, the standard disclosure pattern),
  // and opening it moves focus into the drawer's first nav item so a
  // keyboard user actually lands inside the menu they just opened.
  useEffect(() => {
    if (!mobileOpen) return;
    firstNavItemRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === "Escape") closeMobile(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mobileOpen]);

  return (
    <>
      <button
        ref={toggleRef}
        type="button"
        class="sidebar-mobile-toggle"
        aria-label={mobileOpen ? "Close menu" : "Open menu"}
        aria-expanded={mobileOpen}
        onClick={() => setMobileOpen((o) => !o)}
      >
        {mobileOpen ? <X size={20} /> : <Menu size={20} />}
      </button>
      <div class={`sidebar-backdrop ${mobileOpen ? "open" : ""}`} onClick={closeMobile} />
      <aside class={`sidebar ${mobileOpen ? "open" : ""}`}>
        <div class="sidebar-brand">
          <div class="sidebar-brand-icon">
            <CalendarClock size={16} />
          </div>
          Field Scheduler
        </div>
        <nav class="sidebar-nav">
          <div class="sidebar-section-title">Menu</div>
          {visibleNavItems.map((item, i) => (
            <button
              key={item.view}
              ref={i === 0 ? firstNavItemRef : undefined}
              class={`sidebar-item ${currentView === item.view ? "active" : ""}`}
              onClick={() => go(item.path)}
            >
              <item.icon size={16} />
              <span>{item.view === "dashboard" && user?.role === "technician" ? "My Jobs" : item.label}</span>
              {item.view === "jobs" && stats.jobs > 0 && (
                <span class="sidebar-badge">{stats.jobs}</span>
              )}
              {item.view === "customers" && stats.customers > 0 && (
                <span class="sidebar-badge">{stats.customers}</span>
              )}
              {item.view === "invoices" && stats.invoices_outstanding > 0 && (
                <span class="sidebar-badge">{stats.invoices_outstanding}</span>
              )}
            </button>
          ))}
        </nav>
        <div class="sidebar-footer">
          <div class="sidebar-stat">
            <span class="sidebar-stat-value">{stats.today_jobs}</span>
            <span class="sidebar-stat-label">Today</span>
          </div>
          <div class="sidebar-stat">
            <span class="sidebar-stat-value">{stats.upcoming_jobs}</span>
            <span class="sidebar-stat-label">Upcoming</span>
          </div>
        </div>
        {user && (
          <div class="sidebar-user">
            <div class="sidebar-user-info">
              <div class="sidebar-user-name">{user.name}</div>
              <div class="sidebar-user-role">{ROLE_LABELS[user.role]}</div>
            </div>
            <div class="sidebar-user-actions">
              <button class="btn-icon" title="Change my password" aria-label="Change my password" onClick={() => setShowChangePassword(true)}>
                <KeyRound size={14} />
              </button>
              <button class="btn-icon" title="Log out" aria-label="Log out" onClick={() => logout()}>
                <LogOut size={14} />
              </button>
            </div>
          </div>
        )}
        {showChangePassword && <ChangeMyPassword onClose={() => setShowChangePassword(false)} />}
      </aside>
    </>
  );
}
