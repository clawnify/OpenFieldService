import { useState } from "preact/hooks";
import { useApp } from "../context";
import { useAuth } from "../auth-context";
import { ROLE_LABELS } from "../role-labels";
import { ChangeMyPassword } from "./change-my-password";
import {
  CalendarClock, LayoutDashboard, Briefcase, Users, Wrench, Settings, CalendarDays,
  FileText, Package, UserCog, KeyRound, LogOut, CalendarSync, SlidersHorizontal, BadgeCheck, Target,
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
  { view: "technicians", path: "/technicians", label: "Technicians", icon: Wrench },
  { view: "invoices", path: "/invoices", label: "Invoices", icon: FileText, hideFromTechnician: true },
  { view: "materials", path: "/materials", label: "Materials", icon: Package },
  { view: "services", path: "/services", label: "Service Types", icon: Settings },
  { view: "eligibility", path: "/eligibility", label: "Eligibility Tracker", icon: BadgeCheck, hideFromTechnician: true },
  { view: "users", path: "/users", label: "User Management", icon: UserCog, adminOnly: true },
  { view: "integrations", path: "/integrations", label: "Google Calendar", icon: CalendarSync },
  { view: "settings", path: "/settings", label: "Global Settings", icon: SlidersHorizontal, adminOnly: true },
];

export function Sidebar({ currentView }: { currentView: View }) {
  const { navigate, stats } = useApp();
  const { user, logout } = useAuth();
  const [showChangePassword, setShowChangePassword] = useState(false);

  const visibleNavItems = navItems.filter((item) =>
    (!item.adminOnly || user?.role === "admin") && (!item.hideFromTechnician || user?.role !== "technician")
  );

  return (
    <aside class="sidebar">
      <div class="sidebar-brand">
        <div class="sidebar-brand-icon">
          <CalendarClock size={16} />
        </div>
        Field Scheduler
      </div>
      <nav class="sidebar-nav">
        <div class="sidebar-section-title">Menu</div>
        {visibleNavItems.map((item) => (
          <button
            key={item.view}
            class={`sidebar-item ${currentView === item.view ? "active" : ""}`}
            onClick={() => navigate(item.path)}
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
            <button class="btn-icon" title="Change my password" onClick={() => setShowChangePassword(true)}>
              <KeyRound size={14} />
            </button>
            <button class="btn-icon" title="Log out" onClick={() => logout()}>
              <LogOut size={14} />
            </button>
          </div>
        </div>
      )}
      {showChangePassword && <ChangeMyPassword onClose={() => setShowChangePassword(false)} />}
    </aside>
  );
}
